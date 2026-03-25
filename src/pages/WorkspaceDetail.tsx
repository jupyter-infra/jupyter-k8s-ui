import { useParams, useNavigate } from 'react-router-dom';
import {
  Typography, Button, Chip, CircularProgress, Box, Stack, Paper,
} from '@mui/material';
import {
  ArrowBack, PlayArrow, Stop, OpenInNew, Memory, Storage,
  CheckCircle, Error as ErrorIcon, Schedule, Info,
} from '@mui/icons-material';
import { useWorkspace, useStartWorkspace, useStopWorkspace } from '../api';
import { useAuth } from '../context';
import type { WorkspaceCondition } from '../types';
import { strings } from '../constants';
import styles from './WorkspaceDetail.module.css';

function getConditionIcon(type: string, status: string) {
  if (status === 'True') {
    if (type === 'Available') return <CheckCircle sx={{ color: 'success.main' }} />;
    if (type === 'Progressing') return <Schedule sx={{ color: 'info.main' }} />;
    if (type === 'Degraded') return <ErrorIcon sx={{ color: 'error.main' }} />;
  }
  return <Info sx={{ color: 'text.disabled' }} />;
}

function ConditionCard({ condition }: { condition: WorkspaceCondition }) {
  const isActive = condition.status === 'True';
  return (
    <Paper
      className={`${styles.conditionCard} ${isActive ? styles.conditionActive : ''}`}
      elevation={0}
    >
      <Stack direction="row" alignItems="flex-start" gap={1.5}>
        {getConditionIcon(condition.type, condition.status)}
        <Box>
          <Typography variant="subtitle2">{condition.type}</Typography>
          <Typography variant="body2" color="text.secondary">{condition.reason}</Typography>
          <Typography variant="caption" color="text.secondary">{condition.message}</Typography>
        </Box>
      </Stack>
    </Paper>
  );
}

function InfoRow({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <Stack direction="row" className={styles.infoRow}>
      <Typography variant="body2" color="text.secondary" className={styles.infoLabel} component="div">
        {label}
      </Typography>
      <Typography variant="body2" className={styles.infoValue} component="div">{value}</Typography>
    </Stack>
  );
}

export function WorkspaceDetail() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: workspace, isLoading, error } = useWorkspace(name ?? '');
  const startMutation = useStartWorkspace();
  const stopMutation = useStopWorkspace();

  if (isLoading) {
    return (
      <Box className={styles.loadingContainer}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !workspace) {
    return (
      <Box className={styles.container}>
        <Button startIcon={<ArrowBack />} onClick={() => navigate('/')}>
          {strings.common.back}
        </Button>
        <Paper className={styles.errorCard}>
          <Typography color="error">
            {error?.message ?? 'Workspace not found'}
          </Typography>
        </Paper>
      </Box>
    );
  }

  const isRunning = workspace.spec.desiredStatus === 'Running';
  const isAvailable = workspace.status?.conditions?.find(
    (c) => c.type === 'Available' && c.status === 'True'
  );
  const isProgressing = workspace.status?.conditions?.find(
    (c) => c.type === 'Progressing' && c.status === 'True'
  );
  const accessURL = workspace.status?.accessURL;

  const owner = workspace.metadata.annotations?.['workspace.jupyter.org/created-by'];
  const isOwner = owner && user?.username && (
    owner === user.username ||
    owner === `github:${user.username}` ||
    owner.endsWith(`/${user.username}`) ||
    owner.includes(`:${user.username}`)
  );
  const canOpen = isRunning && isAvailable && accessURL && (isOwner || workspace.spec.accessType === 'Public');

  const handleStart = () => startMutation.mutate(workspace.metadata.name);
  const handleStop = () => stopMutation.mutate(workspace.metadata.name);
  const handleOpen = () => {
    if (accessURL) window.open(accessURL, '_blank');
  };

  return (
    <Box className={styles.container}>
      <Button
        startIcon={<ArrowBack />}
        onClick={() => navigate('/')}
        className={styles.backButton}
      >
        {strings.common.back}
      </Button>

      <Stack direction="row" alignItems="center" justifyContent="space-between" className={styles.header}>
        <Box>
          <Typography variant="h4">{workspace.spec.displayName}</Typography>
          <Typography variant="body2" color="text.secondary">{workspace.metadata.name}</Typography>
        </Box>
        <Stack direction="row" gap={1}>
          {isOwner && (
            isRunning ? (
              <Button
                variant="outlined"
                startIcon={<Stop />}
                onClick={handleStop}
                disabled={stopMutation.isPending}
              >
                {strings.workspace.stop}
              </Button>
            ) : (
              <Button
                variant="contained"
                startIcon={<PlayArrow />}
                onClick={handleStart}
                disabled={startMutation.isPending}
              >
                {strings.workspace.start}
              </Button>
            )
          )}
          {canOpen && (
            <Button variant="contained" startIcon={<OpenInNew />} onClick={handleOpen}>
              {strings.workspace.openWorkspace}
            </Button>
          )}
        </Stack>
      </Stack>

      <Stack direction="row" gap={3} className={styles.content}>
        <Box className={styles.mainColumn}>
          <Paper className={styles.section} elevation={0}>
            <Typography variant="h6" className={styles.sectionTitle}>
              {strings.workspace.detailConditions}
            </Typography>
            <Stack gap={1.5}>
              {workspace.status?.conditions?.map((condition) => (
                <ConditionCard key={condition.type} condition={condition} />
              )) ?? (
                <Typography variant="body2" color="text.secondary">
                  No conditions available
                </Typography>
              )}
            </Stack>
          </Paper>
        </Box>

        <Box className={styles.sideColumn}>
          <Paper className={styles.section} elevation={0}>
            <Typography variant="h6" className={styles.sectionTitle}>
              {strings.workspace.detailInfo}
            </Typography>
            <Stack gap={1}>
              <InfoRow label="Status" value={
                <Chip
                  size="small"
                  label={isProgressing ? 'Starting' : isAvailable ? 'Running' : 'Stopped'}
                  color={isAvailable ? 'success' : isProgressing ? 'info' : 'default'}
                />
              } />
              <InfoRow label="Image" value={workspace.spec.image} />
              <InfoRow label="Access" value={
                <Chip
                  size="small"
                  label={workspace.spec.accessType === 'Public' ? 'Public' : 'Private'}
                  variant="outlined"
                />
              } />
              <InfoRow label="Created" value={
                new Date(workspace.metadata.creationTimestamp ?? '').toLocaleDateString()
              } />
            </Stack>
          </Paper>

          <Paper className={styles.section} elevation={0}>
            <Typography variant="h6" className={styles.sectionTitle}>
              {strings.workspace.sectionResources}
            </Typography>
            <Stack gap={1}>
              <InfoRow
                label={<Stack direction="row" alignItems="center" gap={0.5}><Memory sx={{ fontSize: 16 }} /> CPU</Stack>}
                value={workspace.spec.resources.limits.cpu}
              />
              <InfoRow
                label={<Stack direction="row" alignItems="center" gap={0.5}><Storage sx={{ fontSize: 16 }} /> Memory</Stack>}
                value={workspace.spec.resources.limits.memory}
              />
            </Stack>
          </Paper>
        </Box>
      </Stack>
    </Box>
  );
}
