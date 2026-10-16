import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';
import type { CreateWorkspaceRequest, UpdateWorkspaceRequest, Workspace, AdvancedWorkspacePayload } from '../types';
import { findTrueCondition, getWorkspaceStatus, isOwnerOrPublic } from '../utils';
import { isAuthError } from './auth-interceptor';
import { useNamespace, namespaceKeys } from '../context/NamespaceContext';
import { useAuth } from '../context/AuthContext';

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
export const FAST_POLL_INTERVAL_MS = 3_000; // 3 seconds (only while a workspace is transitioning)
// A start still Progressing past the workspace Deployment's progress deadline (the Kubernetes default of 10
// minutes) has stalled; the fast rate ends 5 minutes after that, and a late recovery shows at the list rate.
export const FAST_POLL_MAX_AGE_MS = 15 * 60_000;

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

// poll: false reads the list once for a page that shows no status, such as the create form.
export function useWorkspaces({ poll = true }: { poll?: boolean } = {}) {
  const { activeNamespace } = useNamespace();
  const { user } = useAuth();
  return useQuery({
    queryKey: workspaceKeys.all(activeNamespace),
    queryFn: async () => {
      const workspaces = await apiClient.listWorkspaces(activeNamespace);
      forgetAcknowledgedRequests(workspaces);
      return workspaces;
    },
    enabled: Boolean(activeNamespace),
    // The fast rate while a workspace this viewer waits on is transitioning: one they could open, or one this
    // tab asked to start or stop. Every tab lists the namespace with its own token, so the scope bounds the load.
    // A failed fetch keeps the previous list, so the error is checked first.
    refetchInterval: poll
      ? (query) => {
          if (query.state.error) return isAuthError(query.state.error) ? false : LIST_POLL_INTERVAL_MS;
          const now = Date.now();
          // some() passes the index as the second argument, which the check would take as the clock
          const watched = query.state.data?.some(
            (workspace) => (isOwnerOrPublic(workspace, user?.k8sUser) || isWorkspaceRequested(workspace, now)) && isWorkspaceTransitioning(workspace, now),
          );
          return watched ? FAST_POLL_INTERVAL_MS : LIST_POLL_INTERVAL_MS;
        }
      : false,
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

// Ages compare the browser clock with API server timestamps; a browser clock running ahead shortens the bound.
// A missing timestamp cannot date the wait, so it counts as beyond the bound.
const withinFastPollAge = (timestamp: string | undefined, now: number) => timestamp !== undefined && now - Date.parse(timestamp) < FAST_POLL_MAX_AGE_MS;

// Start and Stop requests made from this tab, by namespace/name. Right after one the conditions still show
// the old state (#51) and nothing on the object dates the wait, so the request time bounds the fast rate.
const requestedAt = new Map<string, number>();

const requestKey = (namespace: string | undefined, name: string) => `${namespace}/${name}`;

export function markWorkspaceRequested(namespace: string | undefined, name: string, now = Date.now()): void {
  requestedAt.set(requestKey(namespace, name), now);
}

export function forgetWorkspaceRequest(namespace: string | undefined, name: string): void {
  requestedAt.delete(requestKey(namespace, name));
}

// Drops the requests the fetched workspaces have outgrown, a settled one or one whose transition the operator
// has recorded, and every request older than the bound. The query functions call it, so the map is current
// when React Query evaluates the refetch interval on the fetched data.
export function forgetAcknowledgedRequests(workspaces: Workspace[], now = Date.now()): void {
  for (const [key, at] of requestedAt) {
    if (now - at >= FAST_POLL_MAX_AGE_MS) requestedAt.delete(key);
  }
  for (const workspace of workspaces) {
    if (isWorkspaceSettled(workspace) || findTrueCondition(workspace, 'Progressing', 'Deleting')) {
      forgetWorkspaceRequest(workspace.metadata.namespace, workspace.metadata.name);
    }
  }
}

const requestedWithinBound = (key: string, now: number) => {
  const requested = requestedAt.get(key);
  return requested !== undefined && now - requested < FAST_POLL_MAX_AGE_MS;
};

export function isWorkspaceRequested(workspace: Workspace, now = Date.now()): boolean {
  return requestedWithinBound(requestKey(workspace.metadata.namespace, workspace.metadata.name), now);
}

// The fast rate follows an active transition for at most FAST_POLL_MAX_AGE_MS. Without one, Degraded and
// Unknown count only after a Start or Stop this tab requested, so a workspace nobody touches does not keep
// the fast rate. A read only; the request map changes in the mutations and in forgetAcknowledgedRequests.
export function isWorkspaceTransitioning(workspace: Workspace, now = Date.now()): boolean {
  if (isWorkspaceSettled(workspace)) return false;
  const active = findTrueCondition(workspace, 'Progressing', 'Deleting');
  if (active) return withinFastPollAge(active.lastTransitionTime, now);
  const key = requestKey(workspace.metadata.namespace, workspace.metadata.name);
  const status = getWorkspaceStatus(workspace);
  // the cache write right after a Start or Stop click re-evaluates the rate while the conditions still
  // read the old state, Degraded included
  if (status === 'Degraded' || status === 'Unknown') return requestedWithinBound(key, now);
  // No conditions at all means the operator has not reconciled the workspace yet; its age bounds the rate.
  if ((workspace.status?.conditions ?? []).length === 0) return withinFastPollAge(workspace.metadata.creationTimestamp, now);
  return requestedWithinBound(key, now);
}

export function useWorkspace(name: string) {
  const { activeNamespace } = useNamespace();
  const result = useQuery({
    queryKey: workspaceKeys.detail(name, activeNamespace),
    queryFn: async () => {
      const workspace = await apiClient.getWorkspace(name, activeNamespace);
      forgetAcknowledgedRequests([workspace]);
      return workspace;
    },
    enabled: Boolean(name) && Boolean(activeNamespace),
    // The list's two rates, so a Degraded workspace left open does not poll fast without end.
    refetchInterval: (query) => {
      if (query.state.error) return isAuthError(query.state.error) ? false : LIST_POLL_INTERVAL_MS;
      return query.state.data && isWorkspaceTransitioning(query.state.data) ? FAST_POLL_INTERVAL_MS : LIST_POLL_INTERVAL_MS;
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
      markWorkspaceRequested(activeNamespace, name);
      const previousWorkspaces = queryClient.getQueryData<Workspace[]>(listKey);

      queryClient.setQueryData<Workspace[]>(
        listKey,
        (old) => old?.map((ws) => (ws.metadata.name === name ? { ...ws, spec: { ...ws.spec, desiredStatus: 'Running' as const } } : ws)) ?? [],
      );

      return { previousWorkspaces, name };
    },
    onError: (_err, name, context) => {
      forgetWorkspaceRequest(activeNamespace, name);
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
      markWorkspaceRequested(activeNamespace, name);
      const previousWorkspaces = queryClient.getQueryData<Workspace[]>(listKey);

      queryClient.setQueryData<Workspace[]>(
        listKey,
        (old) => old?.map((ws) => (ws.metadata.name === name ? { ...ws, spec: { ...ws.spec, desiredStatus: 'Stopped' as const } } : ws)) ?? [],
      );

      return { previousWorkspaces, name };
    },
    onError: (_err, name, context) => {
      forgetWorkspaceRequest(activeNamespace, name);
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
