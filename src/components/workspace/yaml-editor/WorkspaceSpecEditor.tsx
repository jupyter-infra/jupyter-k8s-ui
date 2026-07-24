import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Typography, TextField, Button, Stack, Paper, Alert, CircularProgress, Box, Link } from '@mui/material';
import type { editor } from 'monaco-editor';
import { useWorkspace, useCrdSchema, useCreateWorkspaceAdvanced, useReplaceWorkspaceAdvanced } from '../../../api';
import { apiClient, type ValidationResult } from '../../../api/client';
import { ApiError } from '../../../api/auth-interceptor';
import { useAuth } from '../../../context';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { TemplateSelect } from './TemplateSelect';
import { TemplateGuidancePanel } from './TemplateGuidancePanel';
import { ValidationStatus } from './ValidationStatus';
import type { AdvancedWorkspacePayload, WorkspaceSpec, DiscoveredTemplate } from '../../../types';
import { strings } from '../../../constants';
import { sanitizeK8sName, specToYaml, yamlToSpec, buildCreateScaffold, getWorkspaceOwner, getWorkspaceStatus, isOwner } from '../../../utils';

// Lazy-load the Monaco editor: it (plus its language workers) is a large dependency
// only needed here, so keep it out of the main bundle.
const YamlEditor = lazy(() => import('./YamlEditor').then((m) => ({ default: m.YamlEditor })));

// Fields edited via the dedicated controls above the editor, NOT in the YAML buffer.
// We strip these from the schema's top-level `required` before handing it to
// monaco-yaml — otherwise the CRD's `required: ['displayName']` makes the language
// worker flag "Missing property displayName" and block Save, even though the control
// supplies it on submit (see buildPayload). templateRef isn't required by the CRD but
// is listed here for the same single-home reason.
const CONTROL_OWNED_FIELDS = ['displayName', 'templateRef'];

// Return a copy of the CRD spec schema with control-owned fields removed from the
// top-level `required` array, so the editor doesn't demand fields the buffer no longer
// holds. Leaves the property definitions intact (so a user who does type them still
// gets validation/completion) and doesn't touch nested schemas.
function schemaWithoutControlRequired(schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!schema) return schema;
  const required = schema.required;
  if (!Array.isArray(required)) return schema;
  const filtered = required.filter((k) => !CONTROL_OWNED_FIELDS.includes(k as string));
  if (filtered.length === required.length) return schema;
  return { ...schema, required: filtered };
}

interface SaveError {
  message: string;
  details?: string;
}

// A full-page notice shown in place of the editor when the workspace can't be edited —
// load failed, not the owner, or not Stopped. Keeps those exit paths consistent.
function EditNotice({ title, message, onBack, backLabel }: { title?: string; message: string; onBack: () => void; backLabel: string }) {
  return (
    <Stack spacing={2} paddingBottom={8}>
      <Alert severity={title ? 'warning' : 'error'}>
        {title && (
          <Typography variant="body2" fontWeight={600}>
            {title}
          </Typography>
        )}
        <Typography variant="body2">{message}</Typography>
      </Alert>
      <Box>
        <Button variant="outlined" onClick={onBack}>
          {backLabel}
        </Button>
      </Box>
    </Stack>
  );
}

export interface WorkspaceSpecEditorProps {
  mode: 'create' | 'edit';
  /** Resource name (controlled). On edit this is frozen (K8s names are immutable). */
  name: string;
  onNameChange: (value: string) => void;
  /** Display name (controlled). Hoisted out of the YAML buffer into a structured field. */
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  /**
   * The immutable resource name used to fetch the workspace on edit. Kept separate from
   * `name` so the fetch key never depends on the (theoretically mutable) name state.
   */
  routeName?: string;
  /**
   * Whether this component renders the Name/DisplayName fields itself. The inline
   * create toggle renders them once above the form/YAML views and shares them, so it
   * passes `false`; the standalone edit page passes `true`.
   */
  renderIdentityFields?: boolean;
  /**
   * Inline create only: switch back to the simple slider form. When provided, a
   * "Simple form" button is shown; the editor confirms discard first if the buffer is
   * dirty, so unsaved YAML isn't silently lost.
   */
  onSwitchToForm?: () => void;
  /**
   * Inline create only: controlled template selection, lifted to the create page so the
   * choice carries bidirectionally across the form ↔ YAML toggle. When
   * provided, the editor uses these instead of its own internal template state. The
   * `<no-template>` card and "no template selected" here are the SAME null state.
   */
  templateName?: string | null;
  onTemplateNameChange?: (value: string | null) => void;
  onResolvedTemplateChange?: (template: DiscoveredTemplate | null) => void;
}

// The YAML-editing surface shared by the inline create toggle and the edit page. The
// buffer holds ONLY the CR `spec`; `name`, `displayName`, and `templateRef` are edited
// via dedicated controls, never in the buffer.
export function WorkspaceSpecEditor({
  mode,
  name,
  onNameChange,
  displayName,
  onDisplayNameChange,
  routeName,
  renderIdentityFields = false,
  onSwitchToForm,
  templateName,
  onTemplateNameChange,
  onResolvedTemplateChange,
}: WorkspaceSpecEditorProps) {
  const navigate = useNavigate();
  const isEdit = mode === 'edit';
  const { workspace: ws, common } = strings;
  // When the parent lifts template state (inline create), use the controlled values;
  // otherwise fall back to the editor's own internal state (edit page / standalone).
  const templateControlled = onTemplateNameChange !== undefined;

  // --- Data ---
  const { data: rawSchema } = useCrdSchema('workspaces');
  // Drop control-owned fields (displayName/templateRef) from the schema's `required`
  // so the buffer isn't flagged for a field the editor no longer holds.
  const schema = useMemo(() => schemaWithoutControlRequired(rawSchema), [rawSchema]);
  const { data: existing, isLoading: loadingExisting, error: loadError } = useWorkspace(isEdit ? (routeName ?? '') : '');
  const { user } = useAuth();
  const createMutation = useCreateWorkspaceAdvanced();
  const replaceMutation = useReplaceWorkspaceAdvanced();

  // `templateRef` lives outside the buffer as a structured control: keeping it here
  // lets a template change be a discrete event we react to (guidance panel + scaffold
  // regeneration) without re-parsing YAML on every keystroke. `resolvedTemplate` is the
  // full template the dropdown resolved to (null = none / not discoverable).
  const [internalTemplateRef, setInternalTemplateRef] = useState<string | null>(null);
  const [resolvedTemplate, setResolvedTemplate] = useState<DiscoveredTemplate | null>(null);
  // The active templateRef name: controlled by the parent when lifted, else internal.
  const templateRef = templateControlled ? (templateName ?? null) : internalTemplateRef;
  const setTemplateRef = useCallback(
    (value: string | null) => {
      if (templateControlled) onTemplateNameChange!(value);
      else setInternalTemplateRef(value);
    },
    [templateControlled, onTemplateNameChange],
  );

  // The editor buffer. Create starts from a self-documenting scaffold (required fields
  // active, others commented); edit seeds from the fetched spec (below).
  const [yamlText, setYamlText] = useState(() => (isEdit ? '' : buildCreateScaffold(null, ws.advancedHintDocsUrl)));
  const [seeded, setSeeded] = useState(isEdit ? false : true);
  // Whether the user has hand-edited the buffer. We can't detect this by string-comparing
  // against the last scaffold (Monaco normalizes content on mount, firing a spurious
  // change), so we flip it only on genuine keystrokes via YamlEditor's `isUserEdit` flag.
  // While false, picking a template regenerates the scaffold with its defaults; once
  // true, we prompt before regenerating so we never silently clobber the user's work.
  const [dirty, setDirty] = useState(false);

  // --- Validation state ---
  const [markers, setMarkers] = useState<editor.IMarker[]>([]);
  const [dryRun, setDryRun] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [saveError, setSaveError] = useState<SaveError | null>(null);

  // --- Confirm dialogs (dirty-buffer guards) ---
  const [pendingRegenTemplate, setPendingRegenTemplate] = useState<DiscoveredTemplate | null>(null);
  const [regenDialogOpen, setRegenDialogOpen] = useState(false);
  const [discardAction, setDiscardAction] = useState<null | (() => void)>(null);

  // Warn on tab/browser close while there are unsaved edits. (In-app navigation is
  // guarded explicitly on Cancel / switch-to-form below — the app uses a component
  // router, so React Router's data-router `useBlocker` isn't available here.)
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // On edit, seed the buffer once from the workspace's stored (resolved) spec. We lift
  // `templateRef` and `displayName` OUT into their controls so there's a single home for
  // each, then strip them from the YAML. Guarded by `seeded` so polling refetches don't
  // clobber in-progress edits.
  useEffect(() => {
    if (isEdit && existing && !seeded) {
      const spec = { ...existing.spec } as WorkspaceSpec;
      setTemplateRef(spec.templateRef?.name ?? null);
      // Fall back to the resource name when the stored spec has no displayName, matching
      // how the detail/card views render (`displayName ?? name`) — so the field is never
      // left blank on edit.
      onDisplayNameChange(spec.displayName ?? existing.metadata.name);
      onNameChange(existing.metadata.name);
      delete spec.templateRef;
      delete spec.displayName;
      setYamlText(specToYaml(spec as Record<string, unknown>));
      setSeeded(true);
    }
  }, [isEdit, existing, seeded, onDisplayNameChange, onNameChange, setTemplateRef]);

  // When a template resolves in the dropdown, the guidance panel always updates. The
  // buffer only regenerates from its defaults while pristine; if the user has edited,
  // we prompt before discarding their work (create only; edit seeds from the spec).
  const handleTemplateResolved = useCallback(
    (tmpl: DiscoveredTemplate | null) => {
      setResolvedTemplate(tmpl);
      onResolvedTemplateChange?.(tmpl);
      if (isEdit) return;
      if (!dirty) {
        setYamlText(buildCreateScaffold(tmpl, ws.advancedHintDocsUrl));
      } else {
        setPendingRegenTemplate(tmpl);
        setRegenDialogOpen(true);
      }
    },
    [isEdit, dirty, ws.advancedHintDocsUrl, onResolvedTemplateChange],
  );

  const confirmRegen = useCallback(() => {
    setYamlText(buildCreateScaffold(pendingRegenTemplate, ws.advancedHintDocsUrl));
    setDirty(false);
    setDryRun(null);
    setSaveError(null);
    setRegenDialogOpen(false);
    setPendingRegenTemplate(null);
  }, [pendingRegenTemplate, ws.advancedHintDocsUrl]);

  const cancelRegen = useCallback(() => {
    setRegenDialogOpen(false);
    setPendingRegenTemplate(null);
  }, []);

  // `parsed` is the live YAML→spec parse; `parsed.error` is a syntax error (if any).
  // monaco-yaml reports CRD-schema violations at severity Warning (4), NOT Error (8),
  // so we gate on severity >= Warning, else a schema-invalid manifest would slip into Save.
  const parsed = useMemo(() => yamlToSpec(yamlText), [yamlText]);
  const schemaHasErrors = markers.some((m) => m.severity >= 4 /* monaco MarkerSeverity.Warning */);
  const syntaxError = parsed.error;

  // Advisory, non-blocking hint: the typed image isn't in the template's allowed list.
  // The authoritative check is the server dry-run, so this never disables Save.
  const imageWarning = useMemo(() => {
    if (!resolvedTemplate || resolvedTemplate.spec.allowCustomImages) return null;
    const image = parsed.spec?.image;
    const allowed = resolvedTemplate.spec.allowedImages ?? (resolvedTemplate.spec.defaultImage ? [resolvedTemplate.spec.defaultImage] : []);
    if (!image || allowed.length === 0 || allowed.includes(image)) return null;
    return ws.advancedImageNotAllowed(resolvedTemplate.metadata.name);
  }, [resolvedTemplate, parsed.spec?.image, ws]);

  // Edit-only caution: switching the template on an EXISTING workspace can request changes
  // K8s can't satisfy (e.g. a PVC can never shrink; growth depends on the StorageClass).
  // We don't restrict the switch (advanced mode mirrors kubectl), just surface it,
  // and only when the selected templateRef actually differs from the workspace's stored value,
  // so opening YAML for unrelated edits doesn't nag the user.
  // Create needs no warning (no existing volume); simple edit locks the template
  // so a switch can't originate there.
  const storedTemplateRef = existing?.spec.templateRef?.name ?? null;
  const templateSwitched = isEdit && seeded && templateRef !== storedTemplateRef;

  // A genuine user edit invalidates the last dry-run result and marks the buffer dirty.
  const handleYamlChange = useCallback((value: string, isUserEdit: boolean) => {
    setYamlText(value);
    setDryRun(null);
    setSaveError(null);
    if (isUserEdit) setDirty(true);
  }, []);

  // Recombine the out-of-buffer controls (name, displayName, templateRef) with the
  // parsed spec into the wire payload. The controls are authoritative for their fields
  // (single home), so `displayName` from the control overwrites any stray buffer value.
  const buildPayload = useCallback((): AdvancedWorkspacePayload | null => {
    if (!parsed.spec) return null;
    const spec: WorkspaceSpec = { ...parsed.spec };
    const dn = displayName || name;
    if (dn) spec.displayName = dn;
    const payload: AdvancedWorkspacePayload = { name, spec };
    if (templateRef) payload.templateRef = { name: templateRef };
    return payload;
  }, [parsed.spec, name, displayName, templateRef]);

  // Client-side gate for Validate and Save. Blocks only on locally-checkable problems
  // (missing name, syntax/schema errors); the advisory image warning never blocks.
  const canValidateOrSave = Boolean(name) && !syntaxError && !schemaHasErrors;

  // Validate = dry-run: runs the operator's admission webhooks WITHOUT persisting. The
  // only layer that catches template bounds / image allow-lists / CEL rules authoritatively.
  const handleValidate = useCallback(async () => {
    const payload = buildPayload();
    if (!payload) return;
    setValidating(true);
    setDryRun(null);
    try {
      const result = await apiClient.validateWorkspace(payload, mode);
      setDryRun(result);
    } catch (err) {
      // validateWorkspace turns HTTP error *responses* into a result, but a failed
      // request (server unreachable, network error) makes fetch throw. Surface it in the
      // same status panel rather than leaving an unhandled rejection with no feedback.
      setDryRun({ valid: false, message: err instanceof Error ? err.message : ws.advancedValidateRequestFailed });
    } finally {
      setValidating(false);
    }
  }, [buildPayload, mode, ws.advancedValidateRequestFailed]);

  // Save is the real create/replace. On edit it's a full-spec REPLACE (buffer is the
  // desired spec, so removed fields are actually removed). A server validation failure
  // still surfaces here even without a prior Validate — the webhooks run on the real
  // write too — with the same per-field `details` that Validate shows (via ApiError).
  const handleSave = useCallback(async () => {
    const payload = buildPayload();
    if (!payload) return;
    setSaveError(null);
    try {
      if (isEdit) {
        await replaceMutation.mutateAsync({ name: payload.name, data: payload });
      } else {
        await createMutation.mutateAsync(payload);
      }
      setDirty(false);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError) {
        setSaveError({ message: err.message, details: err.details });
      } else {
        setSaveError({ message: err instanceof Error ? err.message : 'Save failed' });
      }
    }
  }, [buildPayload, isEdit, replaceMutation, createMutation, navigate]);

  const saving = createMutation.isPending || replaceMutation.isPending;

  // In-app exits we control: confirm before discarding a dirty buffer.
  const guardedExit = useCallback(
    (action: () => void) => {
      if (dirty) setDiscardAction(() => action);
      else action();
    },
    [dirty],
  );

  const handleCancel = useCallback(() => guardedExit(() => navigate('/')), [guardedExit, navigate]);
  const handleSwitchToForm = useCallback(() => {
    if (onSwitchToForm) guardedExit(onSwitchToForm);
  }, [guardedExit, onSwitchToForm]);

  if (isEdit && loadingExisting) {
    return (
      <Box display="flex" justifyContent="center" py={8}>
        <CircularProgress />
      </Box>
    );
  }

  // On edit, the fetch can fail (deleted/renamed workspace, RBAC, unreachable). Without
  // this guard the page would fall through to an empty editor that flags a bogus missing
  // displayName, and useWorkspace would poll the failing fetch forever (it only stops
  // polling once the workspace settles to Running/Stopped). Show an error card instead.
  if (isEdit && (loadError || !existing)) {
    return (
      <EditNotice message={loadError instanceof Error ? loadError.message : ws.advancedLoadError} onBack={() => navigate('/')} backLabel={ws.advancedBack} />
    );
  }

  // Guard the edit page itself against editing a running workspace. The Edit affordances
  // are already hidden unless owner + Stopped, but the route is reachable directly (saved
  // link, history), and the operator accepts spec updates while Running — which restarts
  // the pod and drops the user's session. Enforce the same check on the page.
  if (isEdit && existing) {
    const owner = getWorkspaceOwner(existing);
    if (!isOwner(owner, user?.username)) {
      return <EditNotice title={ws.advancedEditNotAllowedTitle} message={ws.advancedEditNotOwner} onBack={() => navigate('/')} backLabel={ws.advancedBack} />;
    }
    if (getWorkspaceStatus(existing) !== 'Stopped') {
      return (
        <EditNotice
          title={ws.advancedEditNotAllowedTitle}
          message={ws.advancedEditNotStopped}
          onBack={() => navigate(`/workspace/${existing.metadata.name}`)}
          backLabel={ws.advancedBack}
        />
      );
    }
  }

  return (
    <Stack spacing={3}>
      {isEdit && <Alert severity="info">{ws.advancedResolvedBanner}</Alert>}
      {saveError && (
        <Alert severity="error">
          <Typography variant="body2" fontWeight={600}>
            {saveError.message}
          </Typography>
          {saveError.details && (
            <Typography variant="caption" component="pre" sx={{ whiteSpace: 'pre-wrap', mt: 0.5 }}>
              {saveError.details}
            </Typography>
          )}
        </Alert>
      )}

      {/* name + displayName controls — rendered here only when this component owns them
          (the edit page). The inline create toggle renders them above and shares them. */}
      {renderIdentityFields && (
        <Paper variant="outlined">
          <Stack spacing={2} padding={3}>
            <TextField
              label={ws.fieldName}
              value={name}
              onChange={(e) => onNameChange(sanitizeK8sName(e.target.value))}
              required
              disabled={isEdit}
              size="small"
              helperText={isEdit ? undefined : ws.fieldNameHelper}
            />
            <TextField
              label={ws.fieldDisplayName}
              value={displayName}
              onChange={(e) => onDisplayNameChange(e.target.value)}
              placeholder={name || 'My Workspace'}
              size="small"
            />
          </Stack>
        </Paper>
      )}

      {/* templateRef control — kept out of the YAML buffer (see above) */}
      <Paper variant="outlined">
        <Stack spacing={2} padding={3}>
          <TemplateSelect value={templateRef} onChange={setTemplateRef} onTemplateResolved={handleTemplateResolved} />
          {templateSwitched && <Alert severity="warning">{ws.advancedTemplateSwitchCaution}</Alert>}
        </Stack>
      </Paper>

      {resolvedTemplate && <TemplateGuidancePanel template={resolvedTemplate} />}

      {/* YAML editor (full width) */}
      <Paper variant="outlined">
        <Stack spacing={2} padding={3}>
          <Stack spacing={0.5}>
            <Typography variant="subtitle2">{ws.advancedSpecLabel}</Typography>
            <Typography variant="caption" color="text.secondary">
              {ws.advancedSpecDocsPrefix}{' '}
              <Link href={ws.advancedHintDocsUrl} target="_blank" rel="noopener" underline="hover">
                {ws.advancedSpecDocsLink}
              </Link>{' '}
              {ws.advancedSpecDocsSuffix}
            </Typography>
          </Stack>
          <Suspense
            fallback={
              <Box display="flex" justifyContent="center" py={4}>
                <CircularProgress size={24} />
              </Box>
            }
          >
            <YamlEditor value={yamlText} onChange={handleYamlChange} schema={schema} onMarkers={setMarkers} />
          </Suspense>
          {imageWarning && <Alert severity="warning">{imageWarning}</Alert>}
          <ValidationStatus syntaxError={syntaxError} schemaHasErrors={schemaHasErrors} dryRun={dryRun} />
        </Stack>
      </Paper>

      {/* Actions */}
      <Stack direction="row" spacing={2} justifyContent="flex-end">
        <Button variant="text" onClick={handleCancel}>
          {common.cancel}
        </Button>
        {onSwitchToForm && (
          <Button variant="text" onClick={handleSwitchToForm}>
            {ws.advancedSwitchToForm}
          </Button>
        )}
        <Button variant="outlined" onClick={handleValidate} disabled={!canValidateOrSave || validating}>
          {validating ? ws.advancedValidating : ws.advancedValidate}
        </Button>
        <Button variant="contained" onClick={handleSave} disabled={!canValidateOrSave || saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : isEdit ? ws.advancedSaveEdit : ws.advancedSaveCreate}
        </Button>
      </Stack>

      {/* Regenerate-scaffold-on-template-change confirmation (dirty buffer) */}
      <ConfirmDialog
        open={regenDialogOpen}
        title={ws.advancedTemplateSwitchTitle}
        message={ws.advancedTemplateSwitchMessage(pendingRegenTemplate?.metadata.name ?? '')}
        confirmLabel={ws.advancedTemplateSwitchConfirm}
        cancelLabel={ws.advancedTemplateSwitchKeep}
        onConfirm={confirmRegen}
        onCancel={cancelRegen}
      />

      {/* Discard-edits confirmation for Cancel / switch-to-form (dirty buffer) */}
      <ConfirmDialog
        open={discardAction !== null}
        title={ws.advancedDiscardTitle}
        message={ws.advancedDiscardMessage}
        confirmLabel={ws.advancedDiscardConfirm}
        cancelLabel={common.cancel}
        isDestructive
        onConfirm={() => {
          const action = discardAction;
          setDiscardAction(null);
          action?.();
        }}
        onCancel={() => setDiscardAction(null)}
      />
    </Stack>
  );
}
