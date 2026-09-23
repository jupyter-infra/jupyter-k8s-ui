// Append ?namespace= to an in-app path. The URL namespace is the per-tab context and wins
// over the cookie, so a bare path such as '/' falls back to the cookie's namespace, which
// another tab or an earlier switch may have set to a different one.
export function withNamespaceParam(path: string, namespace: string | undefined): string {
  if (!namespace) return path;
  return `${path}${path.includes('?') ? '&' : '?'}namespace=${encodeURIComponent(namespace)}`;
}
