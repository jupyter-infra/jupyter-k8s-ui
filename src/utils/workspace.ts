// Workspace status helpers

export function getStatusColor(isRunning: boolean, isAvailable: boolean, isPending: boolean): string {
  if (isRunning && isAvailable) return 'var(--color-success)';
  if (isPending) return 'var(--color-warning)';
  return 'var(--color-neutral)';
}

export function getStatusText(isRunning: boolean, isAvailable: boolean, isPending: boolean): string {
  if (isRunning && isAvailable) return 'Running';
  if (isPending) return 'Starting';
  return 'Stopped';
}

// Math utilities
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * K8s resource quantity suffixes and their multipliers.
 * Binary suffixes (Ki, Mi, Gi, Ti, Pi, Ei) use powers of 1024.
 * Decimal suffixes (m, k, M, G, T, P, E) use powers of 1000.
 * See: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
 */
const QUANTITY_SUFFIXES: Record<string, number> = {
  // Decimal sub-unit
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  // Decimal
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  // Binary
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

// Sorted longest-first so "Ki" matches before "k"
const SUFFIX_KEYS = Object.keys(QUANTITY_SUFFIXES).sort((a, b) => b.length - a.length);

/**
 * Parse a K8s resource quantity string to its base numeric value.
 * "500m" → 0.5, "2Gi" → 2147483648, "1" → 1
 */
export function parseQuantity(value: string): number | null {
  const str = value.trim();
  if (!str) return null;

  for (const suffix of SUFFIX_KEYS) {
    if (str.endsWith(suffix)) {
      const num = parseFloat(str.slice(0, -suffix.length));
      return isNaN(num) ? null : num * QUANTITY_SUFFIXES[suffix];
    }
  }

  const num = parseFloat(str);
  return isNaN(num) ? null : num;
}

/**
 * Parse a K8s resource value for display on sliders/UI.
 * CPU values are returned as cores (e.g. "500m" → 0.5, "2" → 2).
 * Memory values are returned as Gi (e.g. "2Gi" → 2, "512Mi" → 0.5).
 * For GPU or unknown resources, returns the plain numeric value.
 */
export function parseResourceValue(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const base = parseQuantity(value);
  if (base === null) return fallback;
  return base;
}

/**
 * Parse a memory value and return it in GiB for display.
 */
export function parseMemoryGi(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const base = parseQuantity(value);
  if (base === null) return fallback;
  return base / 2 ** 30;
}

/**
 * Parse a CPU value and return it in cores for display.
 * "500m" → 0.5, "2" → 2
 */
export function parseCpuCores(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const base = parseQuantity(value);
  if (base === null) return fallback;
  return base;
}

/**
 * Check if the given owner annotation matches the current username.
 * Handles various OIDC provider formats (plain, github:user, provider/user, etc.)
 */
export function isOwner(owner: string | undefined, username: string | undefined): boolean {
  if (!owner || !username) return false;
  return owner === username || owner === `github:${username}` || owner.endsWith(`/${username}`) || owner.includes(`:${username}`);
}

/**
 * Derive common workspace state booleans from a workspace object.
 */
export function getWorkspaceState(workspace: { spec: { desiredStatus?: string }; status?: { conditions?: Array<{ type: string; status: string }> } }) {
  const conditions = workspace.status?.conditions ?? [];
  const isRunning = workspace.spec.desiredStatus === 'Running';
  const isAvailable = conditions.some((c) => c.type === 'Available' && c.status === 'True');
  const isProgressing = conditions.some((c) => c.type === 'Progressing' && c.status === 'True');
  const isPending = isRunning && !isAvailable;
  const isStopped = workspace.spec.desiredStatus === 'Stopped' && !isProgressing;

  return { isRunning, isAvailable, isProgressing, isPending, isStopped };
}

// Validation
const K8S_NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function isValidK8sName(name: string): boolean {
  return name.length > 0 && name.length <= 63 && K8S_NAME_REGEX.test(name);
}

export function sanitizeK8sName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, '');
}
