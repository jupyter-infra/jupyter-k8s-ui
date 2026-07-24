// Template-bounds resolver — the pure, testable core of the template-aware simple form.
//
// Turns a template (or null == no-template) into the concrete controls the simple
// create/edit form needs: slider bounds/defaults, image mode, idle state, access seed,
// and a per-resource requests policy. Keeping this pure keeps WorkspaceCreate / the edit
// page thin, and lets us unit-test every rule.
//
// Design decisions this encodes:
//   — access toggle drives accessType only; ownershipType defaults to the template's
//     defaultOwnershipType, else OwnerOnly. Never derives from AccessType.
//   — image select preselects defaultImage, no prepend.
//   - the ratio request floor uses templateBounds.<res>.min ONLY when the template
//     declares that bound; otherwise MIN_<RES>_REQUEST alone. Static bounds == no
//     template, no a per-axis fallback for a partial-bounds template.
//   Idle: three states (Unavailable / Structure-locked / Interactive).

import type { AccessType, OwnershipType, WorkspaceTemplate, DiscoveredTemplate, IdleDetection } from '../types';
import { RESOURCE_DEFAULTS, IDLE_SHUTDOWN_DEFAULTS, STATIC_DEFAULTS, resourceBounds, DEFAULT_TEMPLATE_LABEL } from '../constants';
import { parseCpuCores, parseMemoryGi, clamp } from './workspace';

export interface AxisControl {
  min: number;
  max: number;
  default: number;
  step: number;
}

export interface ImageControl {
  mode: 'fixed' | 'select' | 'free';
  value: string; // the default/current image
  options: string[]; // for 'select' mode
}

// Where a resource's `request` comes from at submit time (consumed by the body builder).
// 'template' → use the template's verbatim request value; 'ratio' → limit × ratio, floored.
export type RequestSource = { source: 'template'; value: string } | { source: 'ratio' };

export type IdleControls =
  | { available: false }
  | {
      available: true;
      enabledDefault: boolean;
      // idleShutdownOverrides.allow !== true → the on/off toggle (and detection structure)
      // is locked; only the timeout may vary.
      toggleFrozen: boolean;
      timeout: AxisControl;
      // The template's own detection block, echoed verbatim into the submitted spec on
      // create (never parsed or authored by the UI). Absent for the edit-from-stored path
      // — there the page supplies the workspace's own detection.
      detection?: IdleDetection;
    };

export interface ResolvedTemplateControls {
  hasTemplate: boolean;
  cpu: AxisControl;
  memory: AxisControl;
  storage: AxisControl;
  image: ImageControl;
  idle: IdleControls;
  accessType: AccessType; // seed for the Public/Private toggle
  ownershipType: OwnershipType; // fixed default: not driven by the toggle
  requestsPolicy: { cpu: RequestSource; memory: RequestSource };
  // Preserved templateRef for the unresolvable-ref create path: controls fall back to
  // static, but the ref still rides on the submitted body so the operator applies it.
  templateRef?: { name: string; namespace?: string };
}

// Round a lower bound UP to the nearest step so the slider never offers a sub-min value.
// (The operator still receives the exact submitted value; this only shapes slider stops.)
function ceilToStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.ceil(value / step - 1e-9) * step;
}

// Build one axis (cpu/memory/storage) from a template min/max/default, falling back to the
// static bound per-field when a template bound is absent (defensive — never min>max).
function buildAxis(args: {
  templateMin: number | null;
  templateMax: number | null;
  templateDefault: number | null;
  staticBound: { min: number; max: number; step: number };
  staticDefault: number;
  // Effective-min floor from a fixed template request (limit >= request enforcement).
  requestFloor?: number;
}): AxisControl {
  const { staticBound, staticDefault, templateMin, templateMax, templateDefault, requestFloor } = args;
  const step = staticBound.step;

  const rawMin = templateMin ?? staticBound.min;
  const max = templateMax ?? staticBound.max;

  // limit >= request: the slider's effective min must not dip below a fixed request.
  const flooredMin = requestFloor !== undefined ? Math.max(rawMin, requestFloor) : rawMin;
  let min = ceilToStep(flooredMin, step);
  // Degenerate template range (e.g. sub-step max) — pin rather than emit min>max.
  if (min > max) min = max;

  const def = clamp(templateDefault ?? staticDefault, min, max);
  return { min, max, default: def, step };
}

// --- the resolver ---

export function resolveTemplateControls(template: WorkspaceTemplate | null, preservedRef?: { name: string; namespace?: string }): ResolvedTemplateControls {
  if (!template) {
    return noTemplateControls(preservedRef);
  }

  const spec = template.spec;
  const bounds = spec.resourceBounds?.resources;

  // Per-resource request policy: template-verbatim if the template declares a
  // request for that axis, else the ratio path.
  const cpuReqStr = spec.defaultResources?.requests?.cpu;
  const memReqStr = spec.defaultResources?.requests?.memory;
  const cpuPolicy: RequestSource = cpuReqStr ? { source: 'template', value: cpuReqStr } : { source: 'ratio' };
  const memPolicy: RequestSource = memReqStr ? { source: 'template', value: memReqStr } : { source: 'ratio' };

  // Effective-min floor from a FIXED template request (limit >= request). For the ratio
  // source the request scales below the limit, so it never binds the slider min.
  const cpuFloor = cpuReqStr ? parseCpuCores(cpuReqStr, 0) : undefined;
  const memFloor = memReqStr ? parseMemoryGi(memReqStr, 0) : undefined;

  const cpu = buildAxis({
    templateMin: bounds?.cpu?.min !== undefined ? parseCpuCores(bounds.cpu.min, resourceBounds.cpu.min) : null,
    templateMax: bounds?.cpu?.max !== undefined ? parseCpuCores(bounds.cpu.max, resourceBounds.cpu.max) : null,
    templateDefault: spec.defaultResources?.limits?.cpu !== undefined ? parseCpuCores(spec.defaultResources.limits.cpu, STATIC_DEFAULTS.cpu) : null,
    staticBound: resourceBounds.cpu,
    staticDefault: STATIC_DEFAULTS.cpu,
    requestFloor: cpuFloor,
  });

  const memory = buildAxis({
    templateMin: bounds?.memory?.min !== undefined ? parseMemoryGi(bounds.memory.min, resourceBounds.memory.min) : null,
    templateMax: bounds?.memory?.max !== undefined ? parseMemoryGi(bounds.memory.max, resourceBounds.memory.max) : null,
    templateDefault: spec.defaultResources?.limits?.memory !== undefined ? parseMemoryGi(spec.defaultResources.limits.memory, STATIC_DEFAULTS.memory) : null,
    staticBound: resourceBounds.memory,
    staticDefault: STATIC_DEFAULTS.memory,
    requestFloor: memFloor,
  });

  const storage = buildAxis({
    templateMin: spec.primaryStorage?.minSize !== undefined ? parseMemoryGi(spec.primaryStorage.minSize, resourceBounds.storage.min) : null,
    templateMax: spec.primaryStorage?.maxSize !== undefined ? parseMemoryGi(spec.primaryStorage.maxSize, resourceBounds.storage.max) : null,
    templateDefault: spec.primaryStorage?.defaultSize !== undefined ? parseMemoryGi(spec.primaryStorage.defaultSize, STATIC_DEFAULTS.storage) : null,
    staticBound: resourceBounds.storage,
    staticDefault: STATIC_DEFAULTS.storage,
  });

  return {
    hasTemplate: true,
    cpu,
    memory,
    storage,
    image: resolveImage(template),
    idle: resolveIdle(template),
    accessType: normalizeAccess(spec.defaultAccessType) ?? 'Public',
    ownershipType: normalizeOwnership(spec.defaultOwnershipType) ?? 'OwnerOnly',
    requestsPolicy: { cpu: cpuPolicy, memory: memPolicy },
    templateRef: { name: template.metadata.name, namespace: template.metadata.namespace },
  };
}

// No template (or unresolvable ref on create): static bounds/defaults, free image, idle
// unavailable, access Public + ownership OwnerOnly. The preserved ref, if any, rides
// on the submitted body so the operator still applies the referenced template server-side.
function noTemplateControls(preservedRef?: { name: string; namespace?: string }): ResolvedTemplateControls {
  const axis = (b: { min: number; max: number; step: number }, def: number): AxisControl => ({ min: b.min, max: b.max, step: b.step, default: def });
  return {
    hasTemplate: false,
    cpu: axis(resourceBounds.cpu, STATIC_DEFAULTS.cpu),
    memory: axis(resourceBounds.memory, STATIC_DEFAULTS.memory),
    storage: axis(resourceBounds.storage, STATIC_DEFAULTS.storage),
    image: { mode: 'free', value: '', options: [] },
    idle: { available: false },
    accessType: 'Public',
    ownershipType: 'OwnerOnly',
    requestsPolicy: { cpu: { source: 'ratio' }, memory: { source: 'ratio' } },
    ...(preservedRef && { templateRef: preservedRef }),
  };
}

// Image mode: allowCustomImages → free (any value accepted, but still SUGGEST the
// template's allowedImages/defaultImage as combobox options); else a populated
// allowedImages → select (preselect defaultImage, NO prepend); else fixed (defaultImage
// only).
function resolveImage(template: WorkspaceTemplate): ImageControl {
  const spec = template.spec;
  const defaultImage = spec.defaultImage ?? '';
  if (spec.allowCustomImages) {
    // Free entry, but offer the same curated images as suggestions. defaultImage may not
    // be in allowedImages here (unlike select mode's invariant), so union it in — deduped,
    // defaultImage first so it surfaces at the top of the list.
    const suggestions = [defaultImage, ...(spec.allowedImages ?? [])].filter((img, i, arr) => img !== '' && arr.indexOf(img) === i);
    return { mode: 'free', value: defaultImage, options: suggestions };
  }
  if (spec.allowedImages && spec.allowedImages.length > 0) {
    return { mode: 'select', value: defaultImage, options: spec.allowedImages };
  }
  return { mode: 'fixed', value: defaultImage, options: [] };
}

// Idle three-state model. Unavailable when the template has no defaultIdleShutdown (no
// detection source → the simple form can't author idle). Otherwise Structure-locked ONLY
// when idleShutdownOverrides.allow === false, else Interactive.
//
// Freeze condition is `allow === false`, NOT `allow !== true`: a served template can never
// carry an unset `allow` (the API server fills in `allow: true` whenever the overrides
// block is present), and when the whole block is ABSENT the operator skips idle validation
// entirely — so the user is free to toggle idle. Treating absent as locked was wrong: it
// froze the toggle even though `--dry-run=server` admits a workspace that disables idle.
function resolveIdle(template: WorkspaceTemplate): IdleControls {
  const def = template.spec.defaultIdleShutdown;
  if (!def) return { available: false };

  const overrides = template.spec.idleShutdownOverrides;
  const frozen = overrides?.allow === false;
  const defaultTimeout = def.idleTimeoutInMinutes ?? IDLE_SHUTDOWN_DEFAULTS.DEFAULT_TIMEOUT;

  // Timeout bounds: min = minIdleTimeoutInMinutes ?? (frozen ? default : 1); max =
  // maxIdleTimeoutInMinutes ?? (frozen ? default : 480). With allow:false + both omitted →
  // min=max=default → slider pinned. Absent-block / allow:true → editable 1..480.
  const min = overrides?.minIdleTimeoutInMinutes ?? (frozen ? defaultTimeout : 1);
  const max = overrides?.maxIdleTimeoutInMinutes ?? (frozen ? defaultTimeout : IDLE_SHUTDOWN_DEFAULTS.MAX_TIMEOUT);

  return {
    available: true,
    enabledDefault: def.enabled ?? false,
    toggleFrozen: frozen,
    timeout: {
      min,
      max: Math.max(min, max),
      default: clamp(defaultTimeout, min, Math.max(min, max)),
      step: IDLE_SHUTDOWN_DEFAULTS.STEP,
    },
    ...(def.detection !== undefined && { detection: def.detection }),
  };
}

function normalizeAccess(value: string | undefined): AccessType | null {
  return value === 'Public' || value === 'OwnerOnly' ? value : null;
}

function normalizeOwnership(value: string | undefined): OwnershipType | null {
  return value === 'Public' || value === 'OwnerOnly' ? value : null;
}

// --- conform-on-load (edit only) ---

// A single value that was adjusted to fit the current template, for the disclosure banner.
export interface ConformAdjustment {
  field: 'cpu' | 'memory' | 'storage' | 'image' | 'idleTimeout' | 'idleEnabled';
  from: string;
  to: string;
}

export interface ConformResult<T> {
  value: T;
  adjustments: ConformAdjustment[];
}

// Clamp a numeric axis value into the resolved bounds, recording an adjustment if it moved.
// Forced by the operator's whole-spec revalidation (template_validator.go:207): any edit
// re-checks every field against the CURRENT template, so a grandfathered-drifted value must
// be conformed or no save can succeed.
export function conformAxis(field: ConformAdjustment['field'], value: number, control: AxisControl, unit: string): ConformResult<number> {
  const clamped = clamp(value, control.min, control.max);
  if (clamped === value) return { value, adjustments: [] };
  return { value: clamped, adjustments: [{ field, from: `${value} ${unit}`, to: `${clamped} ${unit}` }] };
}

// Conform a stored image to the current image control: if the mode is select/fixed and the
// stored image isn't permitted, reset to the control's default (the template's defaultImage).
export function conformImage(stored: string, control: ImageControl): ConformResult<string> {
  if (control.mode === 'free') return { value: stored || control.value, adjustments: [] };
  const permitted = control.mode === 'select' ? control.options : [control.value];
  if (stored && permitted.includes(stored)) return { value: stored, adjustments: [] };
  if (!stored) return { value: control.value, adjustments: [] };
  return { value: control.value, adjustments: [{ field: 'image', from: stored, to: control.value }] };
}

// --- default-template resolution ---

function isDefaultFlagged(t: DiscoveredTemplate): boolean {
  return t.metadata.labels?.[DEFAULT_TEMPLATE_LABEL] === 'true';
}

// Find the default template mirroring the operator's injection precedence: a default in
// the user's OWN namespace wins over one in the shared namespace (template_getter.go
// ApplyTemplateName searches own-ns first, then shared). Returns null when none is flagged.
// `.find()` is deterministic-enough: the operator errors on >1 default per namespace, so at
// most one own-ns and one shared-ns candidate exist.
export function resolveDefaultTemplate(templates: DiscoveredTemplate[], namespaces: { own: string; shared: string } | undefined): DiscoveredTemplate | null {
  if (!namespaces) {
    // Without namespace context we can't honor precedence; fall back to any flagged default.
    return templates.find(isDefaultFlagged) ?? null;
  }
  const ownDefault = templates.find((t) => t.sourceNamespace === namespaces.own && isDefaultFlagged(t));
  if (ownDefault) return ownDefault;
  const sharedDefault = templates.find((t) => t.sourceNamespace === namespaces.shared && isDefaultFlagged(t));
  return sharedDefault ?? null;
}

// --- submit-time request computation (consumed by the body builder) ---

// Compute a resource's `request` from its policy and the chosen limit. For the ratio path,
// request = max(MIN_<RES>_REQUEST, limit × ratio) — NO static-bounds floor. For the
// template path, the verbatim template value.
export function computeCpuRequest(policy: RequestSource, limitCores: number): string {
  if (policy.source === 'template') return policy.value;
  return `${Math.max(RESOURCE_DEFAULTS.MIN_CPU_REQUEST, limitCores * RESOURCE_DEFAULTS.CPU_REQUEST_RATIO)}`;
}

export function computeMemoryRequest(policy: RequestSource, limitGi: number): string {
  if (policy.source === 'template') return policy.value;
  return `${Math.max(RESOURCE_DEFAULTS.MIN_MEMORY_REQUEST, limitGi * RESOURCE_DEFAULTS.MEMORY_REQUEST_RATIO)}Gi`;
}

// Build the COMPLETE resources block ({requests, limits}) the wholesale-replace overlay
// needs: the slider sets the limit; the request comes from the per-resource policy. Sending
// limits alone would wipe requests, so always emit both.
export function buildResourcesBlock(
  controls: ResolvedTemplateControls,
  cpuLimitCores: number,
  memoryLimitGi: number,
): { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } } {
  return {
    requests: {
      cpu: computeCpuRequest(controls.requestsPolicy.cpu, cpuLimitCores),
      memory: computeMemoryRequest(controls.requestsPolicy.memory, memoryLimitGi),
    },
    limits: { cpu: `${cpuLimitCores}`, memory: `${memoryLimitGi}Gi` },
  };
}
