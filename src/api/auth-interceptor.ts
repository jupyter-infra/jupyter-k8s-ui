let authFailed = false;

/**
 * Handle 401 responses. Sets an in-memory flag so all subsequent API calls
 * know auth is broken — no page reloads. The UI should check `isAuthFailed()`
 * and show a re-login prompt instead.
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

export function isAuthError(error: unknown): boolean {
  return error instanceof AuthError;
}
