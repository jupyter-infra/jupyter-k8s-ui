// Simple (slider-based) workspace EDIT surface.
//
// Fetches the workspace + resolves its template from the shared useTemplates() cache (no
// by-name fetch), shows the template read-only, and renders the same resolver-driven
// controls as create — seeded from the CURRENT workspace spec, conformed to the template.
//
// Edit-specific behavior:
//   — preserve stored requests verbatim; send `resources` only when a cpu/mem slider
//     was touched OR a stored value drifted out of bounds.
//   — conform-on-load: clamp every modeled axis to the current template and disclose
//     each adjustment in one dismissable banner (forced by whole-spec revalidation).
//   — unresolvable templateRef (RBAC-invisible / deleted): seed from the stored spec,
//     NO guessed static bounds, preserve the ref, note "template not accessible".
//   — idle controls appear whenever the resolved template is idle-capable. With a stored
//     idleShutdown block they seed from its own values (echoing its own detection); without
//     one they seed OFF and save authors a block from the template's default detection. Save
//     always sends a complete block when idle is available, so a toggle-OFF sticks (omitting
//     it would let the operator's defaulter re-enable idle from the template default).
//   — storage read-only on edit.
//   Identity: name read-only (immutable); displayName editable.
//   Save: selective PATCH, no desiredStatus (stay Stopped), navigate to '/'.

import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Box, Button, CircularProgress, Paper, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { LockOutlined } from '@mui/icons-material';
import { useTemplates, useUpdateWorkspace } from '../../api';
import { ApiError } from '../../api/auth-interceptor';
import type { DiscoveredTemplate, UpdateWorkspaceRequest, Workspace } from '../../types';
import { strings } from '../../constants';
import {
  resolveTemplateControls,
  conformAxis,
  conformImage,
  computeCpuRequest,
  computeMemoryRequest,
  parseCpuCores,
  parseMemoryGi,
  type ConformAdjustment,
  type ResolvedTemplateControls,
} from '../../utils';
import { WorkspaceResourceForm, type WorkspaceFormValues } from './WorkspaceResourceForm';
import { LockedTemplateField } from './LockedTemplateField';
import { AdvancedBox } from './AdvancedBox';

interface SimpleWorkspaceEditorProps {
  workspace: Workspace;
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  onSwitchToYaml: () => void;
}

// Seed form values from the stored spec, conformed to the resolved controls. Returns the
// conformed values plus the list of adjustments for the disclosure banner.
function seedFromSpec(
  ws: Workspace,
  controls: ResolvedTemplateControls,
): { values: WorkspaceFormValues; adjustments: ConformAdjustment[]; hasIdleBlock: boolean } {
  const spec = ws.spec;
  const storedCpu = parseCpuCores(spec.resources?.limits?.cpu, controls.cpu.default);
  const storedMem = parseMemoryGi(spec.resources?.limits?.memory, controls.memory.default);
  const storedStorage = parseMemoryGi(spec.storage?.size, controls.storage.default);

  const cpu = conformAxis('cpu', storedCpu, controls.cpu, 'cores');
  const memory = conformAxis('memory', storedMem, controls.memory, 'GB');
  // Storage is read-only on edit — we don't clamp/conform it, just display the stored
  // value. (Any drift there is the operator's / #439's concern, surfaced by dry-run on save.)
  const image = conformImage(spec.image ?? '', controls.image);

  const adjustments = [...cpu.adjustments, ...memory.adjustments, ...image.adjustments];

  // Seed the idle toggle. With a stored idleShutdown block, seed from its own values
  // (conforming the timeout to the template bounds). Without one, seed OFF at the template's
  // default timeout — the user can still turn it on, and save authors a block from the
  // template's default detection. (idle controls render whenever the template is idle-capable.)
  const hasIdleBlock = spec.idleShutdown !== undefined;
  let idleEnabled = false;
  let idleTimeout = controls.idle.available ? controls.idle.timeout.default : 30;
  if (hasIdleBlock && spec.idleShutdown) {
    idleEnabled = spec.idleShutdown.enabled;
    const storedTimeout = spec.idleShutdown.idleTimeoutInMinutes ?? idleTimeout;
    if (controls.idle.available) {
      const conformed = conformAxis('idleTimeout', storedTimeout, controls.idle.timeout, 'min');
      idleTimeout = conformed.value;
      adjustments.push(...conformed.adjustments);
    } else {
      idleTimeout = storedTimeout;
    }
  }

  // Conform the ENABLED flag for a template that drifted to REQUIRE idle
  // (idleShutdownOverrides.allow=false + an enabled default). The operator's structural lock
  // rejects any workspace whose idleShutdown doesn't match the default except the timeout —
  // including a disabled or absent block — and the frozen toggle leaves the user no way to
  // fix it. Force it on and disclose the change, mirroring the image conform. (Reachable only
  // via drift: the operator wouldn't have admitted an off/absent block under this template.)
  if (controls.idle.available && controls.idle.toggleFrozen && controls.idle.enabledDefault && !idleEnabled) {
    adjustments.push({ field: 'idleEnabled', from: hasIdleBlock ? 'off' : 'unset', to: 'on' });
    idleEnabled = true;
  }

  return {
    values: {
      cpu: cpu.value,
      memory: memory.value,
      storage: storedStorage,
      image: image.value,
      accessType: spec.accessType ?? 'Public',
      idleEnabled,
      idleTimeout,
    },
    adjustments,
    hasIdleBlock,
  };
}

export function SimpleWorkspaceEditor({ workspace, displayName, onDisplayNameChange, onSwitchToYaml }: SimpleWorkspaceEditorProps) {
  const navigate = useNavigate();
  const { workspace: ws, common } = strings;
  const updateMutation = useUpdateWorkspace();
  const templatesQuery = useTemplates();

  const storedRef = workspace.spec.templateRef;

  // Resolve the workspace's template from the shared cache (match on name + namespace).
  // Unresolvable (RBAC-invisible / deleted) → null template but preserve the ref.
  const resolvedTemplate = useMemo<DiscoveredTemplate | null>(() => {
    if (!storedRef) return null;
    const items = templatesQuery.data?.items ?? [];
    return items.find((t) => t.metadata.name === storedRef.name && (storedRef.namespace === undefined || t.metadata.namespace === storedRef.namespace)) ?? null;
  }, [storedRef, templatesQuery.data]);

  // Ref set but not found in the discoverable list → treat as unresolvable.
  const refUnresolvable = Boolean(storedRef) && resolvedTemplate === null && !templatesQuery.isLoading;

  const controls = useMemo(
    () => resolveTemplateControls(resolvedTemplate, refUnresolvable && storedRef ? storedRef : undefined),
    [resolvedTemplate, refUnresolvable, storedRef],
  );

  // Seed once from the stored spec (recomputed if the resolved template arrives late).
  const seed = useMemo(() => seedFromSpec(workspace, controls), [workspace, controls]);
  const [values, setValues] = useState<WorkspaceFormValues>(seed.values);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Track which resource sliders the user actually moved (only send `resources` when a
  // slider was touched or a value drifted).
  const [resourcesTouched, setResourcesTouched] = useState(false);

  // If the template resolves after first render, re-seed once.
  const seededKey = useMemo(
    () => (resolvedTemplate ? `${resolvedTemplate.metadata.namespace}/${resolvedTemplate.metadata.name}` : refUnresolvable ? '<unresolvable>' : '<pending>'),
    [resolvedTemplate, refUnresolvable],
  );
  const [lastSeededKey, setLastSeededKey] = useState<string>(() => seededKey);
  if (seededKey !== lastSeededKey && !templatesQuery.isLoading) {
    setLastSeededKey(seededKey);
    setValues(seed.values);
  }

  const handleFieldChange = useCallback(<K extends keyof WorkspaceFormValues>(key: K, value: WorkspaceFormValues[K]) => {
    if (key === 'cpu' || key === 'memory') setResourcesTouched(true);
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const templateLabel = storedRef
    ? refUnresolvable
      ? ws.templateCustomUnresolved(storedRef.name)
      : (resolvedTemplate?.spec.displayName ?? storedRef.name)
    : ws.templateNoTemplateName;

  // build `resources` only if a slider was touched OR the seed conformed a resource
  // (adjustments prove a stored value drifted out of bounds and must be re-sent).
  const resourcesDrifted = seed.adjustments.some((a) => a.field === 'cpu' || a.field === 'memory');
  const shouldSendResources = resourcesTouched || resourcesDrifted;

  const handleSave = useCallback(async () => {
    setSaveError(null);
    const request: UpdateWorkspaceRequest = { displayName: displayName || workspace.metadata.name };

    // Re-send the existing templateRef unchanged (template is locked on simple edit).
    if (storedRef) request.templateRef = storedRef;

    // Access toggle drives accessType only; ownership left untouched (not sent).
    request.accessType = values.accessType;

    if (shouldSendResources) {
      // Preserve stored requests verbatim UNLESS the template dictates them; the slider
      // only ever set the limit. computeCpuRequest returns the template value for the
      // 'template' policy, else the ratio — but on edit we prefer the STORED request when
      // present and the policy is ratio, so a hand-tuned request survives.
      const storedCpuReq = workspace.spec.resources?.requests?.cpu;
      const storedMemReq = workspace.spec.resources?.requests?.memory;
      const cpuReq =
        controls.requestsPolicy.cpu.source === 'template'
          ? computeCpuRequest(controls.requestsPolicy.cpu, values.cpu)
          : (storedCpuReq ?? computeCpuRequest(controls.requestsPolicy.cpu, values.cpu));
      const memReq =
        controls.requestsPolicy.memory.source === 'template'
          ? computeMemoryRequest(controls.requestsPolicy.memory, values.memory)
          : (storedMemReq ?? computeMemoryRequest(controls.requestsPolicy.memory, values.memory));
      request.resources = {
        requests: { cpu: cpuReq, memory: memReq },
        limits: { cpu: `${values.cpu}`, memory: `${values.memory}Gi` },
      };
    }

    // Image: send whenever the (possibly conformed) value differs from what's stored —
    // including the FIXED mode. conform-on-load can rewrite a drifted stored image to the
    // template's current defaultImage and disclose it in the banner; the operator's
    // whole-spec revalidation then rejects the save unless we actually send that new image.
    if (values.image && values.image !== workspace.spec.image) {
      request.image = values.image;
    }

    // Idle: whenever the template is idle-capable, send a COMPLETE block reflecting the
    // toggle — even for a workspace that had no stored idleShutdown. This lets the user turn
    // idle ON (we author the block from the template's default detection) and, just as
    // importantly, makes an explicit toggle-OFF stick: omitting the block would let the
    // operator's defaulter copy the template's enabled default back on.
    //
    // Detection source: the workspace's own block when it has one (preserve verbatim), else
    // the template's default detection — the CRD requires detection whenever idleShutdown is
    // present, and the UI never authors detection itself.
    if (controls.idle.available) {
      const detection = workspace.spec.idleShutdown?.detection ?? controls.idle.detection;
      request.idleShutdown = {
        enabled: values.idleEnabled,
        timeoutInMinutes: values.idleTimeout,
        ...(detection !== undefined && { detection }),
      };
    }

    try {
      await updateMutation.mutateAsync({ name: workspace.metadata.name, data: request });
      navigate('/');
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? (err.details ? `${err.message}: ${err.details}` : err.message) : err instanceof Error ? err.message : 'Save failed',
      );
    }
  }, [displayName, workspace, storedRef, values, shouldSendResources, controls, updateMutation, navigate]);

  const showBanner = seed.adjustments.length > 0 && !bannerDismissed;

  return (
    <Stack spacing={3}>
      {saveError && <Alert severity="error">{saveError}</Alert>}

      {showBanner && <ConformBanner adjustments={seed.adjustments} onDismiss={() => setBannerDismissed(true)} />}

      {refUnresolvable && <Alert severity="info">{ws.templateNotAccessible}</Alert>}

      {/* Identity — name read-only, displayName editable */}
      <Paper variant="outlined">
        <Stack spacing={2} padding={3}>
          {/* Wrap in a span: a disabled input swallows hover events, so the Tooltip
              needs a non-disabled element to anchor to. */}
          <Tooltip title={ws.nameLockedTooltip}>
            <span>
              <TextField
                label={ws.fieldName}
                value={workspace.metadata.name}
                size="small"
                fullWidth
                disabled
                slotProps={{ input: { readOnly: true, endAdornment: <LockOutlined color="disabled" fontSize="small" /> } }}
              />
            </span>
          </Tooltip>
          <TextField label={ws.fieldDisplayName} value={displayName} onChange={(e) => onDisplayNameChange(e.target.value)} size="small" fullWidth />
        </Stack>
      </Paper>

      {/* Template — read-only (locked; change via YAML editor) */}
      <LockedTemplateField label={templateLabel} tooltip={ws.templateLockedTooltipEdit} />

      <WorkspaceResourceForm controls={controls} values={values} onChange={handleFieldChange} storageReadOnly />

      {/* Advanced box — switch to the YAML editor (symmetric with the create page) */}
      <AdvancedBox onSwitchToYaml={onSwitchToYaml} />

      <Stack direction="row" spacing={2} justifyContent="flex-end">
        <Button variant="text" onClick={() => navigate('/')}>
          {common.cancel}
        </Button>
        <Button variant="contained" onClick={handleSave} disabled={updateMutation.isPending}>
          {updateMutation.isPending ? <CircularProgress size={20} color="inherit" /> : ws.editSave}
        </Button>
      </Stack>
    </Stack>
  );
}

function ConformBanner({ adjustments, onDismiss }: { adjustments: ConformAdjustment[]; onDismiss: () => void }) {
  const { workspace: ws } = strings;
  const line = (a: ConformAdjustment): string => {
    switch (a.field) {
      case 'cpu':
        return ws.editConformCpu(a.from, a.to);
      case 'memory':
        return ws.editConformMemory(a.from, a.to);
      case 'storage':
        return ws.editConformStorage(a.from, a.to);
      case 'image':
        return ws.editConformImage(a.from, a.to);
      case 'idleTimeout':
        return ws.editConformIdleTimeout(a.from, a.to);
      case 'idleEnabled':
        return ws.editConformIdleEnabled;
    }
  };
  return (
    <Alert severity="warning" onClose={onDismiss}>
      <Typography variant="body2" fontWeight={600}>
        {ws.editConformTitle}
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2 }}>
        {adjustments.map((a, i) => (
          <li key={i}>
            <Typography variant="caption">{line(a)}</Typography>
          </li>
        ))}
      </Box>
    </Alert>
  );
}
