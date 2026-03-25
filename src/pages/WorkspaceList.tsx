import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, Grid, CircularProgress, ToggleButtonGroup,
  ToggleButton, InputBase, Stack, Paper,
} from '@mui/material';
import { Add, Search, Refresh } from '@mui/icons-material';
import { useWorkspaces } from '../api';
import { useAuth } from '../context';
import { WorkspaceCard } from '../components';
import { strings } from '../constants';
import styles from './WorkspaceList.module.css';

export function WorkspaceList() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: workspaces, isLoading, refetch, isFetching } = useWorkspaces();
  const [filter, setFilter] = useState<'all' | 'mine'>('mine');
  const [search, setSearch] = useState('');

  const filteredWorkspaces = useMemo(() => {
    if (!workspaces) return [];

    return workspaces.filter((ws) => {
      if (filter === 'mine') {
        const owner = ws.metadata.annotations?.['workspace.jupyter.org/created-by'];
        if (!owner || !user?.username) return false;

        const isOwner =
          owner === user.username ||
          owner === `github:${user.username}` ||
          owner.endsWith(`/${user.username}`) ||
          owner.includes(`:${user.username}`);

        if (!isOwner) return false;
      }

      if (search) {
        const q = search.toLowerCase();
        const matchesSearch = ws.spec.displayName.toLowerCase().includes(q) ||
                             ws.metadata.name.toLowerCase().includes(q);
        if (!matchesSearch) return false;
      }

      return true;
    });
  }, [workspaces, filter, user?.username, search]);

  const handleFilterChange = (_: React.MouseEvent<HTMLElement>, value: string | null) => {
    if (value && (value === 'all' || value === 'mine')) {
      setFilter(value);
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
  };

  const handleCreateClick = () => navigate('/create');

  if (isLoading) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ minHeight: '400px' }}>
        <CircularProgress size={32} />
      </Stack>
    );
  }

  const isEmpty = filteredWorkspaces.length === 0;

  return (
    <Box>
      <Box sx={{ mb: 4 }}>
        <Typography variant="h2" sx={{ mb: 1 }}>{strings.workspace.listTitle}</Typography>
        <Typography variant="body2" color="text.secondary">
          {strings.workspace.listDescription}
        </Typography>
      </Box>

      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3, flexWrap: 'wrap' }} gap={2}>
        <Stack direction="row" gap={2} alignItems="center">
          <Paper className={styles.searchContainer} elevation={0}>
            <Search className={styles.searchIcon} sx={{ fontSize: 20, mr: 1, color: 'text.secondary' }} />
            <InputBase
              placeholder={strings.workspace.searchPlaceholder}
              value={search}
              onChange={handleSearchChange}
              inputProps={{ 'aria-label': strings.a11y.searchWorkspaces }}
              fullWidth
            />
          </Paper>

          <ToggleButtonGroup
            value={filter}
            exclusive
            onChange={handleFilterChange}
            size="small"
            aria-label={strings.a11y.filterWorkspaces}
          >
            <ToggleButton value="mine">{strings.workspace.filterMine}</ToggleButton>
            <ToggleButton value="all">{strings.workspace.filterAll}</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        <Stack direction="row" gap={1}>
          <Button
            variant="outlined"
            startIcon={isFetching ? <CircularProgress size={16} /> : <Refresh />}
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {strings.workspace.refresh}
          </Button>
          <Button variant="contained" startIcon={<Add />} onClick={handleCreateClick} className={styles.gradientButton}>
            {strings.workspace.newWorkspace}
          </Button>
        </Stack>
      </Stack>

      {isEmpty ? (
        <Paper className={styles.emptyState} elevation={0}>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            {search ? strings.workspace.noWorkspacesFound : strings.workspace.noWorkspacesYet}
          </Typography>
          <Typography variant="body2" color="text.secondary" className={styles.emptyStateDescription}>
            {search ? strings.workspace.noWorkspacesSearchDescription : strings.workspace.noWorkspacesDescription}
          </Typography>
          {!search && (
            <Button variant="outlined" startIcon={<Add />} onClick={handleCreateClick}>
              {strings.workspace.createWorkspace}
            </Button>
          )}
        </Paper>
      ) : (
        <Grid container spacing={2.5}>
          {filteredWorkspaces.map((ws) => (
            <Grid size={{ xs: 12, sm: 6, lg: 4 }} key={ws.metadata.name}>
              <WorkspaceCard workspace={ws} />
            </Grid>
          ))}
        </Grid>
      )}
    </Box>
  );
}
