import { describe, test, expect, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from './ThemeContext';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(global, 'localStorage', {
  value: localStorageMock,
});

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorageMock.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  test('should initialize with light theme by default', () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    expect(result.current.theme).toBe('light');
  });

  test('should initialize with stored theme from localStorage', () => {
    localStorageMock.setItem('app-theme', 'dark');

    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    expect(result.current.theme).toBe('dark');
  });

  test('should update data-theme attribute when theme changes', () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    act(() => {
      result.current.setTheme('dark');
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  test('should toggle theme from light to dark', () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    expect(result.current.theme).toBe('light');

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.theme).toBe('dark');
  });

  test('should persist theme to localStorage', () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    act(() => {
      result.current.setTheme('dark');
    });

    expect(localStorageMock.getItem('app-theme')).toBe('dark');
  });

  test('should throw error when useTheme is used outside ThemeProvider', () => {
    expect(() => {
      renderHook(() => useTheme());
    }).toThrow('useTheme must be used within ThemeProvider');
  });
});
