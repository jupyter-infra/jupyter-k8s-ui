// Shared, presentational resource controls used by BOTH simple-create and simple-edit.
//
// Takes resolved template controls + current values + onChange, and renders the four
// resolver-driven control groups (sliders / image / access toggle / idle). Each page owns
// its own chrome (picker vs. read-only template, name fields, banners) and its own resolver
// + submit logic — this component is deliberately dumb.
//
// Decisions embedded here:
// - one toggle drives accessType only
// - storage read-only on edit
// - idle three states:
//   - Unavailable → no controls
//   - Structure-locked → toggle disabled, timeout editable
//   - Interactive → both editable

import {
  Typography,
  TextField,
  MenuItem,
  Slider,
  Switch,
  Stack,
  Paper,
  Collapse,
  Divider,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Autocomplete,
} from '@mui/material';
import { Memory, Storage, LockOutlined } from '@mui/icons-material';
import { ResourceSlider } from '../ui/ResourceSlider';
import { strings } from '../../constants';
import type { ResolvedTemplateControls } from '../../utils';

export interface WorkspaceFormValues {
  cpu: number;
  memory: number;
  storage: number;
  image: string;
  accessType: 'Public' | 'OwnerOnly';
  idleEnabled: boolean;
  idleTimeout: number;
}

interface WorkspaceResourceFormProps {
  controls: ResolvedTemplateControls;
  values: WorkspaceFormValues;
  onChange: <K extends keyof WorkspaceFormValues>(key: K, value: WorkspaceFormValues[K]) => void;
  // storage is editable on create, read-only on edit (PVC resize isn't webhook-
  // validated — dry-run isn't authoritative for it).
  storageReadOnly?: boolean;
  // Blocking error on the image field (e.g. no-template + empty image = unstartable). Only
  // meaningful for the free/select modes; fixed images can't be empty when a template drives them.
  imageError?: string;
}

export function WorkspaceResourceForm({ controls, values, onChange, storageReadOnly = false, imageError }: WorkspaceResourceFormProps) {
  const { workspace: ws, common } = strings;

  return (
    <Stack spacing={3}>
      {/* Image */}
      {controls.image.mode !== 'fixed' ? (
        <Paper variant="outlined">
          <Stack spacing={2} padding={3}>
            <Typography variant="subtitle2">{ws.sectionEnvironment}</Typography>
            {controls.image.mode === 'select' ? (
              <TextField
                select
                label={ws.fieldImage}
                value={values.image}
                onChange={(e) => onChange('image', e.target.value)}
                size="small"
                fullWidth
                error={Boolean(imageError)}
                helperText={imageError}
              >
                {controls.image.options.map((img) => (
                  <MenuItem key={img} value={img}>
                    {img}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              // Free entry: a free-solo combobox that suggests the template's curated
              // images (options) but still accepts any typed value. With no options it
              // degrades to a plain text field.
              <Autocomplete
                freeSolo
                options={controls.image.options}
                value={values.image}
                onInputChange={(_, v) => onChange('image', v)}
                size="small"
                fullWidth
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={ws.fieldImage}
                    placeholder={ws.fieldImagePlaceholder}
                    error={Boolean(imageError)}
                    helperText={imageError ?? ws.fieldImageHelper}
                  />
                )}
              />
            )}
          </Stack>
        </Paper>
      ) : (
        <Paper variant="outlined">
          <Stack spacing={1} padding={3}>
            <Typography variant="subtitle2">{ws.sectionEnvironment}</Typography>
            {/* Wrap in a span: a disabled input swallows hover events, so the Tooltip
                needs a non-disabled element to anchor to. */}
            <Tooltip title={ws.imageLockedTooltip}>
              <span>
                <TextField
                  label={ws.fieldImage}
                  value={values.image}
                  size="small"
                  fullWidth
                  slotProps={{
                    input: {
                      readOnly: true,
                      endAdornment: <LockOutlined color="disabled" fontSize="small" />,
                    },
                  }}
                  disabled
                />
              </span>
            </Tooltip>
          </Stack>
        </Paper>
      )}

      {/* Resources */}
      <Paper variant="outlined">
        <Stack spacing={2} padding={3}>
          <Typography variant="subtitle2">{ws.sectionResources}</Typography>
          <ResourceSlider
            icon={<Memory color="action" fontSize="small" />}
            label={ws.resourceCpu}
            value={values.cpu}
            unit={common.cores}
            min={controls.cpu.min}
            max={controls.cpu.max}
            step={controls.cpu.step}
            onChange={(v) => onChange('cpu', v)}
          />
          <ResourceSlider
            icon={<Storage color="action" fontSize="small" />}
            label={ws.resourceMemory}
            value={values.memory}
            unit={common.gb}
            min={controls.memory.min}
            max={controls.memory.max}
            step={controls.memory.step}
            onChange={(v) => onChange('memory', v)}
          />
          {storageReadOnly ? (
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Stack direction="row" alignItems="center" spacing={1}>
                <Storage color="action" fontSize="small" />
                <Typography variant="body2">{ws.resourceStorage}</Typography>
                <Tooltip title={ws.storageLockedTooltip}>
                  <LockOutlined color="disabled" fontSize="small" />
                </Tooltip>
              </Stack>
              <Typography variant="body2" fontFamily="monospace" fontWeight={600} color="text.secondary">
                {values.storage} {common.gb}
              </Typography>
            </Stack>
          ) : (
            <ResourceSlider
              icon={<Storage color="action" fontSize="small" />}
              label={ws.resourceStorage}
              value={values.storage}
              unit={common.gb}
              min={controls.storage.min}
              max={controls.storage.max}
              step={controls.storage.step}
              onChange={(v) => onChange('storage', v)}
            />
          )}
        </Stack>
      </Paper>

      {/* Access + Idle */}
      <Paper variant="outlined">
        <Stack spacing={1} padding={3}>
          <Typography variant="subtitle2">{ws.sectionSettings}</Typography>

          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="body2">{ws.accessQuestion}</Typography>
            <ToggleButtonGroup
              value={values.accessType}
              exclusive
              onChange={(_, v) => {
                if (v) onChange('accessType', v);
              }}
              size="small"
            >
              <ToggleButton value="Public">{common.public}</ToggleButton>
              <ToggleButton value="OwnerOnly">{common.private}</ToggleButton>
            </ToggleButtonGroup>
          </Stack>

          {controls.idle.available && (
            <>
              <Divider />
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Stack>
                  <Stack direction="row" alignItems="center" spacing={0.5}>
                    <Typography variant="body2">{ws.idleShutdownEnable}</Typography>
                    {/* Template locks the on/off structure (idleShutdownOverrides.allow=false):
                        the toggle is frozen ON. A disabled Switch swallows hover, so anchor the
                        tooltip to the lock icon beside the label. */}
                    {controls.idle.toggleFrozen && (
                      <Tooltip title={ws.idleShutdownLockedTooltip}>
                        <LockOutlined color="disabled" fontSize="small" data-testid="idle-locked-icon" />
                      </Tooltip>
                    )}
                  </Stack>
                  {values.idleEnabled && (
                    <Typography variant="caption" color="text.secondary">
                      Shutdown after {values.idleTimeout} {common.min} of inactivity
                    </Typography>
                  )}
                </Stack>
                <Switch
                  size="small"
                  checked={values.idleEnabled}
                  disabled={controls.idle.toggleFrozen}
                  onChange={(e) => onChange('idleEnabled', e.target.checked)}
                  slotProps={{ input: { 'aria-label': ws.idleShutdownEnable } }}
                />
              </Stack>
              <Collapse in={values.idleEnabled}>
                <Stack spacing={0.5} paddingTop={1}>
                  <Slider
                    value={values.idleTimeout}
                    onChange={(_, v) => onChange('idleTimeout', v as number)}
                    min={controls.idle.timeout.min}
                    max={controls.idle.timeout.max}
                    step={controls.idle.timeout.step}
                    disabled={controls.idle.timeout.min === controls.idle.timeout.max}
                    size="small"
                    aria-label={ws.idleShutdownTimeout}
                  />
                  <Stack direction="row" justifyContent="space-between">
                    <Typography variant="caption" color="text.secondary">
                      {controls.idle.timeout.min} {common.min}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {controls.idle.timeout.max} {common.min}
                    </Typography>
                  </Stack>
                </Stack>
              </Collapse>
            </>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
