import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNamespace } from '../context/NamespaceContext';
import { withNamespaceParam } from '../utils';

// In-app navigation that keeps the namespace in the URL. The URL namespace is the per-tab
// context and wins over the cookie, so a path without it falls back to whatever namespace
// the cookie holds. Pass `namespace` for a link to an object in another namespace.
export function useNamespacedNavigate() {
  const navigate = useNavigate();
  const { activeNamespace } = useNamespace();
  return useCallback(
    (to: string, opts?: { namespace?: string; replace?: boolean }) =>
      navigate(withNamespaceParam(to, opts?.namespace ?? activeNamespace), { replace: opts?.replace }),
    [navigate, activeNamespace],
  );
}
