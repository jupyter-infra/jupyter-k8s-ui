// Per-request namespace resolution for the namespaced handlers.
//
// `?namespace=` is user-supplied. It is validated here before any K8s call. But note the
// SECURITY MODEL: the user's token is the real enforcement (every call 403s at the API
// server if she lacks access), so this validation is a DISPLAY/uniformity nicety — a
// clean explicit 403 instead of relying on the downstream one — not the security gate.
//
// Resolution order (uniform across GET and mutations):
//   - ?namespace= absent                          -> configured default (no SSAR)
//   - == configured default                       -> use it (NO SSAR — back-compat exempt:
//        every request today hits serverConfig.namespace with no pre-check, token-enforced)
//   - non-default, in the fresh `visible` snapshot -> use it (no SSAR — GET /namespaces
//        already validated it into the cookie's visible set)
//   - non-default, otherwise                        -> one live checkNamespaceAccess:
//        allowed -> use it; denied -> 403
//
// The `visible` snapshot is read-only here; only GET /namespaces writes it. An expired
// snapshot is ignored (freshVisible returns []), so a stale grant can't skip the SSAR.

import { serverConfig } from './config';
import { isValidK8sName } from '../guards';
import { errorResponse } from '../responses';
import { checkNamespaceAccess } from './access';
import { readNamespacePreference, freshVisible } from '../middleware/namespace-preference';
import { log } from '../logger';

export type NamespaceResolution = { ok: true; namespace: string } | { ok: false; response: Response };

export async function resolveNamespace(req: Request, jwt: string): Promise<NamespaceResolution> {
  const requested = new URL(req.url).searchParams.get('namespace');

  // Absent -> back-compat default, no SSAR.
  if (!requested) {
    return { ok: true, namespace: serverConfig.namespace };
  }

  // Malformed value: reject before it ever reaches the K8s client.
  if (!isValidK8sName(requested)) {
    return { ok: false, response: errorResponse(400, 'Invalid namespace') };
  }

  // Configured default is exempt (back-compat, token-enforced) — reads and mutations alike.
  if (requested === serverConfig.namespace) {
    return { ok: true, namespace: requested };
  }

  // Non-default: trust the fresh visible snapshot, else one live SSAR. An expired snapshot
  // returns [] (revocation backstop) — forcing a live re-check.
  const pref = readNamespacePreference(req);
  if (freshVisible(pref).includes(requested)) {
    return { ok: true, namespace: requested };
  }

  const allowed = await checkNamespaceAccess(jwt, requested);
  if (allowed) {
    return { ok: true, namespace: requested };
  }

  log('warn', `Denied namespace access: ns=${requested}`);
  return { ok: false, response: errorResponse(403, 'Forbidden — no access to the requested namespace') };
}
