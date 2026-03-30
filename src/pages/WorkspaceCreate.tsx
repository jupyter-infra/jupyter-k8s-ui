import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Typography, TextField, Button, Slider, Autocomplete, Switch,
  Box, Stack, ToggleButtonGroup, ToggleButton, CircularProgress,
  Alert, Collapse,
} from '@mui/material';
import { Memory, Storage } from '@mui/icons-material';
import { useCreateWorkspace, useTemplates } from '../api';
import { TemplateCard } from '../components';
import type { WorkspaceTemplate, CreateWorkspaceRequest } from '../types';
import {
  strings, imageOptions, resourceBounds as defaultResourceBounds,
  RESOURCE_DEFAULTS, IDLE_SHUTDOWN_DEFAULTS,
} from '../constants';
import { clamp, parseResourceValue, parseMemoryGi, sanitizeK8sName } from '../utils';
import styles from './WorkspaceCreate.module.css';

export function WorkspaceCreate() {
  const navigate = useNavigate();
  const createMutation = useCreateWorkspace();
  const { data: templates, isLoading: templatesLoading } = useTemplates();

  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<WorkspaceTemplate | null>(null);
  const [image, setImage] = useState('uv');
  const [cpuLimit, setCpuLimit] = useState(1);
  const [memoryLimit, setMemoryLimit] = useState(2);
  const [storageSize, setStorageSize] = useState(10);
  const [storageMountPath, setStorageMountPath] = useState('/home/jovyan');
  const [accessType, setAccessType] = useState<'Public' | 'OwnerOnly'>('Public');
  const [accessStrategyName, setAccessStrategyName] = useState('sample-access-strategy');
  const [idleShutdownEnabled, setIdleShutdownEnabled] = useState(false);
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState<number>(IDLE_SHUTDOWN_DEFAULTS.DEFAULT_TIMEOUT);

  const resourceBounds = useMemo(() => {
    if (!selectedTemplate?.spec.resourceBounds?.resources) return defaultResourceBounds;
    const res = selectedTemplate.spec.resourceBounds.resources;
    return {
      cpu: {
        min: parseResourceValue(res.cpu?.min, defaultResourceBounds.cpu.min),
        max: parseResourceValue(res.cpu?.max, defaultResourceBounds.cpu.max),
        step: defaultResourceBounds.cpu.step,
      },
      memory: {
        min: parseMemoryGi(res.memory?.min, defaultResourceBounds.memory.min),
        max: parseMemoryGi(res.memory?.max, defaultResourceBounds.memory.max),
        step: defaultResourceBounds.memory.step,
      },
      storage: selectedTemplate.spec.primaryStorage ? {
        min: parseMemoryGi(selectedTemplate.spec.primaryStorage.minSize, defaultResourceBounds.storage.min),
        max: parseMemoryGi(selectedTemplate.spec.primaryStorage.maxSize, defaultResourceBounds.storage.max),
        step: defaultResourceBounds.storage.step,
      } : defaultResourceBounds.storage,
    };
  }, [selectedTemplate]);

  const idleShutdownBounds = useMemo(() => ({
    min: selectedTemplate?.spec.idleShutdownOverrides?.minIdleTimeoutInMinutes ?? IDLE_SHUTDOWN_DEFAULTS.MIN_TIMEOUT,
    max: selectedTemplate?.spec.idleShutdownOverrides?.maxIdleTimeoutInMinutes ?? IDLE_SHUTDOWN_DEFAULTS.MAX_TIMEOUT,
  }), [selectedTemplate]);

  const availableImages = useMemo(() => {
    if (selectedTemplate?.spec.allowedImages?.length) {
      return selectedTemplate.spec.allowedImages.map((img) => ({ value: img, label: img, description: '' }));
    }
    if (selectedTemplate && !selectedTemplate.spec.allowCustomImages) {
      const defaultImg = selectedTemplate.spec.defaultImage ?? '';
      return [{ value: defaultImg, label: defaultImg, description: '' }];
    }
    return [...imageOptions];
  }, [selectedTemplate]);

  const selectedImageValue = useMemo(() => {
    return availableImages.find((img) => img.value === image) ?? { value: image, label: image, description: '' };
  }, [availableImages, image]);

  const allowCustomImages = !selectedTemplate || (selectedTemplate.spec.allowCustomImages ?? true);

  // Show access strategy field when no template selected, or template doesn't provide one
  const showAccessStrategyField = !selectedTemplate?.spec.defaultAccessStrategy;

  const handleTemplateSelect = useCallback((template: WorkspaceTemplate) => {
    setSelectedTemplate(template);
    setImage(template.spec.defaultImage ?? '');

    const res = template.spec.resourceBounds?.resources;
    const cpuB = { min: parseResourceValue(res?.cpu?.min, 0.5), max: parseResourceValue(res?.cpu?.max, 8) };
    const memB = { min: parseMemoryGi(res?.memory?.min, 1), max: parseMemoryGi(res?.memory?.max, 16) };
    const storB = template.spec.primaryStorage
      ? { min: parseMemoryGi(template.spec.primaryStorage.minSize, 5), max: parseMemoryGi(template.spec.primaryStorage.maxSize, 100) }
      : { min: 5, max: 100 };

    if (template.spec.defaultResources?.requests) {
      setCpuLimit(clamp(parseResourceValue(template.spec.defaultResources.requests.cpu, 1), cpuB.min, cpuB.max));
      setMemoryLimit(clamp(parseMemoryGi(template.spec.defaultResources.requests.memory, 2), memB.min, memB.max));
    }
    if (template.spec.primaryStorage?.defaultSize) {
      setStorageSize(clamp(parseMemoryGi(template.spec.primaryStorage.defaultSize, 10), storB.min, storB.max));
    }
    if (template.spec.primaryStorage?.defaultMountPath) setStorageMountPath(template.spec.primaryStorage.defaultMountPath);
    if (template.spec.defaultAccessType) setAccessType(template.spec.defaultAccessType as 'Public' | 'OwnerOnly');
    if (template.spec.defaultAccessStrategy) {
      setAccessStrategyName(template.spec.defaultAccessStrategy.name ?? '');
    }
    if (template.spec.defaultIdleShutdown) {
      setIdleShutdownEnabled(template.spec.defaultIdleShutdown.enabled ?? false);
      const idleB = {
        min: template.spec.idleShutdownOverrides?.minIdleTimeoutInMinutes ?? 5,
        max: template.spec.idleShutdownOverrides?.maxIdleTimeoutInMinutes ?? 480,
      };
      setIdleTimeoutMinutes(clamp(template.spec.defaultIdleShutdown.idleTimeoutInMinutes ?? 30, idleB.min, idleB.max));
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const request: CreateWorkspaceRequest = {
      name,
      displayName: displayName || name,
      image,
      resources: {
        limits: { cpu: `${cpuLimit}`, memory: `${memoryLimit}Gi` },
        requests: {
          cpu: `${Math.max(RESOURCE_DEFAULTS.MIN_CPU_REQUEST, cpuLimit * RESOURCE_DEFAULTS.CPU_REQUEST_RATIO)}`,
          memory: `${Math.max(RESOURCE_DEFAULTS.MIN_MEMORY_REQUEST, memoryLimit * RESOURCE_DEFAULTS.MEMORY_REQUEST_RATIO)}Gi`,
        },
      },
      accessType,
      ownershipType: accessType,
    };

    // Use template's defaultAccessStrategy, or the user-provided value
    if (selectedTemplate?.spec.defaultAccessStrategy) {
      request.accessStrategy = selectedTemplate.spec.defaultAccessStrategy;
    } else if (accessStrategyName.trim()) {
      request.accessStrategy = { name: accessStrategyName.trim(), namespace: 'default' };
    }

    if (selectedTemplate) {
      request.templateRef = { name: selectedTemplate.metadata.name, namespace: selectedTemplate.metadata.namespace };
    }

    if (idleShutdownEnabled) {
      request.idleShutdown = { enabled: true, timeoutInMinutes: idleTimeoutMinutes };
    }

    try {
      await createMutation.mutateAsync(request);
      navigate('/');
    } catch (error) {
      console.error('Failed to create workspace:', error);
    }
  };

  const { workspace: ws, common } = strings;

  return (
    <Box className={styles.container}>
      <Typography variant="h4" className={styles.title}>{ws.createTitle}</Typography>

      {createMutation.error && <Alert severity="error" className={styles.alert}>{createMutation.error.message}</Alert>}

      <form onSubmit={handleSubmit}>
        {/* Workspace Name */}
        <Box className={styles.section}>
          <Typography className={styles.sectionLabel}>{ws.sectionWorkspace}</Typography>
          <Box className={styles.row}>
            <TextField label={ws.fieldName} value={name} onChange={(e) => setName(sanitizeK8sName(e.target.value))}
              required placeholder={ws.fieldNamePlaceholder} size="small" />
            <TextField label={ws.fieldDisplayName} value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              placeholder={name || 'My Workspace'} size="small" />
          </Box>
        </Box>

        {/* Template Selection */}
        <Box className={styles.section}>
          <Typography className={styles.sectionLabel}>{ws.sectionTemplate}</Typography>
          {templatesLoading ? (
            <Box className={styles.loading}><CircularProgress size={24} /></Box>
          ) : (
            <Box className={styles.templateGrid}>
              {templates?.map((t) => (
                <TemplateCard key={t.metadata.name} template={t} selected={selectedTemplate?.metadata.name === t.metadata.name}
                  onClick={() => handleTemplateSelect(t)} />
              ))}
            </Box>
          )}
        </Box>

        {/* Resources */}
        <Box className={styles.section}>
          <Typography className={styles.sectionLabel}>{ws.sectionResources}</Typography>
          <Stack gap={2.5}>
            <Autocomplete
              freeSolo={allowCustomImages}
              options={availableImages}
              getOptionLabel={(o) => (typeof o === 'string' ? o : o.value)}
              value={selectedImageValue}
              onChange={(_, v) => setImage(typeof v === 'string' ? v : v?.value ?? '')}
              onInputChange={(_, v, r) => r === 'input' && allowCustomImages && setImage(v)}
              size="small"
              renderInput={(params) => (
                <TextField {...params} label={ws.fieldImage} />
              )}
            />

            {/* CPU */}
            <Box className={styles.resourceBlock}>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Stack direction="row" alignItems="center" gap={1}>
                  <Memory className={styles.resourceIcon} sx={{ fontSize: 20 }} />
                  <Typography variant="body2">{ws.resourceCpu}</Typography>
                </Stack>
                <Typography className={styles.resourceValue}>{cpuLimit} {common.cores}</Typography>
              </Stack>
              <Slider value={cpuLimit} onChange={(_, v) => setCpuLimit(v as number)}
                min={resourceBounds.cpu.min} max={resourceBounds.cpu.max} step={resourceBounds.cpu.step}
                size="small" aria-label={ws.resourceCpu} />
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="caption" color="text.secondary">{resourceBounds.cpu.min} {common.cores}</Typography>
                <Typography variant="caption" color="text.secondary">{resourceBounds.cpu.max} {common.cores}</Typography>
              </Stack>
            </Box>

            {/* Memory */}
            <Box className={styles.resourceBlock}>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Stack direction="row" alignItems="center" gap={1}>
                  <Storage className={styles.resourceIcon} sx={{ fontSize: 20 }} />
                  <Typography variant="body2">{ws.resourceMemory}</Typography>
                </Stack>
                <Typography className={styles.resourceValue}>{memoryLimit} {common.gb}</Typography>
              </Stack>
              <Slider value={memoryLimit} onChange={(_, v) => setMemoryLimit(v as number)}
                min={resourceBounds.memory.min} max={resourceBounds.memory.max} step={resourceBounds.memory.step}
                size="small" aria-label={ws.resourceMemory} />
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="caption" color="text.secondary">{resourceBounds.memory.min} {common.gb}</Typography>
                <Typography variant="caption" color="text.secondary">{resourceBounds.memory.max} {common.gb}</Typography>
              </Stack>
            </Box>

            {/* Storage */}
            <Box className={styles.resourceBlock}>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Stack direction="row" alignItems="center" gap={1}>
                  <Storage className={styles.resourceIcon} sx={{ fontSize: 20 }} />
                  <Typography variant="body2">{ws.resourceStorage}</Typography>
                </Stack>
                <Typography className={styles.resourceValue}>{storageSize} {common.gb}</Typography>
              </Stack>
              <Slider value={storageSize} onChange={(_, v) => setStorageSize(v as number)}
                min={resourceBounds.storage.min} max={resourceBounds.storage.max} step={resourceBounds.storage.step}
                size="small" aria-label={ws.resourceStorage} />
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="caption" color="text.secondary">{resourceBounds.storage.min} {common.gb}</Typography>
                <Typography variant="caption" color="text.secondary">{resourceBounds.storage.max} {common.gb}</Typography>
              </Stack>
            </Box>

            <TextField label={ws.fieldMountPath} value={storageMountPath}
              onChange={(e) => setStorageMountPath(e.target.value)} size="small" helperText={ws.fieldMountPathHelper} />
          </Stack>
        </Box>

        {/* Settings */}
        <Box className={styles.section}>
          <Typography className={styles.sectionLabel}>{ws.sectionSettings}</Typography>
          <Stack gap={1}>
            <Box className={styles.settingRow}>
              <Typography variant="body2">Access</Typography>
              <ToggleButtonGroup
                value={accessType}
                exclusive
                onChange={(_, v) => {
                  if (v && typeof v === 'string') {
                    setAccessType(v as 'Public' | 'OwnerOnly');
                  }
                }}
                size="small"
                className={styles.toggleGroup}
              >
                <ToggleButton value="Public" className={styles.toggleButton}>
                  {common.public}
                </ToggleButton>
                <ToggleButton value="OwnerOnly" className={styles.toggleButton}>
                  {common.private}
                </ToggleButton>
              </ToggleButtonGroup>
            </Box>

            {showAccessStrategyField && (
              <>
                <Box className={styles.divider} />
                <TextField
                  label="Access Strategy"
                  value={accessStrategyName}
                  onChange={(e) => setAccessStrategyName(e.target.value)}
                  size="small"
                  helperText="Name of the WorkspaceAccessStrategy resource to use for routing"
                />
              </>
            )}

            <Box className={styles.divider} />

            <Box className={styles.settingRow}>
              <Box>
                <Typography variant="body2">{ws.idleShutdownEnable}</Typography>
                {idleShutdownEnabled && (
                  <Typography variant="caption" color="text.secondary">
                    Shutdown after {idleTimeoutMinutes} {common.min} of inactivity
                  </Typography>
                )}
              </Box>
              <Switch size="small" checked={idleShutdownEnabled} onChange={(e) => setIdleShutdownEnabled(e.target.checked)}
                inputProps={{ 'aria-label': ws.idleShutdownEnable }} />
            </Box>

            <Collapse in={idleShutdownEnabled}>
              <Box className={styles.resourceBlock}>
                <Slider value={idleTimeoutMinutes} onChange={(_, v) => setIdleTimeoutMinutes(v as number)}
                  min={idleShutdownBounds.min} max={idleShutdownBounds.max} step={IDLE_SHUTDOWN_DEFAULTS.STEP}
                  size="small" aria-label={ws.idleShutdownTimeout} />
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="caption" color="text.secondary">{idleShutdownBounds.min} {common.min}</Typography>
                  <Typography variant="caption" color="text.secondary">{idleShutdownBounds.max} {common.min}</Typography>
                </Stack>
              </Box>
            </Collapse>
          </Stack>
        </Box>

        {/* Actions */}
        <Stack direction="row" gap={2} className={styles.actions}>
          <Button variant="text" onClick={() => navigate('/')}>{common.cancel}</Button>
          <Button type="submit" variant="contained" disabled={!name || createMutation.isPending}
            className={styles.submitBtn}>
            {createMutation.isPending ? <CircularProgress size={20} color="inherit" /> : ws.createWorkspace}
          </Button>
        </Stack>
      </form>
    </Box>
  );
}
