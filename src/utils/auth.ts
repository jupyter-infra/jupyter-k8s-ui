/**
 * Development authentication utilities
 * 
 * In production, authentication is handled by oauth2-proxy via cookies.
 * For development, set DEV_ACCESS_TOKEN in your .env file.
 */

/**
 * Check if we're in development mode with a token set
 */
export function hasDevToken(): boolean {
  return import.meta.env.DEV && !!import.meta.env.DEV_ACCESS_TOKEN;
}

/**
 * Get the development access token from environment
 * This is used by the API client to send the token in requests
 */
export function getDevToken(): string | null {
  // In development, we don't use localStorage anymore
  // The backend reads DEV_ACCESS_TOKEN directly from .env
  return null;
}

// For backward compatibility, keep these as no-ops
export function setDevToken(_token: string): void {
  console.warn('setDevToken is deprecated. Use DEV_ACCESS_TOKEN in .env file instead.');
}

export function clearDevToken(): void {
  console.warn('clearDevToken is deprecated. Remove DEV_ACCESS_TOKEN from .env file instead.');
}