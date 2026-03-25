export { strings, imageOptions, resourceBounds } from './strings';

// Resource calculation constants
export const RESOURCE_DEFAULTS = {
  CPU_REQUEST_RATIO: 0.5,      // requests = limits * ratio
  MEMORY_REQUEST_RATIO: 0.5,
  MIN_CPU_REQUEST: 0.25,
  MIN_MEMORY_REQUEST: 0.5,     // in GB
} as const;

export const IDLE_SHUTDOWN_DEFAULTS = {
  MIN_TIMEOUT: 5,
  MAX_TIMEOUT: 480,
  DEFAULT_TIMEOUT: 30,
  STEP: 5,
} as const;
