import type { PanvasTheme } from './theme.ts';

/** Snapshot presentation at export start; never persist it into a document. */
export function currentPresentationTheme(): PanvasTheme {
  if (typeof document === 'undefined') return 'light';
  if (document.documentElement.classList.contains('theme-ink')) return 'ink';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/** The sRGB matrix used by CSS saturate(0.5), matching the on-screen content. */
export function inkRgb(red: number, green: number, blue: number): [number, number, number] {
  const luminance = red * 0.213 + green * 0.715 + blue * 0.072;
  return [red, green, blue].map(channel => Math.round((channel + luminance) / 2)) as [number, number, number];
}

export function presentationColor(value: string, theme: PanvasTheme): string {
  if (theme !== 'ink') return value;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) return value;
  const hex = match[1].length === 3 ? match[1].split('').map(char => char + char).join('') : match[1];
  const packed = Number.parseInt(hex, 16);
  return '#' + inkRgb((packed >> 16) & 255, (packed >> 8) & 255, packed & 255).map(channel => channel.toString(16).padStart(2, '0')).join('');
}

const paintKeys = new Set(['color', 'fill', 'stroke', 'backgroundColor', 'elementBackground', 'borderColor', 'strokeColor', 'fillColor', 'ruleLineColor']);

/** Copy only export data. Paper colors, geometry, opacity and source records stay intact. */
export function presentationData<T>(value: T, theme: PanvasTheme): T {
  if (theme !== 'ink') return value;
  const copy = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(copy);
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [
      key, paintKeys.has(key) && typeof child === 'string' ? presentationColor(child, theme) : copy(child),
    ]));
  };
  return copy(value) as T;
}

export interface PresentationImage { mimeType: string; data: ArrayBuffer | Uint8Array }

/** Lossless export-only image copy at the original pixel dimensions. */
export async function presentationImage(image: PresentationImage, theme: PanvasTheme): Promise<PresentationImage> {
  if (theme !== 'ink') return image;
  const bytes = image.data instanceof Uint8Array ? image.data.slice().buffer : image.data.slice(0);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mimeType }));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The image export surface is unavailable.');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      const [r, g, b] = inkRgb(pixels.data[index], pixels.data[index + 1], pixels.data[index + 2]);
      pixels.data[index] = r; pixels.data[index + 1] = g; pixels.data[index + 2] = b;
    }
    context.putImageData(pixels, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image export could not be encoded.')), 'image/png'));
    return { mimeType: 'image/png', data: await png.arrayBuffer() };
  } finally { bitmap.close(); }
}
