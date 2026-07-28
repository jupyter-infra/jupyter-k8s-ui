import { describe, test, expect, mock, beforeEach } from 'bun:test';

// The namespace handlers: GET /namespaces (SSAR fan-out → visible snapshot cookie, with a
// fresh-snapshot fast path and ?refresh=1 recompute), GET/PATCH /my-namespace (cheap
// bootstrap read + dumb activeNs write). We assert orchestration, not the primitives.
//
// IMPORTANT: bun's mock.module is process-global, so we do NOT mock ../k8s/access or
// ../k8s/namespace-universe as whole modules — sibling files test those directly and a
// mock here would clobber their registry entry for the entire run. Instead we drive the
// REAL modules through mocked leaf dependencies:
//   - the universe: mock config (dev path + a static list) and call the real
//     initNamespaceUniverse, so getNamespaceUniverse returns exactly what we want;
//   - the SSAR: mock the k8s client's auth API (allow all except names starting "deny").
// Only the preference cookie (this handler's own concern) is module-mocked.

import { randomBytes } from 'crypto';
import { KEY_LENGTH, deriveKeys, sign } from '../crypto';
import type { KeyEntry, KeyMap } from '../middleware/session';
import * as configModule from '../k8s/config';

// We DON'T module-mock ../middleware/namespace-preference: namespace-preference.test.ts tests
// it directly, and bun's mock.module is process-global — a mock here (even a spread superset)
// leaks its readNamespacePreference/buildNamespacePreferenceCookie overrides into that file's
// import under CI's ordering, breaking it. Instead we drive the REAL module: reads via a real
// signed cookie, writes captured by DECODING the real Set-Cookie the handler emits. Only the
// signing-key leaf (secret-watcher) is mocked.
let testKeyMap: KeyMap = { keys: new Map() };

const ssarChecked: string[] = [];
// Injected preference, encoded into a real signed request cookie via injectedPrefCookie().
let prefActive: string | null = null;
let prefVisible: string[] = [];
let prefCheckedUpTo = 0;
let prefUniverseFp = '';
let prefVisibleFresh = true; // controls whether the snapshot reads as fresh vs. expired
let staticNamespaces: string[] = [];
let candidateCap = 3;
let visiblePersistCap = 100;

function keyMapWith(kid = 'k1'): KeyMap {
  const entry: KeyEntry = { kid, key: randomBytes(KEY_LENGTH), addedTime: Date.now() - 120_000 };
  return { keys: new Map([[kid, entry]]) };
}

// Re-assert in beforeEach so a sibling file's mock of these shared modules doesn't win.
function installMocks() {
  mock.module('../k8s/config', () => ({
    ...configModule,
    isLocalDevelopment: () => true, // force the universe poll's dev short-circuit (static list)
    serverConfig: {
      ...configModule.serverConfig,
      namespace: 'default-ns',
      namespaceSelection: { ...configModule.serverConfig.namespaceSelection, candidateCap, visiblePersistCap, staticNamespaces },
    },
  }));
  mock.module('../k8s/client', () => ({
    loadKubeConfigBestEffort: () => null,
    reuseOrCreateAuthClient: async () => ({
      createSelfSubjectAccessReview: async (body: { spec: { resourceAttributes?: { namespace?: string } } }) => {
        const ns = body.spec.resourceAttributes?.namespace ?? '';
        ssarChecked.push(ns);
        return { body: { status: { allowed: !ns.startsWith('deny') } } };
      },
    }),
  }));
  mock.module('../secret-watcher', () => ({ getKeyMap: () => testKeyMap }));
}
installMocks();

const { handleListNamespaces, handleGetMyNamespace, handlePatchMyNamespace, orderCandidates, universeFingerprint } = await import('../handlers/namespaces');
const { initNamespaceUniverse, stopNamespaceUniverse, getNamespaceUniverse } = await import('../k8s/namespace-universe');
const { NS_PREF_COOKIE_NAME } = await import('../middleware/namespace-preference');

interface PrefPayload {
  activeNs: string | null;
  visible: string[];
  checkedUpTo: number;
  universeFp: string;
  visibleExp: number;
}

/** Sign a preference payload into the module's on-wire cookie value (matches verifyAndParse). */
function signPref(p: PrefPayload): string {
  const entry = [...testKeyMap.keys.values()][0];
  const { signingKey } = deriveKeys(entry.key);
  const buf = Buffer.from(JSON.stringify(p), 'utf-8');
  return `${buf.toString('base64url')}.${entry.kid}.${sign(buf, signingKey, entry.kid).toString('base64url')}`;
}

/** The injected read-side preference as a signed Cookie header value (or '' when empty). */
function injectedPrefCookie(): string {
  const hasCache = prefVisible.length > 0 || prefCheckedUpTo > 0 || prefUniverseFp !== '' || prefActive !== null;
  if (!hasCache) return '';
  const now = Math.floor(Date.now() / 1000);
  return signPref({
    activeNs: prefActive,
    visible: prefVisible,
    checkedUpTo: prefCheckedUpTo,
    universeFp: prefUniverseFp,
    visibleExp: prefVisibleFresh ? now + 3600 : now - 60,
  });
}

/** Decode the preference the handler PERSISTED, from the real Set-Cookie on its response. */
function decodePersisted(res: Response): PrefPayload | null {
  const setCookie = res.headers.get('Set-Cookie');
  if (!setCookie) return null;
  const value = setCookie.split(';')[0].slice(NS_PREF_COOKIE_NAME.length + 1);
  const payloadB64 = value.split('.')[0];
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as PrefPayload;
}

// Seed the REAL universe = withDefault(staticNamespaces). Pass the non-default members;
// 'default-ns' is always unioned in by the universe module.
async function setUniverse(...members: string[]) {
  staticNamespaces = members;
  installMocks();
  stopNamespaceUniverse();
  await initNamespaceUniverse(); // dev short-circuit → universe = static list + default
}

// Seed a fresh, matching-fp scan-cache snapshot into the injected preference, as though a
// prior GET /namespaces had scanned [0, checkedUpTo) and found `visible`.
function seedCache(visible: string[], checkedUpTo: number) {
  const ordered = orderCandidates(getNamespaceUniverse());
  prefVisible = visible;
  prefCheckedUpTo = checkedUpTo;
  prefUniverseFp = universeFingerprint(ordered);
  prefVisibleFresh = true;
}

function req(query = ''): Request {
  const cookie = injectedPrefCookie();
  const headers: Record<string, string> = cookie ? { Cookie: `${NS_PREF_COOKIE_NAME}=${cookie}` } : {};
  return new Request(`http://x/api/v1/namespaces${query}`, { headers });
}

/** GET /my-namespace request carrying the injected preference as a signed cookie. */
function myNsReq(): Request {
  const cookie = injectedPrefCookie();
  const headers: Record<string, string> = cookie ? { Cookie: `${NS_PREF_COOKIE_NAME}=${cookie}` } : {};
  return new Request('http://x/api/v1/my-namespace', { headers });
}

function patchReq(namespace: unknown): Request {
  const cookie = injectedPrefCookie();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `${NS_PREF_COOKIE_NAME}=${cookie}`;
  return new Request('http://x/api/v1/my-namespace', { method: 'PATCH', headers, body: JSON.stringify({ namespace }) });
}

beforeEach(() => {
  installMocks();
  testKeyMap = keyMapWith();
  ssarChecked.length = 0;
  prefActive = null;
  prefVisible = [];
  prefCheckedUpTo = 0;
  prefUniverseFp = '';
  prefVisibleFresh = true;
  candidateCap = 3;
  visiblePersistCap = 100;
});

interface ListBody {
  items: Array<{ namespace: string }>;
  default: string | null;
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

describe('handleListNamespaces (paged fan-out → visible snapshot)', () => {
  test('no snapshot, page 0 → SSARs the first page, returns allowed, writes cookie', async () => {
    await setUniverse('team-a', 'deny-b'); // ordered: default-ns, deny-b, team-a (cap 3 → all)
    const res = await handleListNamespaces(req(), 'jwt');
    const body = (await res.json()) as ListBody;
    expect(body.items.map((i) => i.namespace).sort()).toEqual(['default-ns', 'team-a']); // deny-b excluded
    expect(body.default).toBe('default-ns');
    expect(body.offset).toBe(0);
    expect(body.total).toBe(3);
    expect(res.headers.get('Set-Cookie')).toContain('workspace_console_ns=');
    const persisted = decodePersisted(res)!;
    expect(persisted.visible.sort()).toEqual(['default-ns', 'team-a']);
    expect(persisted.checkedUpTo).toBe(3);
  });

  test('fresh, fp-matching snapshot covering the page → served WITHOUT SSAR and WITHOUT rewriting cookie', async () => {
    await setUniverse('team-a');
    seedCache(['default-ns', 'team-a'], 2); // scanned all 2, matching fp
    const res = await handleListNamespaces(req(), 'jwt');
    const body = (await res.json()) as ListBody;
    expect(body.items.map((i) => i.namespace).sort()).toEqual(['default-ns', 'team-a']);
    expect(ssarChecked).toEqual([]); // cache hit: no SSAR
    expect(res.headers.get('Set-Cookie')).toBeNull(); // no re-stamp (preserves revocation window)
  });

  test('fp mismatch (universe changed) → cache discarded, rescans from 0', async () => {
    await setUniverse('team-a');
    prefVisible = ['default-ns', 'team-a'];
    prefCheckedUpTo = 2;
    prefUniverseFp = 'stale-does-not-match';
    prefVisibleFresh = true;
    await handleListNamespaces(req(), 'jwt');
    expect(ssarChecked.length).toBeGreaterThan(0); // rescanned despite a "fresh" snapshot
  });

  test('?refresh=1 forces a recompute even with a valid snapshot', async () => {
    await setUniverse('team-a');
    seedCache(['default-ns', 'team-a'], 2);
    await handleListNamespaces(req('?refresh=1'), 'jwt');
    expect(ssarChecked.length).toBeGreaterThan(0);
  });

  test('expired snapshot → recompute (revocation backstop)', async () => {
    await setUniverse('team-a');
    prefVisible = ['default-ns', 'team-a'];
    prefCheckedUpTo = 2;
    prefUniverseFp = universeFingerprint(orderCandidates(getNamespaceUniverse()));
    prefVisibleFresh = false; // expired
    await handleListNamespaces(req(), 'jwt');
    expect(ssarChecked.length).toBeGreaterThan(0);
  });

  test('page 0 caps the fan-out at the page size and reports hasMore', async () => {
    await setUniverse('a', 'b', 'c', 'd', 'e'); // + default-ns = 6 > page size of 3
    const res = await handleListNamespaces(req(), 'jwt');
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(6);
    expect(body.hasMore).toBe(true);
    expect(ssarChecked.length).toBe(3); // only the first page SSAR'd
  });

  test('offset=3 scans the NEXT slice only (universe-delta), no re-SSAR of page 0', async () => {
    await setUniverse('a', 'b', 'c', 'd', 'e'); // 6 total, page size 3
    // Seed the cache as though page 0 [0,3) was already scanned & all allowed.
    const ordered = orderCandidates(getNamespaceUniverse());
    seedCache(ordered.slice(0, 3), 3);
    const res = await handleListNamespaces(req('?offset=3'), 'jwt');
    const body = (await res.json()) as ListBody;
    expect(body.offset).toBe(3);
    // Only [3,6) is newly scanned — page 0's namespaces are not re-checked.
    expect(ssarChecked.sort()).toEqual(ordered.slice(3, 6).sort());
    expect(body.hasMore).toBe(false); // scanned through the end
    expect(decodePersisted(res)!.checkedUpTo).toBe(6);
  });

  test('persist cap lowers checkedUpTo WITH visible (invariant: visible == allowed in [0, checkedUpTo))', async () => {
    // 5 all-allowed namespaces, page big enough to scan all, but persist only 2.
    candidateCap = 10;
    visiblePersistCap = 2;
    await setUniverse('a', 'b', 'c', 'd'); // ordered: default-ns, a, b, c, d (all allowed)
    const res = await handleListNamespaces(req(), 'jwt');
    const body = (await res.json()) as ListBody;
    // The RESPONSE still returns the full first page (client sees everything scanned)…
    expect(body.items.length).toBe(5);
    // …but the persisted cookie is capped to 2 visible, with checkedUpTo lowered to match:
    // the ordered index just past the 2nd kept visible namespace.
    const persisted = decodePersisted(res)!;
    expect(persisted.visible.length).toBe(2);
    const ordered = orderCandidates(getNamespaceUniverse());
    // checkedUpTo points just past the last kept visible ns → slicing [0, checkedUpTo) and
    // filtering to `visible` reproduces exactly the persisted visible set (the invariant).
    const reconstructed = ordered.slice(0, persisted.checkedUpTo).filter((ns) => persisted.visible.includes(ns));
    expect(reconstructed).toEqual(persisted.visible);
  });
});

describe('handleGetMyNamespace (cheap bootstrap, no SSAR, no cookie)', () => {
  test('a/ no cookie → configured default', async () => {
    prefActive = null;
    const res = handleGetMyNamespace(new Request('http://x/api/v1/my-namespace'));
    expect((await res.json()) as { active: string }).toEqual({ active: 'default-ns' });
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  test('b/ activeNs ∈ fresh visible → activeNs', async () => {
    prefActive = 'team-a';
    prefVisible = ['default-ns', 'team-a'];
    prefVisibleFresh = true;
    const res = handleGetMyNamespace(myNsReq());
    expect((await res.json()) as { active: string }).toEqual({ active: 'team-a' });
  });

  test('c/ activeNs ∉ fresh visible → configured default (stale/revoked)', async () => {
    prefActive = 'team-gone';
    prefVisible = ['default-ns', 'team-a'];
    prefVisibleFresh = true;
    const res = handleGetMyNamespace(myNsReq());
    expect((await res.json()) as { active: string }).toEqual({ active: 'default-ns' });
  });

  test('expired snapshot → trust activeNs (unknown freshness, not a known-bad)', async () => {
    prefActive = 'team-a';
    prefVisible = ['default-ns']; // would exclude team-a, but it's expired → ignored
    prefVisibleFresh = false;
    const res = handleGetMyNamespace(myNsReq());
    expect((await res.json()) as { active: string }).toEqual({ active: 'team-a' });
  });
});

describe('handlePatchMyNamespace (dumb activeNs write, no SSAR)', () => {
  test('writes activeNs and preserves the scan cache; no SSAR', async () => {
    prefActive = 'default-ns';
    prefVisible = ['default-ns', 'team-a'];
    prefCheckedUpTo = 2;
    prefUniverseFp = 'abc';
    const res = await handlePatchMyNamespace(patchReq('team-a'));
    expect((await res.json()) as { active: string }).toEqual({ active: 'team-a' });
    expect(ssarChecked).toEqual([]); // dumb — no SSAR
    // activeNs updated to team-a; the scan-cache fields (visible/checkedUpTo/universeFp) are
    // preserved from the request cookie. visibleExp is re-stamped fresh by the real builder.
    const persisted = decodePersisted(res)!;
    expect(persisted.activeNs).toBe('team-a');
    expect(persisted.visible).toEqual(['default-ns', 'team-a']);
    expect(persisted.checkedUpTo).toBe(2);
    expect(persisted.universeFp).toBe('abc');
    expect(persisted.visibleExp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('rejects a malformed namespace with 400', async () => {
    const res = await handlePatchMyNamespace(patchReq('Bad_NS'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Set-Cookie')).toBeNull(); // no cookie written on rejection
  });

  test('rejects a non-JSON body with 400', async () => {
    const res = await handlePatchMyNamespace(new Request('http://x/api/v1/my-namespace', { method: 'PATCH', body: 'not json' }));
    expect(res.status).toBe(400);
  });
});
