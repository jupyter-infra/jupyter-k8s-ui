import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CircularProgress, Box } from '@mui/material';
import { AuthProvider, ThemeProvider } from './context';
import { ErrorBoundary, Layout } from './components';
import { isAuthError } from './api/auth-interceptor';

// Lazy load pages for code splitting
const WorkspaceList = lazy(() => import('./pages/WorkspaceList').then((m) => ({ default: m.WorkspaceList })));
const WorkspaceCreate = lazy(() => import('./pages/WorkspaceCreate').then((m) => ({ default: m.WorkspaceCreate })));
const WorkspaceDetail = lazy(() => import('./pages/WorkspaceDetail').then((m) => ({ default: m.WorkspaceDetail })));
const KubectlAccess = lazy(() => import('./pages/KubectlAccess').then((m) => ({ default: m.KubectlAccess })));
const WorkspaceAdvancedEditor = lazy(() => import('./pages/WorkspaceAdvancedEditor').then((m) => ({ default: m.WorkspaceAdvancedEditor })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (isAuthError(error)) return false;
        return failureCount < 1;
      },
      staleTime: 5000,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
});

function PageLoader() {
  return (
    <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
      <CircularProgress size={32} />
    </Box>
  );
}

function AppContent() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<WorkspaceList />} />
              <Route path="create" element={<WorkspaceCreate />} />
              <Route path="workspace/:name" element={<WorkspaceDetail />} />
              <Route path="workspace/:name/edit" element={<WorkspaceAdvancedEditor />} />
              <Route path="kubectl" element={<KubectlAccess />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AppContent />
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
