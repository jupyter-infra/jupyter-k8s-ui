import { useState, useMemo, useCallback } from 'react';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import {
  Typography,
  TextField,
  Button,
  Slider,
  Switch,
  Stack,
  Container,
  Paper,
  Alert,
  Collapse,
  CircularProgress,
  ToggleButtonGroup,
  ToggleButton,
  Divider,
  Link,
} from '@mui/material';
import { Memory, Storage } from '@mui/icons-material';
import { useCreateWorkspace, useWorkspaces } from '../api';
import { useAuth } from '../context/AuthContext';
import { ResourceSlider } from '../components';
import type { CreateWorkspaceRequest, OwnershipType } from '../types';
import { strings, resourceBounds, RESOURCE_DEFAULTS, IDLE_SHUTDOWN_DEFAULTS } from '../constants';
import { sanitizeK8sName } from '../utils';

function generateDefaults(username: string, existingCount: number) {
  const n = existingCount + 1;
  const displayName = n === 1 ? `${username}'s Workspace` : `${username}'s Workspace ${n}`;
  const name = sanitizeK8sName(displayName.replace(/'/g, ''));
  return { displayName, name };
}

export function WorkspaceCreate() {
  const navigate = useNavigate();
  const createMutation = useCreateWorkspace();
  const { user } = useAuth();
  const { data: workspaces } = useWorkspaces();

  const defaults = useMemo(() => generateDefaults(user?.username ?? 'user', workspaces?.length ?? 0), [user?.username, workspaces?.length]);

  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [displayNameOverride, setDisplayNameOverride] = useState<string | null>(null);
  const [cpuLimit, setCpuLimit] = useState(1);
  const [memoryLimit, setMemoryLimit] = useState(2);
  const [storageSize, setStorageSize] = useState(10);
  const [ownershipType, setOwnershipType] = useState<OwnershipType>('Public');
  const [idleShutdownEnabled, setIdleShutdownEnabled] = useState(false);
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState<number>(IDLE_SHUTDOWN_DEFAULTS.DEFAULT_TIMEOUT);

  const name = nameOverride ?? defaults.name;
  const displayName = displayNameOverride ?? defaults.displayName;

  const handleDisplayNameChange = useCallback(
    (value: string) => {
      setDisplayNameOverride(value);
      if (nameOverride === null) {
        setNameOverride(sanitizeK8sName(value.replace(/'/g, '')));
      }
    },
    [nameOverride],
  );

  const handleNameChange = useCallback((value: string) => {
    setNameOverride(sanitizeK8sName(value));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const request: CreateWorkspaceRequest = {
      name,
      displayName: displayName || name,
      resources: {
        limits: { cpu: `${cpuLimit}`, memory: `${memoryLimit}Gi` },
        requests: {
          cpu: `${Math.max(RESOURCE_DEFAULTS.MIN_CPU_REQUEST, cpuLimit * RESOURCE_DEFAULTS.CPU_REQUEST_RATIO)}`,
          memory: `${Math.max(RESOURCE_DEFAULTS.MIN_MEMORY_REQUEST, memoryLimit * RESOURCE_DEFAULTS.MEMORY_REQUEST_RATIO)}Gi`,
        },
      },
      storage: { size: `${storageSize}Gi` },
      accessType: ownershipType === 'Public' ? 'Public' : 'Private',
      ownershipType,
    };

    if (idleShutdownEnabled) {
      request.idleShutdown = { enabled: true, timeoutInMinutes: idleTimeoutMinutes };
    }

    try {
      await createMutation.mutateAsync(request);
      navigate('/');
    } catch {
      // Error is captured by createMutation.error
    }
  };

  const { workspace: ws, common } = strings;

  return (
    <Container maxWidth="sm">
      <Stack spacing={3} component="form" onSubmit={handleSubmit} paddingBottom={8}>
        <Typography variant="h4" fontWeight={600}>
          {ws.createTitle}
        </Typography>

        {createMutation.error && <Alert severity="error">{createMutation.error.message}</Alert>}

        {/* Name Section */}
        <Paper variant="outlined">
          <Stack spacing={2} padding={3}>
            <Typography variant="subtitle2">{ws.sectionWorkspace}</Typography>
            <Stack direction="row" spacing={2}>
              <TextField
                label={ws.fieldName}
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                required
                placeholder={ws.fieldNamePlaceholder}
                size="small"
                helperText={ws.fieldNameHelper}
                fullWidth
              />
              <TextField
                label={ws.fieldDisplayName}
                value={displayName}
                onChange={(e) => handleDisplayNameChange(e.target.value)}
                placeholder={name || 'My Workspace'}
                size="small"
                fullWidth
              />
            </Stack>
          </Stack>
        </Paper>

        {/* Resources Section */}
        <Paper variant="outlined">
          <Stack spacing={2} padding={3}>
            <Typography variant="subtitle2">{ws.sectionResources}</Typography>

            <ResourceSlider
              icon={<Memory color="action" fontSize="small" />}
              label={ws.resourceCpu}
              value={cpuLimit}
              unit={common.cores}
              min={resourceBounds.cpu.min}
              max={resourceBounds.cpu.max}
              step={resourceBounds.cpu.step}
              onChange={setCpuLimit}
            />
            <ResourceSlider
              icon={<Storage color="action" fontSize="small" />}
              label={ws.resourceMemory}
              value={memoryLimit}
              unit={common.gb}
              min={resourceBounds.memory.min}
              max={resourceBounds.memory.max}
              step={resourceBounds.memory.step}
              onChange={setMemoryLimit}
            />
            <ResourceSlider
              icon={<Storage color="action" fontSize="small" />}
              label={ws.resourceStorage}
              value={storageSize}
              unit={common.gb}
              min={resourceBounds.storage.min}
              max={resourceBounds.storage.max}
              step={resourceBounds.storage.step}
              onChange={setStorageSize}
            />
          </Stack>
        </Paper>

        {/* Settings Section */}
        <Paper variant="outlined">
          <Stack spacing={1} padding={3}>
            <Typography variant="subtitle2">{ws.sectionSettings}</Typography>

            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Typography variant="body2">{ws.accessQuestion}</Typography>
              <ToggleButtonGroup
                value={ownershipType}
                exclusive
                onChange={(_, v) => {
                  if (v) setOwnershipType(v);
                }}
                size="small"
              >
                <ToggleButton value="Public">{common.public}</ToggleButton>
                <ToggleButton value="OwnerOnly">{common.private}</ToggleButton>
              </ToggleButtonGroup>
            </Stack>

            <Divider />

            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Stack>
                <Typography variant="body2">{ws.idleShutdownEnable}</Typography>
                {idleShutdownEnabled && (
                  <Typography variant="caption" color="text.secondary">
                    Shutdown after {idleTimeoutMinutes} {common.min} of inactivity
                  </Typography>
                )}
              </Stack>
              <Switch
                size="small"
                checked={idleShutdownEnabled}
                onChange={(e) => setIdleShutdownEnabled(e.target.checked)}
                slotProps={{ input: { 'aria-label': ws.idleShutdownEnable } }}
              />
            </Stack>

            <Collapse in={idleShutdownEnabled}>
              <Stack spacing={0.5} paddingTop={1}>
                <Slider
                  value={idleTimeoutMinutes}
                  onChange={(_, v) => setIdleTimeoutMinutes(v as number)}
                  min={IDLE_SHUTDOWN_DEFAULTS.MIN_TIMEOUT}
                  max={IDLE_SHUTDOWN_DEFAULTS.MAX_TIMEOUT}
                  step={IDLE_SHUTDOWN_DEFAULTS.STEP}
                  size="small"
                  aria-label={ws.idleShutdownTimeout}
                />
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="caption" color="text.secondary">
                    {IDLE_SHUTDOWN_DEFAULTS.MIN_TIMEOUT} {common.min}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {IDLE_SHUTDOWN_DEFAULTS.MAX_TIMEOUT} {common.min}
                  </Typography>
                </Stack>
              </Stack>
            </Collapse>
          </Stack>
        </Paper>

        {/* Advanced hint */}
        <Typography variant="caption" color="text.secondary" textAlign="center">
          {ws.advancedHint}{' '}
          <Link component={RouterLink} to="/kubectl" underline="hover">
            {ws.advancedHintKubectl}
          </Link>{' '}
          {ws.advancedHintOr}{' '}
          <Link href={ws.advancedHintDocsUrl} target="_blank" rel="noopener" underline="hover">
            {ws.advancedHintDocs}
          </Link>
          .
        </Typography>

        {/* Actions */}
        <Stack direction="row" spacing={2} justifyContent="flex-end">
          <Button variant="text" onClick={() => navigate('/')}>
            {common.cancel}
          </Button>
          <Button type="submit" variant="contained" disabled={!name || createMutation.isPending}>
            {createMutation.isPending ? <CircularProgress size={20} color="inherit" /> : ws.createWorkspace}
          </Button>
        </Stack>
      </Stack>
    </Container>
  );
}
