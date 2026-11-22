import { loadHandwritingFontStylesheet } from './handwritingFontLoaders.ts';

export const UI_FONT_FAMILY = 'Inter, ui-sans-serif, system-ui, sans-serif';

export const STANDARD_TEXT_FONT_FAMILIES = [
  'Inter, sans-serif',
  "'Newsreader', serif",
  "'Times New Roman', serif",
  "'JetBrains Mono', monospace",
  "'Courier New', monospace",
  "'Comic Sans MS', cursive",
] as const;

export const HANDWRITING_FONT_FAMILIES = [
  "'Patrick Hand', cursive",
  "'Kalam', cursive",
  "'Caveat', cursive",
  "'Permanent Marker', cursive",
  "'Shadows Into Light', cursive",
  "'Architects Daughter', cursive",
  "'Dancing Script', cursive",
  "'Indie Flower', cursive",
  "'Gochi Hand', cursive",
  "'Schoolbell', cursive",
  "'Sacramento', cursive",
] as const;

export const PANVAS_TEXT_FONT_FAMILIES = [
  ...STANDARD_TEXT_FONT_FAMILIES,
  ...HANDWRITING_FONT_FAMILIES,
] as const;

export type PanvasTextFontFamily = typeof PANVAS_TEXT_FONT_FAMILIES[number];
export type FontAvailability = 'loading' | 'loaded' | 'unavailable';

export interface TextFontGroup {
  label: 'Standard' | 'Handwriting';
  fonts: readonly PanvasTextFontFamily[];
  fontFamily: typeof UI_FONT_FAMILY;
}

export const TEXT_FONT_GROUPS: readonly TextFontGroup[] = [
  { label: 'Standard', fonts: STANDARD_TEXT_FONT_FAMILIES, fontFamily: UI_FONT_FAMILY },
  { label: 'Handwriting', fonts: HANDWRITING_FONT_FAMILIES, fontFamily: UI_FONT_FAMILY },
];

export function fontLabel(fontFamily: string): string {
  return fontFamily.replace(/[',"]/g, '').replace(/\s+(sans-serif|serif|monospace|cursive)$/, '');
}

export function fontFaceName(fontFamily: string): string {
  return fontLabel(fontFamily);
}

export function fontOptionStyle(fontFamily: string, availability: FontAvailability): { fontFamily: string } {
  return { fontFamily: availability === 'loaded' ? fontFamily : UI_FONT_FAMILY };
}

const fontLoadCache = new Map<string, Promise<FontAvailability>>();

function systemFaceAvailable(face: string): boolean {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return false;
  const sample = 'mmmmWWWW0123456789';
  return ['monospace', 'serif'].some(fallback => {
    context.font = `32px ${fallback}`;
    const base = context.measureText(sample).width;
    context.font = `32px "${face}", ${fallback}`;
    return context.measureText(sample).width !== base;
  });
}

export function loadTextFontStylesheet(fontFamily: string): Promise<void> {
  return loadHandwritingFontStylesheet(fontFamily).catch(() => undefined);
}

export function loadTextFont(fontFamily: string): Promise<FontAvailability> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve('unavailable');
  const cached = fontLoadCache.get(fontFamily);
  if (cached) return cached;
  const face = fontFaceName(fontFamily);
  const request = (async () => {
    // Core faces are self-hosted through editor-fonts.css; decorative
    // handwriting faces load their local @fontsource CSS on demand first.
    await loadTextFontStylesheet(fontFamily);
    // Waiting on the FontFaceSet distinguishes a bundled face from its generic
    // fallback; width probing remains useful for true operating-system fonts.
    const loadedFaces = await document.fonts.load(`32px "${face}"`);
    if (loadedFaces.length > 0) return 'loaded' as const;
    if (systemFaceAvailable(face)) return 'loaded' as const;
    return 'unavailable' as const;
  })()
    .catch(() => 'unavailable' as const);
  fontLoadCache.set(fontFamily, request);
  return request;
}

export function collectContentFontFamilies(content: unknown, out = new Set<string>()): Set<string> {
  if (!content || typeof content !== 'object') return out;
  if (Array.isArray(content)) {
    for (const item of content) collectContentFontFamilies(item, out);
    return out;
  }
  const node = content as { marks?: Array<{ type?: string; attrs?: { fontFamily?: unknown } }>; content?: unknown[] };
  if (Array.isArray(node.marks)) {
    for (const mark of node.marks) {
      if (mark?.type === 'textStyle' && typeof mark.attrs?.fontFamily === 'string' && mark.attrs.fontFamily) {
        out.add(mark.attrs.fontFamily);
      }
    }
  }
  if (Array.isArray(node.content)) {
    collectContentFontFamilies(node.content, out);
  }
  return out;
}

export function preloadObjectFontStylesheets(fontFamily: string | undefined, content: unknown): void {
  if (fontFamily) void loadTextFontStylesheet(fontFamily);
  for (const family of collectContentFontFamilies(content)) {
    void loadTextFontStylesheet(family);
  }
}
