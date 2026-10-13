import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';
import type { CreateWorkspaceRequest, UpdateWorkspaceRequest, Workspace, AdvancedWorkspacePayload } from '../types';
import { getWorkspaceStatus } from '../utils';
import { isAuthError } from './auth-interceptor';
import { useNamespace, namespaceKeys } from '../context/NamespaceContext';

// Query keys include the namespace so cached data never leaks across namespaces. A
// switch changes the key, so React Query fetches fresh rather than serving another
// namespace's list.
export const workspaceKeys = {
  all: (ns: string | undefined) => ['workspaces', ns] as const,
  detail: (name: string, ns: string | undefined) => ['workspaces', ns, name] as const,
};

export const templateKeys = {
  all: (ns: string | undefined) => ['templates', ns] as const,
};

export const accessStrategyKeys = {
  all: (ns: string | undefined) => ['access-strategies', ns] as const,
};

export const clusterAccessKeys = {
  all: ['cluster-access'] as const,
};

// Polling configuration
export const LIST_POLL_INTERVAL_MS = 60_000; // 60 seconds
export const DETAIL_POLL_INTERVAL_MS = 3_000; // 3 seconds (only while workspace is transitioning)

export function useTemplates() {
  const { activeNamespace } = useNamespace();
  return useQuery({
    queryKey: templateKeys.all(activeNamespace),
    queryFn: () => apiClient.listTemplates(activeNamespace),
    enabled: Boolean(activeNamespace),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

export function useAccessStrategies() {
  const { activeNamespace } = useNamespace();
  return useQuery({
    queryKey: accessStrategyKeys.all(activeNamespace),
    queryFn: () => apiClient.listAccessStrategies(activeNamespace),
    enabled: Boolean(activeNamespace),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: false,
  });
}

export function useClusterAccess(enabled = true) {
  return useQuery({
    queryKey: clusterAccessKeys.all,
    queryFn: () => apiClient.getClusterAccess(),
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: false,
    enabled,
  });
}

export function useWorkspaces() {
  const { activeNamespace } = useNamespace();
  return useQuery({
    queryKey: workspaceKeys.all(activeNamespace),
    queryFn: () => apiClient.listWorkspaces(activeNamespace),
    enabled: Boolean(activeNamespace),
    // The detail page's rate while any listed workspace is transitioning, so the card's start step
    // keeps up with the cluster. A failed fetch keeps the previous list, so the error is checked first.
    refetchInterval: (query) => {
      if (query.state.error) return isAuthError(query.state.error) ? false : LIST_POLL_INTERVAL_MS;
      return query.state.data?.some(isWorkspaceTransitioning) ? DETAIL_POLL_INTERVAL_MS : LIST_POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
  });
}

// Settled means the derived status has converged on spec.desiredStatus (unset
// desiredStatus expects Stopped, mirroring getWorkspaceStatus). A terminal status
// alone is not enough: a refetch right after Start/Stop can still see the old
// terminal conditions, and stopping polling there freezes the page (#51).
export function isWorkspaceSettled(workspace: Workspace | undefined): boolean {
  if (!workspace) return false;
  const desired = workspace.spec.desiredStatus ?? 'Stopped';
  return getWorkspaceStatus(workspace) === desired;
}

// The workspace Deployment's progress deadline is the Kubernetes default of 10 minutes; a Progressing or
// Deleting condition whose lastTransitionTime is older than 15 minutes no longer counts as a transition.
export const FAST_POLL_MAX_AGE_MS = 15 * 60_000;

const withinFastPollAge = (timestamp: string | undefined) => !timestamp || Date.now() - Date.parse(timestamp) < FAST_POLL_MAX_AGE_MS;

// Degraded and Unknown never count, so a workspace nobody fixes does not keep the fast rate. Unsettled
// also covers the moment after a Start or Stop when the conditions still show the old state (#51); nothing
// dates the request, so the fast rate holds until the operator records Progressing or Deleting.
export function isWorkspaceTransitioning(workspace: Workspace): boolean {
  if (isWorkspaceSettled(workspace)) return false;
  const status = getWorkspaceStatus(workspace);
  if (status === 'Degraded' || status === 'Unknown') return false;
  const conditions = workspace.status?.conditions ?? [];
  const active = conditions.find((c) => (c.type === 'Progressing' || c.type === 'Deleting') && c.status === 'True');
  if (active) return withinFastPollAge(active.lastTransitionTime);
  // No conditions at all means the operator has not reconciled the workspace yet; its age bounds the rate.
  return conditions.length > 0 || withinFastPollAge(workspace.metadata.creationTimestamp);
}

export function useWorkspace(name: string) {
  const { activeNamespace } = useNamespace();
  const result = useQuery({
    queryKey: workspaceKeys.detail(name, activeNamespace),
    queryFn: () => apiClient.getWorkspace(name, activeNamespace),
    enabled: Boolean(name) && Boolean(activeNamespace),
    refetchInterval: (query) => {
      if (query.state.error && isAuthError(query.state.error)) return false;
      return isWorkspaceSettled(query.state.data) ? false : DETAIL_POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
  });

  return result;
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  const { activeNamespace } = useNamespace();

  return useMutation({
    mutationFn: (data: CreateWorkspaceRequest) => apiClient.createWorkspace(data, activeNamespace),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all(activeNamespace) });
    },
  });
}

export const crdSchemaKeys = {
  detail: (crd: string) => ['crd-schema', crd] as const,
};

// The switcher's namespace list (the expensive SSAR fan-out), paged. Lazy: `enabled` is
// driven by the caller (the switcher opening), so page load never triggers the fan-out.
// Infinite query — `fetchNextPage` loads the next offset; pages accumulate client-side.
export function useNamespaces(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: namespaceKeys.list,
    queryFn: ({ pageParam }) => apiClient.listNamespaces({ offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined),
    enabled,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

// The CRD schema is immutable for the pod's lifetime (served from a startup
// singleton), so cache it aggressively and never refetch on its own.
export function useCrdSchema(crd: string) {
  return useQuery({
    queryKey: crdSchemaKeys.detail(crd),
    queryFn: () => apiClient.getCrdSchema(crd),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}

// Advanced editor: raw full-spec create/replace (the editor owns the whole spec).
// Navigation is left to the caller; we keep the existing invalidation behavior.
export function useCreateWorkspaceAdvanced() {
  const queryClient = useQueryClient();
  const { activeNamespace } = useNamespace();
  return useMutation({
    mutationFn: (data: AdvancedWorkspacePayload) => apiClient.createWorkspaceAdvanced(data, activeNamespace),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all(activeNamespace) });
    },
  });
}

// Simple-edit: field-shaped selective update via PATCH. The server overlays only the
// fields present in the body onto the live spec, so stored requests / unmodeled fields
// survive. That's a property of the overlay (body-shape driven), not the PATCH verb.
export function useUpdateWorkspace() {
  const queryClient = useQueryClient();
  const { activeNamespace } = useNamespace();
  return useMutation({
    mutationFn: ({ name, data }: { name: string; data: UpdateWorkspaceRequest }) => apiClient.updateWorkspace(name, data, activeNamespace),
    onSuccess: (_res, { name }) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all(activeNamespace) });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(name, activeNamespace) });
    },
  });
}

export function useReplaceWorkspaceAdvanced() {
  const queryClient = useQueryClient();
  const { activeNamespace } = useNamespace();
  return useMutation({
    mutationFn: ({ name, data }: { name: string; data: AdvancedWorkspacePayload }) => apiClient.replaceWorkspaceAdvanced(name, data, activeNamespace),
    onSuccess: (_res, { name }) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all(activeNamespace) });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(name, activeNamespace) });
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  const { activeNamespace } = useNamespace();
  const listKey = workspaceKeys.all(activeNamespace);

  return useMutation({
    mutationFn: (name: string) => apiClient.deleteWorkspace(name, activeNamespace),
    // Optimistic update
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previousWorkspaces = queryClient.getQueryData<Workspace[]>(listKey);

      queryClient.setQueryData<Workspace[]>(listKey, (old) => old?.filter((ws) => ws.metadata.name !== name) ?? []);

      return { previousWorkspaces };
    },
    onError: (_err, _name, context) => {
      // Rollback on error
      if (context?.previousWorkspaces) {
        queryClient.setQueryData(listKey, context.previousWorkspaces);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: listKey });
    },
  });
}

export function useStartWorkspace() {
  const queryClient = useQueryClient();
  const { activeNamespace } = useNamespace();
  const listKey = workspaceKeys.all(activeNamespace);

  return useMutation({
    mutationFn: (name: string) => apiClient.startWorkspace(name, activeNamespace),
    // Optimistic update — polling will reconcile with real state
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previousWorkspaces = queryClient.getQueryData<Workspace[]>(listKey);

      queryClient.setQueryData<Workspace[]>(
        listKey,
        (old) => old?.map((ws) => (ws.metadata.name === name ? { ...ws, spec: { ...ws.spec, desiredStatus: 'Running' as const } } : ws)) ?? [],
      );

      return { previousWorkspaces, name };
    },
    onError: (_err, _name, context) => {
      if (context?.previousWorkspaces) {
        queryClient.setQueryData(listKey, context.previousWorkspaces);
      }
    },
    onSettled: (_data, _err, name) => {
      queryClient.invalidateQueries({ queryKey: listKey });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(name, activeNamespace) });
    },
  });
}

export function useStopWorkspace() {
  const queryClient = useQueryClient();
  const { activeNamespace } = useNamespace();
  const listKey = workspaceKeys.all(activeNamespace);

  return useMutation({
    mutationFn: (name: string) => apiClient.stopWorkspace(name, activeNamespace),
    // Optimistic update — polling will reconcile with real state
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previousWorkspaces = queryClient.getQueryData<Workspace[]>(listKey);

      queryClient.setQueryData<Workspace[]>(
        listKey,
        (old) => old?.map((ws) => (ws.metadata.name === name ? { ...ws, spec: { ...ws.spec, desiredStatus: 'Stopped' as const } } : ws)) ?? [],
      );

      return { previousWorkspaces, name };
    },
    onError: (_err, _name, context) => {
      if (context?.previousWorkspaces) {
        queryClient.setQueryData(listKey, context.previousWorkspaces);
      }
    },
    onSettled: (_data, _err, name) => {
      queryClient.invalidateQueries({ queryKey: listKey });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(name, activeNamespace) });
    },
  });
}
