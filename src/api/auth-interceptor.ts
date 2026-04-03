const RELOAD_FLAG_KEY = 'auth_reload_ts';
const RELOAD_LOOP_THRESHOLD_MS = 30_000;

/**
 * Handle 401 responses with reload loop protection (Thread 11).
 * First 401: set timestamp flag, reload page to trigger OAuth2 Proxy re-auth.
 * If flag was set < 30s ago: we're in a loop, don't reload.
 */
export function handleUnauthorized(): void {
  const lastReload = sessionStorage.getItem(RELOAD_FLAG_KEY);
  const now = Date.now();

  if (lastReload && now - parseInt(lastReload, 10) < RELOAD_LOOP_THRESHOLD_MS) {
    sessionStorage.removeItem(RELOAD_FLAG_KEY);
    return;
  }

  sessionStorage.setItem(RELOAD_FLAG_KEY, String(now));
  window.location.reload();
}

export function clearAuthReloadFlag(): void {
  sessionStorage.removeItem(RELOAD_FLAG_KEY);
}
