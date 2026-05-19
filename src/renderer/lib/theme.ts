import type { UiTheme } from '~shared/types/settings.js';

const CACHE_KEY = 'nodepdf:theme';

/**
 * Synchronous side-cache so first paint can pick the right theme
 * BEFORE the async settings IPC round-trip completes. Without this,
 * a user with theme='light' would briefly see the dark palette on
 * every cold start (the dark defaults render until settings load).
 *
 * The cache is overwritten every time the settings store reconciles,
 * so it follows the real setting within one render after a change.
 */
export function readCachedTheme(): UiTheme {
  try {
    const v = localStorage.getItem(CACHE_KEY);
    return v === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: UiTheme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(CACHE_KEY, theme);
  } catch {
    // localStorage can throw in private modes / when quota is hit;
    // worst case is a one-frame flash next launch, not worth crashing.
  }
}
