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

export function parseResourceValue(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const num = parseFloat(value);
  return isNaN(num) ? fallback : num;
}

// Validation
const K8S_NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function isValidK8sName(name: string): boolean {
  return name.length > 0 && name.length <= 63 && K8S_NAME_REGEX.test(name);
}

export function sanitizeK8sName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, '');
}
