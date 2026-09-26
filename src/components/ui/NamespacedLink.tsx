import type { Ref } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { useNamespace } from '../../context/NamespaceContext';
import { withNamespaceParam } from '../../utils';

type NamespacedLinkProps = Omit<LinkProps, 'to'> & {
  to: string;
  // Namespace to carry instead of the active one, for a link to an object elsewhere.
  namespace?: string;
  ref?: Ref<HTMLAnchorElement>;
};

// A react-router Link that keeps the namespace in the URL; the link counterpart of
// useNamespacedNavigate. Usable as a MUI `component`, which passes `to` and `ref` through.
export function NamespacedLink({ to, namespace, ref, ...rest }: NamespacedLinkProps) {
  const { activeNamespace } = useNamespace();
  return <Link ref={ref} to={withNamespaceParam(to, namespace ?? activeNamespace)} {...rest} />;
}
