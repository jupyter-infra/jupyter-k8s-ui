import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';
import type { CreateWorkspaceRequest, Workspace } from '../types';
import { getWorkspaceState } from '../utils';
import { isAuthError } from './auth-interceptor';

// Query keys as constants for consistency
export const workspaceKeys = {
  all: ['workspaces'] as const,
  detail: (name: string) => ['workspaces', name] as const,
};

export const templateKeys = {
  all: ['templates'] as const,
};

export const clusterAccessKeys = {
  all: ['cluster-access'] as const,
};

// Polling configuration
const LIST_POLL_INTERVAL_MS = 60_000; // 60 seconds
const DETAIL_POLL_INTERVAL_MS = 3_000; // 3 seconds (only while workspace is transitioning)

export function useTemplates() {
  return useQuery({
    queryKey: templateKeys.all,
    queryFn: () => apiClient.listTemplates(),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
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
  return useQuery({
    queryKey: workspaceKeys.all,
    queryFn: () => apiClient.listWorkspaces(),
    refetchInterval: (query) => {
      if (query.state.error && isAuthError(query.state.error)) return false;
      return LIST_POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
  });
}

/**
 * A workspace is "settled" when it's in a terminal state and doesn't need polling.
 * Terminal states: Available=True (running & ready), or Stopped with no Progressing.
 */
function isWorkspaceSettled(workspace: Workspace | undefined): boolean {
  if (!workspace) return false;
  const { isAvailable, isProgressing, isStopped } = getWorkspaceState(workspace);

  return !isProgressing && (isAvailable || isStopped);
}

export function useWorkspace(name: string) {
  const result = useQuery({
    queryKey: workspaceKeys.detail(name),
    queryFn: () => apiClient.getWorkspace(name),
    enabled: Boolean(name),
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

  return useMutation({
    mutationFn: (data: CreateWorkspaceRequest) => apiClient.createWorkspace(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) => apiClient.deleteWorkspace(name),
    // Optimistic update
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: workspaceKeys.all });
      const previousWorkspaces = queryClient.getQueryData<Workspace[]>(workspaceKeys.all);

      queryClient.setQueryData<Workspace[]>(workspaceKeys.all, (old) => old?.filter((ws) => ws.metadata.name !== name) ?? []);

      return { previousWorkspaces };
    },
    onError: (_err, _name, context) => {
      // Rollback on error
      if (context?.previousWorkspaces) {
        queryClient.setQueryData(workspaceKeys.all, context.previousWorkspaces);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });
}

export function useStartWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) => apiClient.startWorkspace(name),
    // Optimistic update — polling will reconcile with real state
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: workspaceKeys.all });
      const previousWorkspaces = queryClient.getQueryData<Workspace[]>(workspaceKeys.all);

      queryClient.setQueryData<Workspace[]>(
        workspaceKeys.all,
        (old) => old?.map((ws) => (ws.metadata.name === name ? { ...ws, spec: { ...ws.spec, desiredStatus: 'Running' as const } } : ws)) ?? [],
      );

      return { previousWorkspaces, name };
    },
    onError: (_err, _name, context) => {
      if (context?.previousWorkspaces) {
        queryClient.setQueryData(workspaceKeys.all, context.previousWorkspaces);
      }
    },
    onSettled: (_data, _err, name) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(name) });
    },
  });
}

export function useStopWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) => apiClient.stopWorkspace(name),
    // Optimistic update — polling will reconcile with real state
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: workspaceKeys.all });
      const previousWorkspaces = queryClient.getQueryData<Workspace[]>(workspaceKeys.all);

      queryClient.setQueryData<Workspace[]>(
        workspaceKeys.all,
        (old) => old?.map((ws) => (ws.metadata.name === name ? { ...ws, spec: { ...ws.spec, desiredStatus: 'Stopped' as const } } : ws)) ?? [],
      );

      return { previousWorkspaces, name };
    },
    onError: (_err, _name, context) => {
      if (context?.previousWorkspaces) {
        queryClient.setQueryData(workspaceKeys.all, context.previousWorkspaces);
      }
    },
    onSettled: (_data, _err, name) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(name) });
    },
  });
}
