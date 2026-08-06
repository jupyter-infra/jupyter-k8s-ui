import { describe, test, expect, mock, beforeEach } from 'bun:test';

// resolveK8sUsername learns the authoritative K8s username via SelfSubjectReview, issued with
// the USER's authn client. Its load-bearing contract is fail-open-to-null: on ANY error it
// MUST return null (never throw) so /me degrades to "ownership matches nothing" rather than
// breaking the whole app load. We mock the authn-client factory to (a) record the jwt it was
// built with and (b) return a scripted userInfo or throw.
let ssrImpl: () => Promise<{ body: unknown }>;
const builtWithJwts: Array<string | null> = [];

// bun's mock.module is process-global and evaluated at import time, so a sibling test file's
// mock of ../k8s/client would otherwise win for this whole run. Re-assert ours in beforeEach.
function installClientMock() {
  mock.module('../k8s/client', () => ({
    // Superset (see access.test.ts): satisfy all sibling static imports so `bun run
    // test:server` doesn't fail on a file that loads after us.
    reuseOrCreateUserK8sClient: async () => ({}),
    reuseOrCreateAuthClient: async () => ({ createSelfSubjectAccessReview: async () => ({ body: { status: { allowed: true } } }) }),
    loadKubeConfigBestEffort: () => null,
    reuseOrCreateAuthnClient: async (jwt: string | null) => {
      builtWithJwts.push(jwt);
      return { createSelfSubjectReview: () => ssrImpl() };
    },
  }));
}
installClientMock();

const { resolveK8sUsername } = await import('../k8s/identity');

beforeEach(() => {
  installClientMock();
  builtWithJwts.length = 0;
});

describe('resolveK8sUsername', () => {
  test('positive: returns the authoritative username from status.userInfo, issued with the user jwt', async () => {
    ssrImpl = async () => ({ body: { status: { userInfo: { username: 'github:alice' } } } });
    expect(await resolveK8sUsername('alice-jwt')).toBe('github:alice');
    // The review must reflect the CALLER's identity — built with the user jwt, never the SA.
    expect(builtWithJwts).toEqual(['alice-jwt']);
  });

  test('negative: a thrown SelfSubjectReview resolves to null (fail-open, never rejects)', async () => {
    ssrImpl = async () => {
      throw new Error('boom');
    };
    expect(await resolveK8sUsername('jwt')).toBeNull();
  });

  test('empty/absent userInfo.username coerces to null (not the empty string)', async () => {
    ssrImpl = async () => ({ body: { status: { userInfo: {} } } });
    expect(await resolveK8sUsername('jwt')).toBeNull();
  });
});
