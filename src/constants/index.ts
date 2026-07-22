export { strings, imageOptions, resourceBounds } from './strings';

// Resource calculation constants
export const RESOURCE_DEFAULTS = {
  CPU_REQUEST_RATIO: 0.5, // requests = limits * ratio
  MEMORY_REQUEST_RATIO: 0.5,
  MIN_CPU_REQUEST: 0.25,
  MIN_MEMORY_REQUEST: 0.5, // in GB
} as const;

export const IDLE_SHUTDOWN_DEFAULTS = {
  MIN_TIMEOUT: 5,
  MAX_TIMEOUT: 480,
  DEFAULT_TIMEOUT: 30,
  STEP: 5,
} as const;

// No-template slider defaults — today's hardcoded form values, centralized here so the
// resolver is the single source of the no-template defaults (not scattered literals).
export const STATIC_DEFAULTS = {
  cpu: 1, // cores
  memory: 2, // GiB
  storage: 10, // GiB
} as const;

// Frontend mirror of the server's DEFAULT_TEMPLATE_LABEL. An admin flags at most one
// template per namespace with this; the operator injects that template's ref onto a
// ref-less workspace (own namespace first, then shared). The picker's preselection
// mirrors that precedence.
export const DEFAULT_TEMPLATE_LABEL = 'workspace.jupyter.org/default-template';
