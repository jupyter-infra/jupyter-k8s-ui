import type { ReactNode } from 'react';
import { Button, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import { useNamespace } from '../../context/NamespaceContext';
import { strings } from '../../constants';

interface NamespaceGateViewProps {
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  children: ReactNode;
}

// What a page shows while no namespace is known yet: progress while the lookup runs, including
// its retries, and the error with Retry once the retries are exhausted.
export function NamespaceGateView({ loading, error, onRetry, children }: NamespaceGateViewProps) {
  if (loading) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ minHeight: '400px' }}>
        <CircularProgress size={32} />
      </Stack>
    );
  }
  if (error) {
    return (
      <Paper elevation={0} sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h6" color="text.secondary" gutterBottom>
          {strings.namespace.loadErrorTitle}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {strings.namespace.loadErrorDescription}
        </Typography>
        <Button variant="contained" onClick={onRetry}>
          {strings.namespace.loadErrorAction}
        </Button>
      </Paper>
    );
  }
  return <>{children}</>;
}

// Every page needs a namespace before it can load anything, so the layout renders the bootstrap
// state for all of them instead of each page waiting on its own.
export function NamespaceGate({ children }: { children: ReactNode }) {
  const { activeNamespace, isBootstrapLoading, bootstrapError, retryBootstrap } = useNamespace();
  if (activeNamespace) return <>{children}</>;
  return (
    <NamespaceGateView loading={isBootstrapLoading} error={bootstrapError} onRetry={retryBootstrap}>
      {children}
    </NamespaceGateView>
  );
}
