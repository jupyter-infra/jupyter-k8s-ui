import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Typography, TextField, Button, Stack, Container, Paper, Alert, CircularProgress, Box, Link } from '@mui/material';
import type { editor } from 'monaco-editor';
import { useWorkspace, useCrdSchema, useCreateWorkspaceAdvanced, useReplaceWorkspaceAdvanced } from '../api';
import { apiClient, type ValidationResult } from '../api/client';
import { TemplateSelect } from '../components/workspace/yaml-editor/TemplateSelect';
import { TemplateGuidancePanel } from '../components/workspace/yaml-editor/TemplateGuidancePanel';
import { ValidationStatus } from '../components/workspace/yaml-editor/ValidationStatus';
import type { AdvancedWorkspacePayload, WorkspaceSpec, DiscoveredTemplate } from '../types';
import { strings } from '../constants';
import { sanitizeK8sName, specToYaml, yamlToSpec, buildCreateScaffold } from '../utils';

// Lazy-load the Monaco editor: it (plus its language workers) is a large dependency
// only needed on this route, so keep it out of the main bundle.
const YamlEditor = lazy(() => import('../components/workspace/yaml-editor/YamlEditor').then((m) => ({ default: m.YamlEditor })));

export interface WorkspaceAdvancedEditorProps {
  mode: 'create' | 'edit';
}

// The advanced editor drives both create and edit over one component. The YAML buffer
// holds ONLY the CR `spec`; `name` and `templateRef` are edited via dedicated controls
// above the editor (see below), never in the buffer.
export function WorkspaceAdvancedEditor({ mode }: WorkspaceAdvancedEditorProps) {
  const navigate = useNavigate();
  const { name: routeName } = useParams();
  const isEdit = mode === 'edit';

  const { workspace: ws, common } = strings;

  // --- Data ---
  const { data: schema } = useCrdSchema('workspaces');
  const { data: existing, isLoading: loadingExisting } = useWorkspace(isEdit ? (routeName ?? '') : '');
  const createMutation = useCreateWorkspaceAdvanced();
  const replaceMutation = useReplaceWorkspaceAdvanced();

  // `name` and `templateRef` live OUTSIDE the YAML buffer as structured controls.
  // Keeping templateRef here (rather than in the buffer) is what lets a template
  // change be a discrete event we can react to — it drives the image dropdown and the
  // guidance panel without re-parsing YAML on every keystroke. `resolvedTemplate` is
  // the full template object the dropdown resolved to (null = none / not discoverable).
  const [name, setName] = useState(routeName ?? '');
  const [templateRef, setTemplateRef] = useState<string | null>(null);
  const [resolvedTemplate, setResolvedTemplate] = useState<DiscoveredTemplate | null>(null);

  // The editor buffer. Create starts from a self-documenting scaffold (required fields
  // active, others commented with descriptions); edit seeds from the fetched spec
  // (below). `scaffold` tracks the last auto-generated create scaffold so we can detect
  // whether the user has hand-edited: while the buffer still equals `scaffold`, picking
  // a template regenerates it with that template's defaults; once edited, we never
  // regenerate (their input wins).
  const [yamlText, setYamlText] = useState(() => (isEdit ? '' : buildCreateScaffold(null, ws.advancedHintDocsUrl)));
  const [seeded, setSeeded] = useState(!isEdit);
  // Tracks whether the user has hand-edited the buffer. We can't detect this by
  // string-comparing against the last scaffold: Monaco normalizes content on mount
  // (trailing whitespace/EOL), firing a change event that isn't a real user edit. So
  // we flip this flag only on genuine keystrokes (handleYamlChange). While false, a
  // template change regenerates the scaffold; once true, we never regenerate.
  const userEditedRef = useRef(false);

  // --- Validation state ---
  const [markers, setMarkers] = useState<editor.IMarker[]>([]);
  const [dryRun, setDryRun] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // On edit, seed the buffer once from the workspace's stored spec. This is the
  // resolved spec from the cluster (template defaults already merged in by the
  // operator), shown as-is. We lift templateRef OUT of the buffer into the dropdown so
  // there's a single source of truth for it, then strip it from the YAML. Guarded by
  // `seeded` so later refetches (polling) don't clobber the user's in-progress edits.
  useEffect(() => {
    if (isEdit && existing && !seeded) {
      const spec = { ...existing.spec } as WorkspaceSpec;
      setTemplateRef(spec.templateRef?.name ?? null);
      delete spec.templateRef;
      setName(existing.metadata.name);
      setYamlText(specToYaml(spec as Record<string, unknown>));
      setSeeded(true);
    }
  }, [isEdit, existing, seeded]);

  // On create, regenerate the scaffold with the selected template's defaults — but
  // only while the buffer is still pristine (untouched since the last scaffold). Once
  // the user edits, we stop regenerating so we never clobber their work.
  useEffect(() => {
    if (isEdit) return;
    if (userEditedRef.current) return; // user has edited — never clobber their work
    setYamlText(buildCreateScaffold(resolvedTemplate, ws.advancedHintDocsUrl));
  }, [isEdit, resolvedTemplate, ws.advancedHintDocsUrl]);

  // `parsed` is the live YAML→spec parse; `parsed.error` is a syntax error (if any).
  // `schemaHasErrors` reflects Monaco's schema-validation markers. NOTE: monaco-yaml
  // reports CRD-schema violations (bad enum, wrong type, unknown field) at severity
  // Warning (4), NOT Error (8) — so we gate on severity >= Warning, else a
  // schema-invalid manifest would slip past into Save.
  const parsed = useMemo(() => yamlToSpec(yamlText), [yamlText]);
  const schemaHasErrors = markers.some((m) => m.severity >= 4 /* monaco MarkerSeverity.Warning */);
  const syntaxError = parsed.error;

  // The editor validates against the CRD schema as-is. We deliberately do NOT inject
  // the template's allowedImages as a schema `enum`: monaco-yaml treats enum violations
  // as hard markers that would block Save, but an out-of-list image must stay advisory
  // (see imageWarning below + the guidance panel + dry-run). Schema markers are
  // reserved for genuine CRD structural violations, which DO block.
  const editorSchema = schema;

  // Advisory, non-blocking hint: the typed image isn't in the template's allowed list.
  // This is a courtesy heads-up only — the authoritative check is the server dry-run,
  // which runs the operator's real admission webhooks. So this never disables Save.
  const imageWarning = useMemo(() => {
    if (!resolvedTemplate || resolvedTemplate.spec.allowCustomImages) return null;
    const image = parsed.spec?.image;
    const allowed = resolvedTemplate.spec.allowedImages ?? (resolvedTemplate.spec.defaultImage ? [resolvedTemplate.spec.defaultImage] : []);
    if (!image || allowed.length === 0 || allowed.includes(image)) return null;
    return ws.advancedImageNotAllowed(resolvedTemplate.metadata.name);
  }, [resolvedTemplate, parsed.spec?.image, ws]);

  // Editing the buffer invalidates the last dry-run result — a "Validation passed"
  // banner must not linger over YAML that has since changed. A genuine user edit also
  // marks the buffer dirty so template changes stop regenerating the scaffold.
  const handleYamlChange = useCallback((value: string, isUserEdit: boolean) => {
    setYamlText(value);
    setDryRun(null);
    setSaveError(null);
    if (isUserEdit) userEditedRef.current = true;
  }, []);

  // Recombine the out-of-buffer controls (name, templateRef) with the parsed spec into
  // the wire payload the server expects. Returns null if the YAML doesn't parse.
  const buildPayload = useCallback((): AdvancedWorkspacePayload | null => {
    if (!parsed.spec) return null;
    const payload: AdvancedWorkspacePayload = { name, spec: parsed.spec };
    if (templateRef) payload.templateRef = { name: templateRef };
    return payload;
  }, [parsed.spec, name, templateRef]);

  // Client-side gate for both Validate and Save. Blocks only on things we can check
  // locally (missing name, syntax/schema errors); the advisory image warning does NOT
  // block — the server dry-run is the real gate for template/bounds rules.
  const canValidateOrSave = Boolean(name) && !syntaxError && !schemaHasErrors;

  // Validate = dry-run against the cluster: runs the operator's admission webhooks
  // WITHOUT persisting. This is the only layer that catches template bounds, image
  // allow-lists, and cross-field rules authoritatively. Result is shown, not thrown.
  const handleValidate = useCallback(async () => {
    const payload = buildPayload();
    if (!payload) return;
    setValidating(true);
    setDryRun(null);
    try {
      const result = await apiClient.validateWorkspace(payload, mode);
      setDryRun(result);
    } finally {
      setValidating(false);
    }
  }, [buildPayload, mode]);

  // Save is the real create/replace. On edit it's a full-spec REPLACE (the buffer is
  // the desired spec, so fields the user removed are actually removed) — distinct from
  // the simple form's partial merge. A server-side validation failure still surfaces
  // here even if the user skipped Validate, since the webhooks run on the real write too.
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
      navigate('/');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    }
  }, [buildPayload, isEdit, replaceMutation, createMutation, navigate]);

  const saving = createMutation.isPending || replaceMutation.isPending;

  if (isEdit && loadingExisting) {
    return (
      <Box display="flex" justifyContent="center" py={8}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Container maxWidth="md">
      <Stack spacing={3} paddingBottom={8}>
        <Typography variant="h4" fontWeight={600}>
          {isEdit ? ws.advancedEditTitle : ws.advancedCreateTitle}
        </Typography>

        {isEdit && <Alert severity="info">{ws.advancedResolvedBanner}</Alert>}
        {saveError && <Alert severity="error">{saveError}</Alert>}

        {/* name + template controls — kept out of the YAML buffer (see above) */}
        <Paper variant="outlined">
          <Stack spacing={2} padding={3}>
            <TextField
              label={ws.fieldName}
              value={name}
              onChange={(e) => setName(sanitizeK8sName(e.target.value))}
              required
              disabled={isEdit}
              size="small"
              helperText={isEdit ? undefined : ws.fieldNameHelper}
            />
            <TemplateSelect value={templateRef} onChange={setTemplateRef} onTemplateResolved={setResolvedTemplate} />
          </Stack>
        </Paper>

        {/* Selected template's info strip, between the controls and the editor */}
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
              <YamlEditor value={yamlText} onChange={handleYamlChange} schema={editorSchema} onMarkers={setMarkers} />
            </Suspense>
            {imageWarning && <Alert severity="warning">{imageWarning}</Alert>}
            <ValidationStatus syntaxError={syntaxError} schemaHasErrors={schemaHasErrors} dryRun={dryRun} />
          </Stack>
        </Paper>

        {/* Actions */}
        <Stack direction="row" spacing={2} justifyContent="flex-end">
          <Button variant="text" onClick={() => navigate('/')}>
            {common.cancel}
          </Button>
          <Button variant="outlined" onClick={handleValidate} disabled={!canValidateOrSave || validating}>
            {validating ? ws.advancedValidating : ws.advancedValidate}
          </Button>
          <Button variant="contained" onClick={handleSave} disabled={!canValidateOrSave || saving}>
            {saving ? <CircularProgress size={20} color="inherit" /> : isEdit ? ws.advancedSaveEdit : ws.advancedSaveCreate}
          </Button>
        </Stack>
      </Stack>
    </Container>
  );
}
