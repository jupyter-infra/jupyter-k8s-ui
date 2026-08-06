import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { V1SelfSubjectAccessReview } from '@kubernetes/client-node';

// The confused-deputy primitive: SSAR MUST be issued with the USER's auth client, and any
// error MUST fail closed (return false). We mock the auth-client factory to (a) record the
// jwt it was built with and (b) return a scripted verdict or throw.
let ssarImpl: (body: V1SelfSubjectAccessReview) => Promise<{ body: unknown }>;
const builtWithJwts: Array<string | null> = [];

// bun's mock.module is process-global and evaluated at import time, so a sibling test
// file's mock of ../k8s/client would otherwise win for this whole run. Re-assert ours in
// beforeEach so it's active during THIS file's tests.
function installClientMock() {
  mock.module('../k8s/client', () => ({
    // Superset (see resolve-namespace.test.ts): satisfy all sibling static imports — incl.
    // reuseOrCreateUserK8sClient (handlers/workspaces.ts), else `bun run test:server` fails
    // on the file that loads after us.
    reuseOrCreateUserK8sClient: async () => ({}),
    reuseOrCreateAuthnClient: async () => ({}),
    loadKubeConfigBestEffort: () => null,
    reuseOrCreateAuthClient: async (jwt: string | null) => {
      builtWithJwts.push(jwt);
      return { createSelfSubjectAccessReview: (body: V1SelfSubjectAccessReview) => ssarImpl(body) };
    },
  }));
}
installClientMock();

const { checkNamespaceAccess, checkNamespaceAccessVerdict, checkNamespacesAccess } = await import('../k8s/access');

function allow(allowed: boolean) {
  return async (body: V1SelfSubjectAccessReview) => ({ body: { ...body, status: { allowed } } });
}

beforeEach(() => {
  installClientMock();
  builtWithJwts.length = 0;
});

describe('checkNamespaceAccess (confused-deputy primitive)', () => {
  test('issues the SSAR with the USER jwt, not the service account', async () => {
    ssarImpl = allow(true);
    await checkNamespaceAccess('alice-jwt', 'team-a');
    expect(builtWithJwts).toEqual(['alice-jwt']);
  });

  test('checks list on workspaces in the requested namespace', async () => {
    let seen: V1SelfSubjectAccessReview | null = null;
    ssarImpl = async (body) => {
      seen = body;
      return { body: { status: { allowed: true } } };
    };
    await checkNamespaceAccess('jwt', 'team-b');
    const attrs = seen!.spec.resourceAttributes!;
    expect(attrs.verb).toBe('list');
    expect(attrs.resource).toBe('workspaces');
    expect(attrs.group).toBe('workspace.jupyter.org');
    expect(attrs.namespace).toBe('team-b');
  });

  test('allowed:true → true; allowed:false → false', async () => {
    ssarImpl = allow(true);
    expect(await checkNamespaceAccess('jwt', 'ns')).toBe(true);
    ssarImpl = allow(false);
    expect(await checkNamespaceAccess('jwt', 'ns')).toBe(false);
  });

  test('SSAR error → false (fail closed, never fail open)', async () => {
    ssarImpl = async () => {
      throw Object.assign(new Error('boom'), { statusCode: 500 });
    };
    expect(await checkNamespaceAccess('jwt', 'ns')).toBe(false);
  });

  test('missing status → false (defensive)', async () => {
    ssarImpl = async () => ({ body: {} });
    expect(await checkNamespaceAccess('jwt', 'ns')).toBe(false);
  });
});

describe('checkNamespaceAccessVerdict (tri-state for the enforcement boundary)', () => {
  test('allowed:true → "allowed"; allowed:false → "denied" (definitive verdicts)', async () => {
    ssarImpl = allow(true);
    expect(await checkNamespaceAccessVerdict('jwt', 'ns')).toBe('allowed');
    ssarImpl = allow(false);
    expect(await checkNamespaceAccessVerdict('jwt', 'ns')).toBe('denied');
  });

  test('SSAR error → "indeterminate" (distinct from a definitive deny; never throws)', async () => {
    // resolveNamespace relies on this to DEFER to the user token instead of 403ing on a blip.
    ssarImpl = async () => {
      throw Object.assign(new Error('boom'), { statusCode: 503 });
    };
    expect(await checkNamespaceAccessVerdict('jwt', 'ns')).toBe('indeterminate');
  });
});

describe('checkNamespacesAccess (bounded fan-out)', () => {
  test('returns a verdict per namespace, preserving deny/allow independently', async () => {
    ssarImpl = async (body) => {
      const ns = body.spec.resourceAttributes!.namespace;
      return { body: { status: { allowed: ns === 'yes' } } };
    };
    const verdicts = await checkNamespacesAccess('jwt', ['yes', 'no', 'yes2']);
    expect(verdicts.get('yes')).toBe(true);
    expect(verdicts.get('no')).toBe(false);
    expect(verdicts.get('yes2')).toBe(false);
  });

  test('empty input → empty map, no SSAR', async () => {
    ssarImpl = allow(true);
    const verdicts = await checkNamespacesAccess('jwt', []);
    expect(verdicts.size).toBe(0);
    expect(builtWithJwts).toEqual([]);
  });

  test('an erroring SSAR fails that namespace closed without sinking the fan-out', async () => {
    // One namespace's SSAR throws; the batch must still return a verdict for EVERY input,
    // with the failed one closed (false) — never a rejected Promise.all or a missing entry.
    ssarImpl = async (body) => {
      const ns = body.spec.resourceAttributes!.namespace;
      if (ns === 'boom') throw Object.assign(new Error('kaboom'), { statusCode: 500 });
      return { body: { status: { allowed: true } } };
    };
    const verdicts = await checkNamespacesAccess('jwt', ['ok-1', 'boom', 'ok-2']);
    expect(verdicts.size).toBe(3);
    expect(verdicts.get('ok-1')).toBe(true);
    expect(verdicts.get('boom')).toBe(false); // fail closed
    expect(verdicts.get('ok-2')).toBe(true); // sibling unaffected
  });

  test('never runs more than SSAR_CONCURRENCY (12) SSARs at once', async () => {
    // Gate every SSAR on a shared latch so they pile up; measure the peak in-flight. With
    // the Math.min(SSAR_CONCURRENCY, …) cap, peak must be exactly 12 for a 30-ns batch;
    // without the cap it would reach 30. release() lets them all drain so the call resolves.
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    ssarImpl = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Once the cap's worth are parked on the gate, let everyone proceed and drain.
      if (inFlight >= 12) release();
      await gate;
      inFlight--;
      return { body: { status: { allowed: true } } };
    };
    const namespaces = Array.from({ length: 30 }, (_, i) => `ns-${i}`);
    const verdicts = await checkNamespacesAccess('jwt', namespaces);
    expect(peak).toBe(12); // bounded: never the full 30
    expect(verdicts.size).toBe(30); // all still resolved
  });
});
