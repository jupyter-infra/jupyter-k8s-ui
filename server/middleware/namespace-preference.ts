// The namespace preference cookie (`workspace_console_ns`).
//
// Carries two per-user values with DIFFERENT lifecycles in one signed blob:
//   - activeNs: the story-#3 last-used namespace. A durable UI preference — persists for
//     the cookie's full Max-Age so "bookmark the base URL, come back to your namespace"
//     survives long idle gaps. NOT access-controlled: it's an unvalidated hint (the
//     downstream list call under the user's token is the real enforcement).
//   - visible + visibleExp: the RBAC-visible namespace set (what the switcher renders),
//     computed by GET /namespaces' SSAR fan-out, stamped with a SHORT expiry. This is a
//     freshness snapshot, not a preference — on expiry it's discarded and recomputed so a
//     REVOKED namespace stops showing (the revocation backstop). visibleExp bounds only
//     `visible`; activeNs is unaffected by it.
//
// Signed (not encrypted): `visible` is an authz-shaped artifact, so an unsigned/tamperable
// cookie could let a client forge membership (the confused deputy via the cookie). Signing
// is MANDATORY. Even a forged entry that slipped verification is harmless — the real K8s
// calls run under the user's own token and 403 regardless; this cookie is an optimization
// over enforcement, never the enforcement. The expiry lives INSIDE the signed payload so
// the client can't extend it via Max-Age.
//
// Reuses crypto.sign/verify + the rotating keymap (server/secret-watcher.ts) — no new key
// material. Separate from the session cookie: survives session rotation.
//
// SIGNING-KEY DEPENDENCY: this cookie needs a signing key, which comes from the same keymap
// the session layer populates. In dev mode keys are always minted (server/index.ts inits
// the watcher regardless of session.enabled), so the cookie works in sessions-off dev/E2E/
// serve-host. In PROD with SESSION_ENABLED=false the keymap is empty, so the cookie is never
// written (buildNamespacePreferenceCookie returns null) and the app runs cookieless —
// activeNs memory and the visible-snapshot cache are inert, falling back to URL/default.
// Whether prod sessions-off should be supported at all is an open question (tracked
// separately); today it degrades gracefully to cookieless.

import { createHash } from 'crypto';
import { deriveKeys, sign, verify } from '../crypto';
import { getKeyMap } from '../secret-watcher';
import { getSigningKey, parseCookieValue, type KeyMap } from './session';
import { serverConfig } from '../k8s/config';
import { decodeJWTPayload } from '../jwt';
import { log } from '../logger';

export const NS_PREF_COOKIE_NAME = 'workspace_console_ns';
const NS_PREF_COOKIE_PATH = '/api/';
// How long the cookie is stored client-side (the durable activeNs preference lives this
// long). Independent of the visible-set freshness window below.
const NS_PREF_COOKIE_MAX_AGE_SECS = 30 * 24 * 60 * 60; // 30 days
// Revocation-staleness bound for the `visible` set ONLY (NOT tied to the per-JWT client
// cache TTL — that coupling is historical). On expiry the visible set is discarded and
// recomputed by the next GET /namespaces, so a revoked namespace stops showing within this
// window. A stale entry is never a security hole (the list call 403s under the user's
// token); it's just a dead switcher affordance until recompute.
const NS_PREF_VISIBLE_TTL_SECS = 30 * 60; // 30 minutes
// Keep well under the 4KB cookie limit. Hard eviction backstop.
const NS_PREF_MAX_BYTES = 3800;

export interface NamespacePreference {
  activeNs: string | null;
  // RBAC-visible namespace names, in ordered-universe order. Governed by visibleExp.
  // INVARIANT: `visible` == the allowed entries within ordered[0, checkedUpTo). Every
  // writer must preserve this (a partial persist must lower checkedUpTo to match).
  visible: string[];
  // High-water mark: indices [0, checkedUpTo) of the ordered universe have been SSAR'd.
  // The pagination cursor + the "fully scanned?" signal (checkedUpTo >= universe length).
  checkedUpTo: number;
  // Fingerprint of the ordered universe `visible`/`checkedUpTo` were computed against. On
  // mismatch (universe changed → indices shifted) the scan cache is reset, so a stale
  // index can never mark an unscanned namespace as "checked".
  universeFp: string;
  // Unix seconds; when passed, the scan cache (visible/checkedUpTo) is stale and must be
  // discarded + recomputed. Does NOT affect activeNs.
  visibleExp: number;
  // A hash of the user (JWT `sub`) this cookie was minted for — NOT the Kubernetes user UID;
  // it's an opaque tag we compute (see userTag). Binds the WHOLE payload — activeNs and the
  // visible snapshot alike — to one identity, so on a shared browser profile user B never
  // inherits user A's preference or RBAC snapshot. Read-side compares it against the current
  // request's user and treats a mismatch as a missing cookie (fail-closed: default +
  // recompute). Managed internally by read/build; handlers pass plain NamespacePreference
  // objects and never set it.
  boundUser: string;
  // The authoritative Kubernetes username (<username-prefix>:<claim>) the API server enforces
  // against — the string the operator stamps into `created-by`. Read-through cache: GET /me
  // resolves it ONCE via SelfSubjectReview then mints it here, so subsequent loads (on ANY
  // replica — the cookie travels with the request) skip the cluster call. Stable per identity,
  // so it carries NO freshness expiry (unlike `visible`); it lives for the cookie's Max-Age
  // and is re-bound by `boundUser`. null when not yet resolved. Display-only, like the rest of
  // this cookie — never the security boundary. Every writer must preserve it.
  k8sUser: string | null;
}

const EMPTY_PREFERENCE: NamespacePreference = { activeNs: null, visible: [], checkedUpTo: 0, universeFp: '', visibleExp: 0, boundUser: '', k8sUser: null };

/**
 * A stable, non-reversible tag for the JWT's owner. Hashes the `sub` claim (stable OIDC
 * subject — unlike preferred_username, it doesn't change) so the cookie carries no raw
 * identity. '' when the JWT is absent/malformed or carries no `sub` — an empty tag never
 * matches a non-empty one (readNamespacePreference guards this), so a tokenless request
 * can't ride a bound cookie.
 */
export function userTag(jwt: string | null): string {
  if (!jwt) return '';
  const payload = decodeJWTPayload(jwt);
  const sub = payload && typeof payload.sub === 'string' ? payload.sub : '';
  if (!sub) return '';
  return createHash('sha256').update(sub).digest('base64url').slice(0, 16);
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

/**
 * Parse + verify the preference cookie from a request, for the user identified by `jwt`.
 * Returns an empty preference for a missing / malformed / tampered / unverifiable cookie
 * OR one minted for a DIFFERENT user (fail-closed — never trust an unverifiable or
 * cross-user set). Callers should treat `visible` as stale when `isVisibleExpired()`.
 */
export function readNamespacePreference(req: Request, jwt: string | null): NamespacePreference {
  const cookieHeader = req.headers.get('Cookie');
  if (!cookieHeader) return { ...EMPTY_PREFERENCE };

  const cookieValue = parseCookieValue(cookieHeader, NS_PREF_COOKIE_NAME);
  if (!cookieValue) return { ...EMPTY_PREFERENCE };

  const parsed = verifyAndParse(cookieValue, getKeyMap());
  if (!parsed) return { ...EMPTY_PREFERENCE };

  // Identity gate: a cookie is only for the user it was minted for. Signed `boundUser` can't
  // be forged, but a genuine cookie can be REUSED by another user on a shared browser profile
  // — so bind by comparing tags. Mismatch → treat as absent (default + recompute under B).
  if (parsed.boundUser !== userTag(jwt)) return { ...EMPTY_PREFERENCE };
  return parsed;
}

function verifyAndParse(cookieValue: string, keyMap: KeyMap): NamespacePreference | null {
  try {
    const parts = cookieValue.split('.');
    if (parts.length !== 3) return null;
    const [payloadB64, kid, signatureB64] = parts;
    const payloadBuf = base64urlDecode(payloadB64);
    const signature = base64urlDecode(signatureB64);

    const entry = keyMap.keys.get(kid);
    const candidates = entry ? [entry] : [...keyMap.keys.values()];
    for (const e of candidates) {
      const { signingKey } = deriveKeys(e.key);
      if (verify(payloadBuf, signature, signingKey, kid)) {
        const payload = JSON.parse(payloadBuf.toString('utf-8')) as NamespacePreference;
        if (typeof payload.visibleExp !== 'number' || !Array.isArray(payload.visible)) return null;
        if (typeof payload.checkedUpTo !== 'number' || typeof payload.universeFp !== 'string') return null;
        if (typeof payload.boundUser !== 'string') return null;
        // k8sUser was added later; a cookie minted before it is otherwise valid. Normalize a
        // missing/ill-typed value to null (unresolved) rather than rejecting the whole cookie.
        payload.k8sUser = typeof payload.k8sUser === 'string' ? payload.k8sUser : null;
        return payload;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True when the visible-set snapshot has expired — `visible` must be discarded and
 * recomputed. Does NOT bear on `activeNs`, which persists for the cookie's Max-Age.
 */
export function isVisibleExpired(pref: NamespacePreference): boolean {
  const now = Math.floor(Date.now() / 1000);
  return pref.visibleExp <= now;
}

/** The still-fresh visible set, or [] if expired. Convenience for read-side callers. */
export function freshVisible(pref: NamespacePreference): string[] {
  return isVisibleExpired(pref) ? [] : pref.visible;
}

/**
 * Serialize + sign a preference into a Set-Cookie header value. Returns null when no
 * signing key is available (startup / post-rotation cooloff) — the caller then serves the
 * request correctly but simply doesn't persist the cookie (bounded, known degradation,
 * the same window createSessionCookie degrades in). Also returns null (after eviction) if
 * the payload can't be squeezed under the size cap.
 *
 * By default `visibleExp` is stamped fresh (now + the visible TTL) — correct for the
 * GET /namespaces writer, which has just re-verified the set via SSAR. Pass
 * `preserveVisibleExp` for an activeNs-only write (PATCH /my-namespace): it keeps the
 * caller-supplied `visibleExp` verbatim, so a namespace switch neither slides the 30-min
 * revocation window forward nor revives an already-expired snapshot. `activeNs` carries no
 * in-payload expiry — it lives for the cookie's Max-Age.
 */
export function buildNamespacePreferenceCookie(pref: NamespacePreference, jwt: string | null, opts: { preserveVisibleExp?: boolean } = {}): string | null {
  const signingEntry = getSigningKey(getKeyMap(), serverConfig.session.newKeyUseDelaySecs);
  if (!signingEntry) {
    log('debug', 'No signing key available — skipping namespace preference cookie');
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const payload: NamespacePreference = {
    activeNs: pref.activeNs,
    visible: pref.visible,
    checkedUpTo: pref.checkedUpTo,
    universeFp: pref.universeFp,
    visibleExp: opts.preserveVisibleExp ? pref.visibleExp : now + NS_PREF_VISIBLE_TTL_SECS,
    // Bind to the writing user, always freshly derived (never carried from the input pref).
    boundUser: userTag(jwt),
    k8sUser: pref.k8sUser,
  };

  const { signingKey } = deriveKeys(signingEntry.key);
  let cookieValue = encodeAndSign(payload, signingKey, signingEntry.kid);

  // Size pressure: reset the whole scan cache (recomputable via GET /namespaces) before
  // giving up. We must drop `visible` and `checkedUpTo`/`universeFp` TOGETHER — keeping a
  // high checkedUpTo with an emptied `visible` would falsely claim those indices were
  // scanned-and-denied, hiding accessible namespaces. activeNs is tiny and always kept.
  if (cookieValue.length > NS_PREF_MAX_BYTES) {
    payload.visible = [];
    payload.checkedUpTo = 0;
    payload.universeFp = '';
    cookieValue = encodeAndSign(payload, signingKey, signingEntry.kid);
  }
  if (cookieValue.length > NS_PREF_MAX_BYTES) {
    log('warn', `Namespace preference cookie still over ${NS_PREF_MAX_BYTES}B after eviction — not setting`);
    return null;
  }

  const secure = process.env.NODE_ENV !== 'development';
  const attrs = [`${NS_PREF_COOKIE_NAME}=${cookieValue}`, `Path=${NS_PREF_COOKIE_PATH}`, `Max-Age=${NS_PREF_COOKIE_MAX_AGE_SECS}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function encodeAndSign(payload: NamespacePreference, signingKey: Buffer, kid: string): string {
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf-8');
  const signature = sign(payloadBuf, signingKey, kid);
  return `${base64urlEncode(payloadBuf)}.${kid}.${base64urlEncode(signature)}`;
}
