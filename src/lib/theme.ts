// ============================================
// Panvas — Theme resolution helpers
// ============================================
// Single source of truth for appearance values shared by the pre-paint
// bootstrap and the UI store. Themes are applied as document classes, which
// is the repository-native mechanism (`.dark`, `.theme-ink`) that Tailwind's
// class-based dark mode and the CSS token blocks key off.
//
// OSS NOTE: User document colors (paper stationery, stroke inks, highlighters)
// are persisted content and must not be changed by application themes.

export type PanvasTheme = 'light' | 'ink' | 'dark';
export type ResolvedTheme = PanvasTheme;

export const PANVAS_THEMES: readonly PanvasTheme[] = ['light', 'ink', 'dark'];

export const THEME_STORAGE_KEY = 'panvas-theme';
export const FULL_DARK_VIEW_STORAGE_KEY = 'panvas-full-dark-view';

export function readFullDarkView(): boolean {
  try { return localStorage.getItem(FULL_DARK_VIEW_STORAGE_KEY) === 'true'; }
  catch { return false; }
}

export function applyFullDarkViewClass(theme: PanvasTheme, enabled: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.remove('full-dark-view');
  if (theme === 'dark' && enabled) document.documentElement.classList.add('full-dark-view');
}

export const THEME_CLASSES = ['dark', 'theme-ink'] as const;

const DARK_CLASS = 'dark';
const INK_CLASS = 'theme-ink';

export function isPanvasTheme(value: unknown): value is PanvasTheme {
  return typeof value === 'string' && (PANVAS_THEMES as readonly string[]).includes(value);
}

/** Accept the old E-Ink storage value only at the storage boundary. */
export function resolveTheme(theme: unknown): ResolvedTheme {
  if (isPanvasTheme(theme)) return theme;
  if (theme === 'eink') return 'ink';
  return 'dark';
}

export function themeClassesFor(resolved: ResolvedTheme): string[] {
  switch (resolved) {
    case 'dark': return [DARK_CLASS];
    case 'ink': return [INK_CLASS];
    default: return [];
  }
}

/** Replace the previous theme classes with the ones for `resolved`. */
export function applyThemeClasses(resolved: ResolvedTheme, fullDarkView = readFullDarkView()): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  // Remove the retired E-Ink marker too, so an existing session is restored
  // to the original Ink palette immediately.
  html.classList.remove(...THEME_CLASSES, 'theme-eink');
  for (const className of themeClassesFor(resolved)) {
    html.classList.add(className);
  }
  applyFullDarkViewClass(resolved, fullDarkView);
}

/**
 * Resolve historical choices once and persist the canonical three-mode value.
 * Called by both pre-paint bootstrap and store creation to avoid a theme flash.
 */
export function readAndMigrateTheme(): PanvasTheme {
  let theme: PanvasTheme = 'dark';
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    theme = resolveTheme(stored);
    if (stored !== theme) localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch { /* Resolved session appearance also works with restricted storage. */ }
  return theme;
}
