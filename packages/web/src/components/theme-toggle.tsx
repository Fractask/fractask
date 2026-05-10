'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

const STORAGE_KEY = 'getshit:theme';

type Theme = 'light' | 'dark';

function resolveSystem(): Theme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function readStored(): Theme | null {
  if (typeof window === 'undefined') return null;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'light') root.classList.add('light');
  else root.classList.remove('light');
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [explicit, setExplicit] = useState(false);

  useEffect(() => {
    const stored = readStored();
    const initial: Theme = stored ?? resolveSystem();
    setTheme(initial);
    setExplicit(stored !== null);
    applyTheme(initial);

    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e: MediaQueryListEvent) => {
      if (readStored() !== null) return;
      const next: Theme = e.matches ? 'light' : 'dark';
      setTheme(next);
      applyTheme(next);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    setExplicit(true);
    window.localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  };

  const reset = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setExplicit(false);
    const sys = resolveSystem();
    setTheme(sys);
    applyTheme(sys);
  };

  const label = `Switch to ${theme === 'light' ? 'dark' : 'light'} mode`;

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        title={label}
        aria-label={label}
        className="flex-1 flex items-center gap-2 px-2 py-1.5 text-xs text-(--color-muted) hover:text-(--color-fg) rounded cursor-pointer"
      >
        {theme === 'light' ? <Sun size={14} /> : <Moon size={14} />}
        <span>{theme === 'light' ? 'Light' : 'Dark'}</span>
        {!explicit && <span className="text-[10px] opacity-60">(auto)</span>}
      </button>
      {explicit && (
        <button
          type="button"
          onClick={reset}
          title="Follow system preference"
          aria-label="Follow system preference"
          className="text-[10px] text-(--color-muted) hover:text-(--color-fg) px-1.5 py-1 rounded cursor-pointer"
        >
          auto
        </button>
      )}
    </div>
  );
}
