import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import { handleUnauthorized, clearAuthReloadFlag } from './auth-interceptor';

describe('handleUnauthorized', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  test('first 401 sets flag and triggers reload', () => {
    const reload = mock(() => {});
    spyOn(window.location, 'reload').mockImplementation(reload);

    handleUnauthorized();

    expect(sessionStorage.getItem('auth_reload_ts')).not.toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('second 401 within 30s does not reload (loop protection)', () => {
    const reload = mock(() => {});
    spyOn(window.location, 'reload').mockImplementation(reload);

    sessionStorage.setItem('auth_reload_ts', String(Date.now() - 5_000));

    handleUnauthorized();

    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('auth_reload_ts')).toBeNull();
  });

  test('401 after 30s triggers reload again', () => {
    const reload = mock(() => {});
    spyOn(window.location, 'reload').mockImplementation(reload);

    sessionStorage.setItem('auth_reload_ts', String(Date.now() - 60_000));

    handleUnauthorized();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('auth_reload_ts')).not.toBeNull();
  });
});

describe('clearAuthReloadFlag', () => {
  test('removes the flag from sessionStorage', () => {
    sessionStorage.setItem('auth_reload_ts', String(Date.now()));
    clearAuthReloadFlag();
    expect(sessionStorage.getItem('auth_reload_ts')).toBeNull();
  });
});
