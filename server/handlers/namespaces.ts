import { createHash } from 'crypto';
import { serverConfig, declaredNamespaces } from '../k8s/config';
import { jsonResponse, errorResponse } from '../responses';
import { isValidK8sName } from '../guards';
import { checkNamespaceAccess, checkNamespacesAccess } from '../k8s/access';
import { getNamespaceUniverse } from '../k8s/namespace-universe';
import {
  readNamespacePreference,
  isVisibleExpired,
  freshVisible,
  buildNamespacePreferenceCookie,
  type NamespacePreference,
} from '../middleware/namespace-preference';

// --- Cookie side-effects (documented contract) ---
//
// TWO routes write the `workspace_console_ns` cookie via Set-Cookie:
//   - GET   /namespaces      → refreshes the `visible` snapshot (+ its expiry). A GET with
//                              a cache Set-Cookie side-effect, like the session sliding-
//                              expiration cookie this app already sets on every GET. It
//                              never changes user-intent state (that's activeNs).
//   - PATCH /my-namespace    → writes `activeNs` (the deliberate user switch).
// Each preserves the other's field (field-partitioned writers).
// GET /my-namespace is a PURE READ — it never sets the cookie.

/**
 * GET /api/v1/my-namespace — the cheap bootstrap. NO SSAR, NO Set-Cookie, no cluster calls.
 *
 * Returns the namespace the client should attempt now:
 *   a/ no cookie            → configured default
 *   b/ activeNs ∈ visible   → activeNs (remembered choice still looks usable)
 *   c/ activeNs ∉ visible   → configured default (remembered ns is stale/revoked per our
 *                             own fresh snapshot; don't send the client to a known-bad ns)
 * `active` is an unvalidated hint — if it turns out inaccessible, the list request 403s and
 * the client shows the "Select a namespace" prompt. Case (c) only uses a still-fresh
 * `visible` snapshot; an expired snapshot is treated as "unknown" (→ trust activeNs).
 */
export function handleGetMyNamespace(req: Request): Response {
  const pref = readNamespacePreference(req);
  const active = resolveActive(pref);
  return jsonResponse({ active });
}

function resolveActive(pref: NamespacePreference): string {
  if (!pref.activeNs) return serverConfig.namespace; // case a
  // If we have a FRESH visible snapshot and activeNs isn't in it, it's stale/revoked → default.
  const visible = freshVisible(pref);
  if (visible.length > 0 && !visible.includes(pref.activeNs)) return serverConfig.namespace; // case c
  return pref.activeNs; // case b (or unknown-freshness → trust the preference)
}

/**
 * PATCH /api/v1/my-namespace — persist the user's active-namespace preference.
 *
 * The explicit write path for `activeNs`, replacing the old GET-with-side-effect. This is
 * DUMB by design: activeNs is an unvalidated display hint (the downstream list call under
 * the user's token is the real enforcement), so NO SSAR is performed here — the switcher
 * only ever PATCHes a namespace GET /namespaces already validated into `visible`. Writes
 * activeNs into the signed cookie, PRESERVING `visible`/`visibleExp` (whose sole writer is
 * GET /namespaces). Returns the resolved `{ active }`.
 *
 * This route owns activeNs ONLY; it must not touch the visible-set freshness window. So it
 * writes with `preserveVisibleExp`, keeping the snapshot's original `visibleExp` verbatim —
 * a switch must neither slide the 30-min revocation window forward nor revive an expired
 * snapshot (both would let a revoked namespace stay marked visible indefinitely by
 * switching repeatedly, defeating the backstop). An already-expired snapshot is dropped
 * here so it's never re-persisted as (stale-but-present) state.
 */
export async function handlePatchMyNamespace(req: Request): Promise<Response> {
  let body: { namespace?: unknown };
  try {
    body = (await req.json()) as { namespace?: unknown };
  } catch {
    return errorResponse(400, 'Invalid request body — expected valid JSON');
  }
  if (!isValidK8sName(body.namespace)) {
    return errorResponse(400, 'Invalid namespace');
  }
  const namespace = body.namespace;

  const pref = readNamespacePreference(req);
  // Drop an already-stale snapshot rather than carry it forward (GET /namespaces recomputes
  // it). A fresh snapshot is preserved verbatim, expiry included.
  const expired = isVisibleExpired(pref);
  const nextPref: NamespacePreference = {
    activeNs: namespace,
    visible: expired ? [] : pref.visible,
    checkedUpTo: expired ? 0 : pref.checkedUpTo,
    universeFp: expired ? '' : pref.universeFp,
    visibleExp: expired ? 0 : pref.visibleExp,
  };
  return attachPreferenceCookie(jsonResponse({ active: namespace }), nextPref, { preserveVisibleExp: true });
}

/**
 * GET /api/v1/namespaces/:ns/access — one live SSAR (find-by-name escape hatch). No cookie.
 */
export async function handleGetNamespaceAccess(jwt: string, namespace: string): Promise<Response> {
  const allowed = await checkNamespaceAccess(jwt, namespace);
  return jsonResponse({ namespace, allowed });
}

/**
 * GET /api/v1/namespaces — the switcher list. Sets the `visible` snapshot cookie (cache
 * side-effect, NOT a user-intent change).
 *
 * Serves the still-fresh `visible` snapshot from the cookie when present; otherwise (or on
 * `?refresh=1`) runs the SSAR fan-out over the universe with the user's token, caps at N,
 * and rewrites the snapshot. `?refresh=1` forces a recompute — used by the manual
 * "refresh namespaces" control and the frontend's once-per-403 recovery.
 */
export async function handleListNamespaces(req: Request, jwt: string): Promise<Response> {
  const universe = getNamespaceUniverse();
  const ordered = orderCandidates(universe);
  const fp = universeFingerprint(ordered);

  const params = new URL(req.url).searchParams;
  const forceRefresh = params.get('refresh') === '1';
  const offset = clampOffset(params.get('offset'), ordered.length);
  const pageSize = serverConfig.namespaceSelection.candidateCap;

  const pref = readNamespacePreference(req);
  // The persisted scan cache is usable only if fresh AND computed against the current
  // universe order (fp match). A mismatch means indices shifted → discard and rescan from 0.
  const cacheValid = !forceRefresh && !isVisibleExpired(pref) && pref.universeFp === fp;
  const priorVisible = cacheValid ? pref.visible : [];
  const priorCheckedUpTo = cacheValid ? Math.min(pref.checkedUpTo, ordered.length) : 0;

  // We must have scanned through [0, offset + pageSize) to answer this page. Scan only the
  // NOT-yet-checked slice [priorCheckedUpTo, target) — the universe-delta optimization.
  const target = Math.min(offset + pageSize, ordered.length);
  const toScan = ordered.slice(priorCheckedUpTo, target);
  const verdicts = toScan.length > 0 ? await checkNamespacesAccess(jwt, toScan) : new Map<string, boolean>();
  const newlyVisible = toScan.filter((ns) => verdicts.get(ns) === true);

  // Merged scan result: everything allowed within [0, max(priorCheckedUpTo, target)).
  const scannedVisible = priorCheckedUpTo >= target ? priorVisible : [...priorVisible, ...newlyVisible];
  const checkedUpTo = Math.max(priorCheckedUpTo, target);

  // The page the client asked for: allowed namespaces at ordered positions [offset, target).
  // scannedVisible is in ordered order, so slice it by counting how many precede `offset`.
  const pageItems = sliceVisibleByOrder(ordered, scannedVisible, offset, target);

  const body = {
    items: pageItems.map((namespace) => ({ namespace })),
    default: scannedVisible.includes(serverConfig.namespace) ? serverConfig.namespace : null,
    offset,
    limit: pageSize,
    total: ordered.length,
    hasMore: checkedUpTo < ordered.length,
  };

  // Persist only up to the visible-persist cap; pages past it are served live but not
  // stored (bounding cookie size). Truncate BOTH visible and checkedUpTo together so the
  // invariant (visible == allowed within ordered[0, checkedUpTo)) holds.
  const persistCap = serverConfig.namespaceSelection.visiblePersistCap;
  const { visible: persistVisible, checkedUpTo: persistCheckedUpTo } = capPersisted(ordered, scannedVisible, checkedUpTo, persistCap);

  // Only write the cookie when the persisted cache actually changed. A pure cache hit (fp
  // already matched, nothing newly scanned) must NOT re-stamp visibleExp — that would slide
  // the 30-min revocation window forward on every switcher-open and defeat the backstop.
  const cacheChanged = !cacheValid || newlyVisible.length > 0 || toScan.length > 0;
  const response = jsonResponse(body);
  if (!cacheChanged) return response;

  const nextPref: NamespacePreference = {
    activeNs: pref.activeNs,
    visible: persistVisible,
    checkedUpTo: persistCheckedUpTo,
    universeFp: fp,
    visibleExp: 0,
  };
  return attachPreferenceCookie(response, nextPref);
}

/** Parse + clamp the offset query param to [0, length]. Invalid → 0. */
function clampOffset(raw: string | null, length: number): number {
  const n = raw ? parseInt(raw, 10) : 0;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, length);
}

/**
 * A stable fingerprint of the ordered universe. Changes iff the set OR its order changes,
 * which is exactly when a persisted `checkedUpTo` index would point at different
 * namespaces and must be invalidated. Length-prefixed to avoid delimiter ambiguity.
 */
export function universeFingerprint(ordered: string[]): string {
  return createHash('sha256')
    .update(`${ordered.length}\n${ordered.join('\n')}`)
    .digest('base64url')
    .slice(0, 16);
}

/** The allowed namespaces at ordered positions [offset, target), preserving ordered order. */
function sliceVisibleByOrder(ordered: string[], visible: string[], offset: number, target: number): string[] {
  const visibleSet = new Set(visible);
  return ordered.slice(offset, target).filter((ns) => visibleSet.has(ns));
}

/**
 * Cap the persisted scan cache at `persistCap` VISIBLE entries. Keeps the first
 * `persistCap` allowed namespaces and lowers `checkedUpTo` to the ordered index just past
 * the last kept one — preserving the invariant that `visible` is exactly the allowed
 * entries within ordered[0, checkedUpTo). Under the cap, returns the input unchanged.
 */
function capPersisted(ordered: string[], visible: string[], checkedUpTo: number, persistCap: number): { visible: string[]; checkedUpTo: number } {
  if (visible.length <= persistCap) return { visible, checkedUpTo };
  const keptVisible = visible.slice(0, persistCap);
  const lastKept = keptVisible[keptVisible.length - 1];
  // checkedUpTo = index just past the last kept visible namespace in the ordered universe.
  const newCheckedUpTo = ordered.indexOf(lastKept) + 1;
  return { visible: keptVisible, checkedUpTo: newCheckedUpTo };
}

/**
 * Candidate ordering (a stable total order over the universe):
 *   1. declared namespaces (default first, then WORKSPACE_NAMESPACES) — in declared order,
 *      restricted to those actually present in the universe;
 *   2. everything else in the universe, alphabetical.
 * Declared entries pin to stable front positions (config-derived → drift-proof); only the
 * alphabetical tail shifts when the universe changes. Keeps the namespaces the admin cared
 * about at the front of the cap so they never truncate; tail discovery is via find-by-name.
 */
export function orderCandidates(universe: string[]): string[] {
  const universeSet = new Set(universe);
  const declared = declaredNamespaces(serverConfig.namespace, serverConfig.namespaceSelection.staticNamespaces).filter((ns) => universeSet.has(ns));
  const declaredSet = new Set(declared);
  const rest = universe.filter((ns) => !declaredSet.has(ns)).sort();
  return [...declared, ...rest];
}

/** Attach the re-signed preference cookie, if a signing key is available. */
function attachPreferenceCookie(response: Response, pref: NamespacePreference, opts: { preserveVisibleExp?: boolean } = {}): Response {
  const cookie = buildNamespacePreferenceCookie(pref, opts);
  if (!cookie) return response; // signing-key gap: serve correctly, just don't persist
  const withCookie = new Response(response.body, response);
  withCookie.headers.append('Set-Cookie', cookie);
  return withCookie;
}
