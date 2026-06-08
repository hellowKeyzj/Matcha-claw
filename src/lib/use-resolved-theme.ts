import { useEffect, useState } from 'react';

type ThemePreference = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

export function applyResolvedTheme(resolvedTheme: ResolvedTheme) {
  const root = window.document.documentElement;
  const body = window.document.body;
  root.classList.remove('light', 'dark');
  body.classList.remove('light', 'dark');
  root.classList.add(resolvedTheme);
}

function resolveTheme(theme: ThemePreference): ResolvedTheme {
  if (theme !== 'system') {
    return theme;
  }
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useResolvedTheme(theme: ThemePreference): ResolvedTheme {
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(theme));

  useEffect(() => {
    if (theme !== 'system') {
      setResolvedTheme(theme);
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = () => {
      setResolvedTheme(mediaQuery.matches ? 'dark' : 'light');
    };

    updateTheme();
    mediaQuery.addEventListener('change', updateTheme);
    return () => {
      mediaQuery.removeEventListener('change', updateTheme);
    };
  }, [theme]);

  return resolvedTheme;
}
