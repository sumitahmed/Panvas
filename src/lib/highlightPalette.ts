export const DEFAULT_HIGHLIGHT_COLORS = [
  ['Yellow', '#fff4b8'], ['Green', '#bbf7d0'], ['Blue', '#bfdbfe'],
  ['Pink', '#fbcfe8'], ['Orange', '#fed7aa'], ['Purple', '#ddd6fe'],
] as const;

export interface HighlightPalettePreference {
  version: 1;
  colors: string[];
  next: number;
  selectedColor: string | null;
}

const hexColor = (value: unknown): value is string => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);

export function defaultHighlightPalette(selectedColor: string | null = DEFAULT_HIGHLIGHT_COLORS[0][1]): HighlightPalettePreference {
  return { version: 1, colors: DEFAULT_HIGHLIGHT_COLORS.map(([, color]) => color), next: 0, selectedColor };
}

export function readHighlightPalette(value: unknown): HighlightPalettePreference {
  const candidate = value as Partial<HighlightPalettePreference> | null;
  if (!candidate || candidate.version !== 1 || !Array.isArray(candidate.colors) || candidate.colors.length !== 6
    || !candidate.colors.every(hexColor) || new Set(candidate.colors.map(color => color.toLowerCase())).size !== 6
    || !Number.isInteger(candidate.next) || candidate.next! < 0 || candidate.next! > 5
    || !(candidate.selectedColor === null || hexColor(candidate.selectedColor))) return defaultHighlightPalette();
  return { version: 1, colors: candidate.colors.map(color => color.toLowerCase()), next: candidate.next!,
    selectedColor: candidate.selectedColor?.toLowerCase() ?? null };
}

/** Choosing existing colors never rotates the ring. Document marks do not refer to slots. */
export function selectHighlightColor(palette: HighlightPalettePreference, color: string | null, custom = false): HighlightPalettePreference {
  if (color !== null && !hexColor(color)) return palette;
  const selectedColor = color?.toLowerCase() ?? null;
  if (custom && selectedColor && !palette.colors.includes(selectedColor)) {
    const colors = [...palette.colors]; colors[palette.next] = selectedColor;
    return { version: 1, colors, next: (palette.next + 1) % 6, selectedColor };
  }
  return palette.selectedColor === selectedColor ? palette : { ...palette, selectedColor };
}

export function highlightColorLabel(color: string) {
  return DEFAULT_HIGHLIGHT_COLORS.find(([, hex]) => hex === color)?.[0] ?? color.toUpperCase();
}
