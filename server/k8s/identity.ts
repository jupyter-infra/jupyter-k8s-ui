// The authoritative K8s username, learned from the API server itself.
//
// The OIDC claim the browser sees (preferred_username || sub, e.g. `JGuinegagne`) is NOT
// the identity the Kubernetes API server enforces against. The API server prepends its
// configured username-prefix, producing `<prefix>:<claim>` (e.g. `github:JGuinegagne`), and
// it is THAT string the operator stamps into the `created-by` annotation. A SelfSubjectReview
// (authentication.k8s.io/v1) issued with the user's token echoes back exactly this
// server-constructed username in status.userInfo.username — no provider-shaped guessing.
//
// DISPLAY-ONLY: this feeds the "is this my workspace" ownership hint (which gates the
// Advanced-Edit affordance). It is never the security boundary — every list/get/mutate runs
// under the user's own token and 403s at the API server regardless. So on any error we
// return null (the caller treats an unknown identity as "matches nothing"), never throwing.

import { reuseOrCreateAuthnClient } from './client';
import { log } from '../logger';

interface SelfSubjectReviewStatus {
  status?: { userInfo?: { username?: string } };
}

/**
 * Resolve the authoritative Kubernetes username for the caller via SelfSubjectReview.
 * Returns null on any error or when the API server reports no username (never throws) —
 * this is a display hint, not enforcement.
 */
export async function resolveK8sUsername(jwt: string | null): Promise<string | null> {
  try {
    const authnClient = await reuseOrCreateAuthnClient(jwt);
    const res = await authnClient.createSelfSubjectReview({
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'SelfSubjectReview',
    });
    const username = (res.body as SelfSubjectReviewStatus)?.status?.userInfo?.username;
    return username || null;
  } catch (error) {
    log('warn', `SelfSubjectReview failed — K8s username unresolved: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
