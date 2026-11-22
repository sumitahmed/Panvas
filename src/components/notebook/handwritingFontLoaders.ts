type FontStylesheetLoader = () => Promise<unknown>;

const HANDWRITING_LOADERS_BY_FACE: Readonly<Record<string, FontStylesheetLoader>> = {
  'Patrick Hand': () => import('@fontsource/patrick-hand/latin-400.css'),
  Kalam: () =>
    Promise.all([
      import('@fontsource/kalam/latin-300.css'),
      import('@fontsource/kalam/latin-400.css'),
      import('@fontsource/kalam/latin-700.css'),
    ]),
  Caveat: () =>
    Promise.all([
      import('@fontsource/caveat/latin-400.css'),
      import('@fontsource/caveat/latin-600.css'),
      import('@fontsource/caveat/latin-700.css'),
    ]),
  'Permanent Marker': () => import('@fontsource/permanent-marker/latin-400.css'),
  'Shadows Into Light': () => import('@fontsource/shadows-into-light/latin-400.css'),
  'Architects Daughter': () => import('@fontsource/architects-daughter/latin-400.css'),
  'Dancing Script': () =>
    Promise.all([
      import('@fontsource/dancing-script/latin-400.css'),
      import('@fontsource/dancing-script/latin-600.css'),
    ]),
  'Indie Flower': () => import('@fontsource/indie-flower/latin-400.css'),
  'Gochi Hand': () => import('@fontsource/gochi-hand/latin-400.css'),
  Schoolbell: () => import('@fontsource/schoolbell/latin-400.css'),
  Sacramento: () => import('@fontsource/sacramento/latin-400.css'),
};

export const HANDWRITING_FONT_LOADERS: Readonly<Record<string, FontStylesheetLoader>> = {
  "'Patrick Hand', cursive": HANDWRITING_LOADERS_BY_FACE['Patrick Hand'],
  "'Kalam', cursive": HANDWRITING_LOADERS_BY_FACE.Kalam,
  "'Caveat', cursive": HANDWRITING_LOADERS_BY_FACE.Caveat,
  "'Permanent Marker', cursive": HANDWRITING_LOADERS_BY_FACE['Permanent Marker'],
  "'Shadows Into Light', cursive": HANDWRITING_LOADERS_BY_FACE['Shadows Into Light'],
  "'Architects Daughter', cursive": HANDWRITING_LOADERS_BY_FACE['Architects Daughter'],
  "'Dancing Script', cursive": HANDWRITING_LOADERS_BY_FACE['Dancing Script'],
  "'Indie Flower', cursive": HANDWRITING_LOADERS_BY_FACE['Indie Flower'],
  "'Gochi Hand', cursive": HANDWRITING_LOADERS_BY_FACE['Gochi Hand'],
  "'Schoolbell', cursive": HANDWRITING_LOADERS_BY_FACE.Schoolbell,
  "'Sacramento', cursive": HANDWRITING_LOADERS_BY_FACE.Sacramento,
};

const stylesheetPromises = new Map<string, Promise<void>>();

function normalizeFontFace(fontFamily: string): string {
  return fontFamily.split(',')[0].replace(/['"]/g, '').trim();
}

/**
 * Loads the self-hosted @font-face stylesheet for a decorative handwriting
 * font family on demand and caches the idempotent promise.
 */
export function loadHandwritingFontStylesheet(fontFamily: string): Promise<void> {
  const face = normalizeFontFace(fontFamily);
  const loader = HANDWRITING_FONT_LOADERS[fontFamily] ?? HANDWRITING_LOADERS_BY_FACE[face];
  if (!loader) return Promise.resolve();

  const cached = stylesheetPromises.get(face);
  if (cached) return cached;

  const request = loader()
    .then(() => undefined)
    .catch((err) => {
      stylesheetPromises.delete(face);
      throw err;
    });
  stylesheetPromises.set(face, request);
  return request;
}
