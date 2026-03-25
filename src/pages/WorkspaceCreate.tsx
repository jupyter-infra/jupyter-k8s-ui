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
import { clamp, parseResourceValue, sanitizeK8sName } from '../utils';
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
  const [idleShutdownEnabled, setIdleShutdownEnabled] = useState(false);
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState<number>(IDLE_SHUTDOWN_DEFAULTS.DEFAULT_TIMEOUT);

  const resourceBounds = useMemo(() => {
    if (!selectedTemplate?.resourceBounds) return defaultResourceBounds;
    const tb = selectedTemplate.resourceBounds;
    return {
      cpu: {
        min: parseResourceValue(tb.cpu?.min, defaultResourceBounds.cpu.min),
        max: parseResourceValue(tb.cpu?.max, defaultResourceBounds.cpu.max),
        step: defaultResourceBounds.cpu.step,
      },
      memory: {
        min: parseResourceValue(tb.memory?.min, defaultResourceBounds.memory.min),
        max: parseResourceValue(tb.memory?.max, defaultResourceBounds.memory.max),
        step: defaultResourceBounds.memory.step,
      },
      storage: selectedTemplate.storageConfig ? {
        min: parseResourceValue(selectedTemplate.storageConfig.minSize, defaultResourceBounds.storage.min),
        max: parseResourceValue(selectedTemplate.storageConfig.maxSize, defaultResourceBounds.storage.max),
        step: defaultResourceBounds.storage.step,
      } : defaultResourceBounds.storage,
    };
  }, [selectedTemplate]);

  const idleShutdownBounds = useMemo(() => ({
    min: selectedTemplate?.idleShutdown?.minTimeoutMinutes ?? IDLE_SHUTDOWN_DEFAULTS.MIN_TIMEOUT,
    max: selectedTemplate?.idleShutdown?.maxTimeoutMinutes ?? IDLE_SHUTDOWN_DEFAULTS.MAX_TIMEOUT,
  }), [selectedTemplate]);

  const availableImages = useMemo(() => {
    if (selectedTemplate?.allowedImages?.length) {
      return selectedTemplate.allowedImages.map((img) => ({ value: img, label: img, description: '' }));
    }
    if (selectedTemplate && !selectedTemplate.allowCustomImages) {
      return [{ value: selectedTemplate.defaultImage, label: selectedTemplate.defaultImage, description: '' }];
    }
    return [...imageOptions];
  }, [selectedTemplate]);

  const selectedImageValue = useMemo(() => {
    return availableImages.find((img) => img.value === image) ?? { value: image, label: image, description: '' };
  }, [availableImages, image]);

  const allowCustomImages = !selectedTemplate || selectedTemplate.allowCustomImages;

  const handleTemplateSelect = useCallback((template: WorkspaceTemplate) => {
    setSelectedTemplate(template);
    setImage(template.defaultImage);

    const b = template.resourceBounds;
    const cpuB = { min: parseResourceValue(b?.cpu?.min, 0.5), max: parseResourceValue(b?.cpu?.max, 8) };
    const memB = { min: parseResourceValue(b?.memory?.min, 1), max: parseResourceValue(b?.memory?.max, 16) };
    const storB = template.storageConfig
      ? { min: parseResourceValue(template.storageConfig.minSize, 5), max: parseResourceValue(template.storageConfig.maxSize, 100) }
      : { min: 5, max: 100 };

    if (template.defaultResources) {
      setCpuLimit(clamp(parseResourceValue(template.defaultResources.cpu, 1), cpuB.min, cpuB.max));
      setMemoryLimit(clamp(parseResourceValue(template.defaultResources.memory, 2), memB.min, memB.max));
    }
    if (template.storageConfig?.defaultSize) {
      setStorageSize(clamp(parseResourceValue(template.storageConfig.defaultSize, 10), storB.min, storB.max));
    }
    if (template.storageConfig?.mountPath) setStorageMountPath(template.storageConfig.mountPath);
    if (template.defaultAccessType) setAccessType(template.defaultAccessType as 'Public' | 'OwnerOnly');
    if (template.idleShutdown) {
      setIdleShutdownEnabled(template.idleShutdown.enabled);
      const idleB = { min: template.idleShutdown.minTimeoutMinutes ?? 5, max: template.idleShutdown.maxTimeoutMinutes ?? 480 };
      setIdleTimeoutMinutes(clamp(template.idleShutdown.defaultTimeoutMinutes ?? 30, idleB.min, idleB.max));
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
      accessStrategy: { name: 'sample-access-strategy', namespace: 'default' },
    };

    if (selectedTemplate) {
      request.templateRef = { name: selectedTemplate.name, namespace: selectedTemplate.namespace };
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
                <TemplateCard key={t.name} template={t} selected={selectedTemplate?.name === t.name}
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
