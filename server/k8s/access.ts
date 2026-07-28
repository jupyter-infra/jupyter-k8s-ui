// The confused-deputy guard, in one place.
//
// A namespace is visible to a user IF AND ONLY IF a SelfSubjectAccessReview issued with
// THAT USER'S token returns allowed:true for `list` on workspaces in that namespace.
// This is the ONLY authority for namespace visibility — the SA candidate list merely
// enumerates names to check; it never grants visibility. Issuing the SSAR with the SA
// token would check the SA's (broad) access and every namespace would pass: precisely
// the confused deputy we guard against.
//
// SECURITY MODEL: the user's K8s token is the real enforcement. Every list/get/mutate
// runs under that token and 403s at the API server regardless of what this check says.
// So this SSAR is only a DISPLAY hint (don't offer a namespace she can't use); a stale,
// cached, or errored verdict is never a security hole. On error we fail CLOSED (hide the
// namespace) purely to keep the display honest.

import { reuseOrCreateAuthClient } from './client';
import { CRD_GROUP, WORKSPACE_PLURAL } from './constants';
import { log } from '../logger';

// verb=list mirrors the landing action (the workspace LIST loads first on switch). A
// namespace-scoped RoleBinding that grants list almost always grants get/watch too, so
// one verb is a faithful "is this namespace usable" gate without doubling the fan-out.
const VISIBILITY_VERB = 'list';

/** Bounded-concurrency ceiling for the SSAR fan-out — never an unbounded Promise.all. */
const SSAR_CONCURRENCY = 12;

interface SsarStatus {
  status?: { allowed?: boolean };
}

/**
 * One SelfSubjectAccessReview with the user's token: may this user `list` workspaces in
 * `namespace`? Fails CLOSED (returns false) on any error — see the security note above.
 */
export async function checkNamespaceAccess(jwt: string | null, namespace: string): Promise<boolean> {
  try {
    const authClient = await reuseOrCreateAuthClient(jwt);
    const res = await authClient.createSelfSubjectAccessReview({
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectAccessReview',
      spec: {
        resourceAttributes: {
          group: CRD_GROUP,
          resource: WORKSPACE_PLURAL,
          verb: VISIBILITY_VERB,
          namespace,
        },
      },
    });
    const allowed = (res.body as SsarStatus)?.status?.allowed === true;
    return allowed;
  } catch (error) {
    // Fail closed: an SSAR we can't run means "not visible", never "visible".
    log('warn', `SSAR failed for namespace ${namespace} — treating as not visible: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Run checkNamespaceAccess over many namespaces through a bounded concurrency limiter,
 * returning a ns -> allowed map. Order of `namespaces` is preserved by the caller's cap
 * ordering; this only bounds how many SSARs are in flight at once. Each verdict fails
 * CLOSED independently: one namespace's failure never rejects the fan-out or discards the
 * verdicts other workers already computed.
 */
export async function checkNamespacesAccess(jwt: string | null, namespaces: string[]): Promise<Map<string, boolean>> {
  const verdicts = new Map<string, boolean>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < namespaces.length) {
      const ns = namespaces[cursor++];
      try {
        verdicts.set(ns, await checkNamespaceAccess(jwt, ns));
      } catch {
        // Defensive backstop. checkNamespaceAccess already fails closed and shouldn't
        // throw, but if a future change lets an error escape it, a single rejected worker
        // would reject Promise.all and drop the ENTIRE page's verdicts. Fail this one
        // namespace closed instead so a lone bad namespace can never sink the fan-out.
        verdicts.set(ns, false);
      }
    }
  }

  const workers = Array.from({ length: Math.min(SSAR_CONCURRENCY, namespaces.length) }, () => worker());
  await Promise.all(workers);
  return verdicts;
}
