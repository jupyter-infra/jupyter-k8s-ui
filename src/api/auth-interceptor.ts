let authFailed = false;

/**
 * Handle 401 responses. Sets an in-memory flag recording that auth is broken —
 * no page reloads. The flag is queryable via `isAuthFailed()` but is not yet
 * consulted by the UI: components currently react to `user === null` from
 * AuthContext with their own auth-check logic. The flag remains a hook for a
 * future centralized re-login prompt.
 */
export function handleUnauthorized(): void {
  authFailed = true;
}

export function clearAuthReloadFlag(): void {
  authFailed = false;
}

export function isAuthFailed(): boolean {
  return authFailed;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * A failed API request. Carries the server's structured `{ error, details }` body so
 * callers can render the per-field webhook breakdown (`details`) the same way the
 * dry-run Validate path does — not just a raw JSON blob in `message`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly details?: string;
  constructor(message: string, status: number, details?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export function isAuthError(error: unknown): boolean {
  return error instanceof AuthError;
}
