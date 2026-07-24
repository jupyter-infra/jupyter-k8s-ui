import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Typography, TextField, Button, Stack, Container, Paper, Alert, CircularProgress } from '@mui/material';
import { useCreateWorkspace, useWorkspaces, useTemplates } from '../api';
import { useAuth } from '../context/AuthContext';
import { TemplatePicker } from '../components';
import { AdvancedBox } from '../components/workspace/AdvancedBox';
import { LockedTemplateField } from '../components/workspace/LockedTemplateField';
import { WorkspaceResourceForm, type WorkspaceFormValues } from '../components/workspace/WorkspaceResourceForm';
import { WorkspaceSpecEditor } from '../components/workspace/yaml-editor/WorkspaceSpecEditor';
import type { CreateWorkspaceRequest, DiscoveredTemplate } from '../types';
import { strings } from '../constants';
import { sanitizeK8sName, resolveTemplateControls, buildResourcesBlock, clamp } from '../utils';

function generateDefaults(username: string, existingCount: number) {
  const n = existingCount + 1;
  const displayName = n === 1 ? `${username}'s Workspace` : `${username}'s Workspace ${n}`;
  const name = sanitizeK8sName(displayName.replace(/'/g, ''));
  return { displayName, name };
}

// Which sliders the user has touched — untouched sliders reset to a new template's default
// on template switch; touched ones clamp into the new bounds (preserving intent).
interface Touched {
  cpu: boolean;
  memory: boolean;
  storage: boolean;
  image: boolean;
}

export function WorkspaceCreate() {
  const navigate = useNavigate();
  const createMutation = useCreateWorkspace();
  const { user } = useAuth();
  const { data: workspaces } = useWorkspaces();
  const templatesQuery = useTemplates();

  const defaults = useMemo(() => generateDefaults(user?.username ?? 'user', workspaces?.length ?? 0), [user?.username, workspaces?.length]);

  // Name/displayName are lifted here so they persist across the form <-> YAML toggle.
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [displayNameOverride, setDisplayNameOverride] = useState<string | null>(null);

  // Shared template selection — carried bidirectionally across the form ↔ YAML toggle.
  // `selectedTemplate === null` == the no-template card == the YAML editor's
  // "no template selected" (same null state).
  const [selectedTemplate, setSelectedTemplate] = useState<DiscoveredTemplate | null>(null);
  // Template name for the YAML editor's free-solo control. Kept in sync with
  // selectedTemplate but can also hold a typed name not in the discovered list.
  const [templateName, setTemplateName] = useState<string | null>(null);

  // Resolver-driven form values + touched tracking.
  const controls = useMemo(() => resolveTemplateControls(selectedTemplate), [selectedTemplate]);
  const [values, setValues] = useState<WorkspaceFormValues>(() => initialValues(resolveTemplateControls(null)));
  const touched = useRef<Touched>({ cpu: false, memory: false, storage: false, image: false });

  const [advanced, setAdvanced] = useState(false);

  const name = nameOverride ?? defaults.name;
  const displayName = displayNameOverride ?? defaults.displayName;

  // On template switch, reshape the slider values: touched sliders clamp into the new
  // bounds (keep intent); untouched reset to the new default. Image always resets to the
  // new template's default (a carried-over image is unlikely valid elsewhere).
  const prevControlsKey = useRef<string>('');
  useEffect(() => {
    const key = selectedTemplate ? `${selectedTemplate.metadata.namespace}/${selectedTemplate.metadata.name}` : '<none>';
    if (key === prevControlsKey.current) return;
    prevControlsKey.current = key;
    setValues((prev) => ({
      cpu: touched.current.cpu ? clamp(prev.cpu, controls.cpu.min, controls.cpu.max) : controls.cpu.default,
      memory: touched.current.memory ? clamp(prev.memory, controls.memory.min, controls.memory.max) : controls.memory.default,
      storage: touched.current.storage ? clamp(prev.storage, controls.storage.min, controls.storage.max) : controls.storage.default,
      image: controls.image.value,
      accessType: controls.accessType,
      idleEnabled: controls.idle.available ? controls.idle.enabledDefault : false,
      idleTimeout: controls.idle.available ? controls.idle.timeout.default : prev.idleTimeout,
    }));
  }, [selectedTemplate, controls]);

  const handleFieldChange = useCallback(<K extends keyof WorkspaceFormValues>(key: K, value: WorkspaceFormValues[K]) => {
    if (key === 'cpu' || key === 'memory' || key === 'storage' || key === 'image') {
      const touchedKey: keyof Touched = key;
      touched.current[touchedKey] = true;
    }
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleDisplayNameChange = useCallback(
    (value: string) => {
      setDisplayNameOverride(value);
      if (nameOverride === null) setNameOverride(sanitizeK8sName(value.replace(/'/g, '')));
    },
    [nameOverride],
  );

  const handleNameChange = useCallback((value: string) => setNameOverride(sanitizeK8sName(value)), []);

  // Picker → shared state. Also keep the YAML editor's templateName in sync.
  const handleSelectTemplate = useCallback((template: DiscoveredTemplate | null) => {
    setSelectedTemplate(template);
    setTemplateName(template?.metadata.name ?? null);
  }, []);

  // The picker's initial (auto-)selection — including the hidden-picker cases (0 templates,
  // or a single flagged default that's auto-used). Adopt it as the shared selection so the
  // resolver/submit see the injected default even when no card is shown.
  const initialAdopted = useRef(false);
  // When the picker is hidden because a single template is enforced (a flagged default),
  // show a read-only locked Template section in its place. Distinct from the 0-templates
  // hidden case, where there's genuinely no template to display.
  const [enforcedTemplate, setEnforcedTemplate] = useState<DiscoveredTemplate | null>(null);
  const handleInitialResolved = useCallback(({ selection, hidden }: { selection: DiscoveredTemplate | null; hidden: boolean }) => {
    if (initialAdopted.current) return;
    initialAdopted.current = true;
    setSelectedTemplate(selection);
    setTemplateName(selection?.metadata.name ?? null);
    if (hidden && selection) setEnforcedTemplate(selection);
  }, []);

  // YAML editor resolved a template (possibly a free-typed name) — mirror into shared state.
  const handleResolvedTemplateChange = useCallback((template: DiscoveredTemplate | null) => {
    setSelectedTemplate(template);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // WYSIWYG: send exactly what the form displays. Complete resources block so the
    // wholesale overlay doesn't wipe requests.
    const request: CreateWorkspaceRequest = {
      name,
      displayName: displayName || name,
      resources: buildResourcesBlock(controls, values.cpu, values.memory),
      storage: { size: `${values.storage}Gi` },
      accessType: values.accessType,
      ownershipType: controls.ownershipType, // not derived from accessType
    };

    // templateRef rides on the body (from selection, or a preserved unresolvable ref).
    if (controls.templateRef) request.templateRef = controls.templateRef;
    else if (selectedTemplate) request.templateRef = { name: selectedTemplate.metadata.name, namespace: selectedTemplate.metadata.namespace };

    // Image: only send when the form models it (free/select). Fixed/no-image → let the
    // template/operator supply it. Empty free-text (no-template) → omit.
    if (controls.image.mode !== 'fixed' && values.image) request.image = values.image;
    else if (controls.image.mode === 'fixed' && controls.image.value) request.image = controls.image.value;

    // Idle: send a COMPLETE block echoing the template's detection verbatim. Send it when
    // idle is available AND (the user enabled it OR the template default is enabled) — the
    // latter so an explicit toggle-OFF is honored: omitting the block lets the operator's
    // defaulter copy the template's enabled default back on, re-enabling idle against the
    // user's choice. No template / unavailable, or an untouched disabled default → omit.
    if (controls.idle.available && (values.idleEnabled || controls.idle.enabledDefault)) {
      request.idleShutdown = {
        enabled: values.idleEnabled,
        timeoutInMinutes: values.idleTimeout,
        ...(controls.idle.detection !== undefined && { detection: controls.idle.detection }),
      };
    }

    try {
      await createMutation.mutateAsync(request);
      navigate('/');
    } catch {
      // Error surfaced via createMutation.error
    }
  };

  // A workspace needs SOMETHING to supply its image: a templateRef (operator injects the
  // template's defaultImage) or an explicit image. The no-template + empty-image
  // intersection produces a workspace that can never start, so block submit on exactly
  // that case (template-backed free-image stays submittable — the operator fills it in).
  const willSendTemplateRef = Boolean(controls.templateRef || selectedTemplate);
  const willSendImage = (controls.image.mode !== 'fixed' && !!values.image) || (controls.image.mode === 'fixed' && !!controls.image.value);
  const unstartable = !willSendTemplateRef && !willSendImage;

  const { workspace: ws } = strings;

  const identitySection = (
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
  );

  return (
    <Container maxWidth="md">
      <Stack spacing={3} paddingBottom={8}>
        <Typography variant="h4" fontWeight={600}>
          {advanced ? ws.advancedCreateTitle : ws.createTitle}
        </Typography>

        {!advanced && createMutation.error && <Alert severity="error">{createMutation.error.message}</Alert>}

        {identitySection}

        {advanced ? (
          <WorkspaceSpecEditor
            mode="create"
            name={name}
            onNameChange={handleNameChange}
            displayName={displayName}
            onDisplayNameChange={handleDisplayNameChange}
            onSwitchToForm={() => setAdvanced(false)}
            templateName={templateName}
            onTemplateNameChange={setTemplateName}
            onResolvedTemplateChange={handleResolvedTemplateChange}
          />
        ) : (
          <Stack spacing={3} component="form" onSubmit={handleSubmit}>
            {/* Picker renders nothing when a single template is enforced; show a locked
                read-only Template section in its place. */}
            {enforcedTemplate ? (
              <LockedTemplateField label={enforcedTemplate.spec.displayName ?? enforcedTemplate.metadata.name} tooltip={ws.templateLockedTooltipCreate} />
            ) : (
              <TemplatePicker query={templatesQuery} selected={selectedTemplate} onSelect={handleSelectTemplate} onInitialResolved={handleInitialResolved} />
            )}

            <WorkspaceResourceForm
              controls={controls}
              values={values}
              onChange={handleFieldChange}
              imageError={unstartable ? ws.imageRequiredNoTemplate : undefined}
            />

            {/* Advanced box — toggle the YAML editor inline (keeps name/displayName above) */}
            <AdvancedBox onSwitchToYaml={() => setAdvanced(true)} />

            <Stack direction="row" spacing={2} justifyContent="flex-end">
              <Button variant="text" onClick={() => navigate('/')}>
                {strings.common.cancel}
              </Button>
              <Button type="submit" variant="contained" disabled={!name || unstartable || createMutation.isPending}>
                {createMutation.isPending ? <CircularProgress size={20} color="inherit" /> : ws.createWorkspace}
              </Button>
            </Stack>
          </Stack>
        )}
      </Stack>
    </Container>
  );
}

function initialValues(controls: ReturnType<typeof resolveTemplateControls>): WorkspaceFormValues {
  return {
    cpu: controls.cpu.default,
    memory: controls.memory.default,
    storage: controls.storage.default,
    image: controls.image.value,
    accessType: controls.accessType,
    idleEnabled: controls.idle.available ? controls.idle.enabledDefault : false,
    idleTimeout: controls.idle.available ? controls.idle.timeout.default : 30,
  };
}
