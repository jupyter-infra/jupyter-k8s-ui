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
    // Superset: satisfy all sibling static imports — incl. reuseOrCreateUserK8sClient
    // (handlers/workspaces.ts), else `bun run test:server` fails on the file loading after us.
    reuseOrCreateUserK8sClient: async () => ({}),
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
  boundUser: string;
}

/** Sign a preference payload into the module's on-wire cookie value (matches verifyAndParse). */
function signPref(p: PrefPayload): string {
  const entry = [...testKeyMap.keys.values()][0];
  const { signingKey } = deriveKeys(entry.key);
  const buf = Buffer.from(JSON.stringify(p), 'utf-8');
  return `${buf.toString('base64url')}.${entry.kid}.${sign(buf, signingKey, entry.kid).toString('base64url')}`;
}

/**
 * The injected read-side preference as a signed Cookie header value (or '' when empty).
 * boundUser is '' to match the handlers' test jwt ('jwt' is unparseable → userTag === '');
 * readNamespacePreference's identity gate compares boundUser against userTag(jwt).
 */
function injectedPrefCookie(): string {
  const hasCache = prefVisible.length > 0 || prefCheckedUpTo > 0 || prefUniverseFp !== '' || prefActive !== null;
  if (!hasCache) return '';
  const now = Math.floor(Date.now() / 1000);
  return signPref({
    boundUser: '',
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
    const res = handleGetMyNamespace(new Request('http://x/api/v1/my-namespace'), 'jwt');
    expect((await res.json()) as { active: string }).toEqual({ active: 'default-ns' });
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  test('activeNs ∈ fresh visible → activeNs', async () => {
    await setUniverse('team-a');
    prefActive = 'team-a';
    seedCache(['default-ns', 'team-a'], 2);
    const res = handleGetMyNamespace(myNsReq(), 'jwt');
    expect((await res.json()) as { active: string }).toEqual({ active: 'team-a' });
  });

  test('activeNs SCANNED & DENIED (within prefix, fp match, not visible) → configured default', async () => {
    // team-denied is in the ordered universe within checkedUpTo but absent from visible: the
    // fresh snapshot definitively denied it → don't send the client to a known-bad ns.
    await setUniverse('team-a', 'team-denied');
    prefActive = 'team-denied';
    seedCache(['default-ns', 'team-a'], 3); // scanned all 3, team-denied excluded (denied)
    const res = handleGetMyNamespace(myNsReq(), 'jwt');
    expect((await res.json()) as { active: string }).toEqual({ active: 'default-ns' });
  });

  test('activeNs adopted via find-by-name (NOT in the universe) → trust activeNs, do NOT bounce', async () => {
    // The regression Andrii flagged: a find-by-name namespace was never SSAR'd into `visible`
    // (it's not even in the labeled universe). "Absent from visible" must NOT be read as
    // "denied" — bouncing it to default on every base-URL load would strand the user.
    await setUniverse('team-a');
    prefActive = 'via-find-by-name';
    seedCache(['default-ns', 'team-a'], 2); // fresh, fp-matching, fully scanned — but no team-x
    const res = handleGetMyNamespace(myNsReq(), 'jwt');
    expect((await res.json()) as { active: string }).toEqual({ active: 'via-find-by-name' });
  });

  test('activeNs past the scanned prefix (checkedUpTo) → trust activeNs (never reached)', async () => {
    await setUniverse('team-a', 'team-b', 'team-c'); // ordered: default-ns, team-a, team-b, team-c
    prefActive = 'team-c';
    seedCache(['default-ns', 'team-a'], 2); // only [0,2) scanned; team-c at index 3 unscanned
    const res = handleGetMyNamespace(myNsReq(), 'jwt');
    expect((await res.json()) as { active: string }).toEqual({ active: 'team-c' });
  });

  test('fp mismatch (universe reordered) → checkedUpTo meaningless → trust activeNs', async () => {
    await setUniverse('team-a', 'team-denied');
    prefActive = 'team-denied';
    prefVisible = ['default-ns', 'team-a'];
    prefCheckedUpTo = 3;
    prefUniverseFp = 'stale-fp-does-not-match';
    prefVisibleFresh = true;
    const res = handleGetMyNamespace(myNsReq(), 'jwt');
    expect((await res.json()) as { active: string }).toEqual({ active: 'team-denied' });
  });

  test('expired snapshot → trust activeNs (unknown freshness, not a known-bad)', async () => {
    await setUniverse('team-a');
    prefActive = 'team-denied';
    prefVisible = ['default-ns', 'team-a']; // would exclude team-denied, but it's expired → ignored
    prefCheckedUpTo = 3;
    prefUniverseFp = universeFingerprint(orderCandidates(getNamespaceUniverse()));
    prefVisibleFresh = false;
    const res = handleGetMyNamespace(myNsReq(), 'jwt');
    expect((await res.json()) as { active: string }).toEqual({ active: 'team-denied' });
  });
});

describe('handlePatchMyNamespace (dumb activeNs write, no SSAR)', () => {
  test('writes activeNs and preserves a FRESH scan cache verbatim (incl. visibleExp); no SSAR', async () => {
    prefActive = 'default-ns';
    prefVisible = ['default-ns', 'team-a'];
    prefCheckedUpTo = 2;
    prefUniverseFp = 'abc';
    prefVisibleFresh = true;
    const res = await handlePatchMyNamespace(patchReq('team-a'), 'jwt');
    expect((await res.json()) as { active: string }).toEqual({ active: 'team-a' });
    expect(ssarChecked).toEqual([]); // dumb — no SSAR
    // activeNs updated to team-a; the scan-cache fields (visible/checkedUpTo/universeFp) are
    // preserved from the request cookie. visibleExp is PRESERVED (not re-stamped) so a switch
    // can't slide the 30-min revocation window forward — it stays in the future here because
    // injectedPrefCookie stamped a fresh snapshot (now + 3600).
    const persisted = decodePersisted(res)!;
    expect(persisted.activeNs).toBe('team-a');
    expect(persisted.visible).toEqual(['default-ns', 'team-a']);
    expect(persisted.checkedUpTo).toBe(2);
    expect(persisted.universeFp).toBe('abc');
    expect(persisted.visibleExp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('an EXPIRED snapshot is dropped, not revived: a switch must not re-stamp a stale visible set', async () => {
    // The revocation-backstop regression: buildNamespacePreferenceCookie used to re-stamp
    // visibleExp unconditionally, so repeated switches kept a revoked ns marked fresh-visible
    // forever. Now PATCH drops an expired snapshot and preserves the (0) expiry.
    prefActive = 'default-ns';
    prefVisible = ['default-ns', 'team-a'];
    prefCheckedUpTo = 2;
    prefUniverseFp = 'abc';
    prefVisibleFresh = false; // expired snapshot on the request cookie
    const res = await handlePatchMyNamespace(patchReq('team-a'), 'jwt');
    const persisted = decodePersisted(res)!;
    expect(persisted.activeNs).toBe('team-a'); // the preference still updates
    // …but the stale scan cache is discarded together, and NOT re-stamped fresh.
    expect(persisted.visible).toEqual([]);
    expect(persisted.checkedUpTo).toBe(0);
    expect(persisted.universeFp).toBe('');
    expect(persisted.visibleExp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  test('rejects a malformed namespace with 400', async () => {
    const res = await handlePatchMyNamespace(patchReq('Bad_NS'), 'jwt');
    expect(res.status).toBe(400);
    expect(res.headers.get('Set-Cookie')).toBeNull(); // no cookie written on rejection
  });

  test('rejects a non-JSON body with 400', async () => {
    const res = await handlePatchMyNamespace(new Request('http://x/api/v1/my-namespace', { method: 'PATCH', body: 'not json' }), 'jwt');
    expect(res.status).toBe(400);
  });
});
