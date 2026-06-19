import type { LogLevel } from './types';
import { LOG_LEVEL_PRIORITY } from './types';
import { serverConfig } from './k8s/config';

function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, '');
}

export function log(level: LogLevel, message: string, ...args: unknown[]): void {
  if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[serverConfig.logLevel]) {
    return;
  }

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (args.length > 0) {
    logFn(prefix, sanitize(message), ...args);
  } else {
    logFn(prefix, sanitize(message));
  }
}
