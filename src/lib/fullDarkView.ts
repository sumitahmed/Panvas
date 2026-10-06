/** View colors only. Never write these values into a document or export. */
function rgb(value: string): number[] | null {
  const named = { black: '#000000', white: '#ffffff' } as Record<string, string>;
  value = named[value.toLowerCase()] ?? value;
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value);
  if (hex) {
    const text = hex[1].length < 5 ? hex[1].split('').map(c => c + c).join('') : hex[1];
    return [0, 2, 4].map(offset => parseInt(text.slice(offset, offset + 2), 16) / 255);
  }
  const functional = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/i.exec(value);
  return functional ? functional.slice(1, 4).map(channel => Number(channel) / 255) : null;
}

export function colorLuminance(value: string): number {
  const channels = rgb(value);
  if (!channels) return 0;
  const linear = channels.map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}

function withLightness(channels: number[], lightness: number): string {
  const high = Math.max(...channels), low = Math.min(...channels), delta = high - low;
  const originalL = (high + low) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * originalL - 1));
  const hue = delta === 0 ? 0 : high === channels[0]
    ? ((channels[1] - channels[2]) / delta + 6) % 6
    : high === channels[1] ? (channels[2] - channels[0]) / delta + 2 : (channels[0] - channels[1]) / delta + 4;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(hue % 2 - 1));
  const parts = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0] : hue < 3 ? [0, chroma, x]
    : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const base = lightness - chroma / 2;
  return '#' + parts.map(c => Math.round((c + base) * 255).toString(16).padStart(2, '0')).join('');
}

export function fullDarkInkColor(value: string): string {
  const channels = rgb(value);
  if (!channels || colorLuminance(value) >= .35) return value;
  if (Math.max(...channels) - Math.min(...channels) < .08) return '#dce3eb';
  return withLightness(channels, Math.max(.65, (Math.max(...channels) + Math.min(...channels)) / 2));
}

export function fullDarkSurfaceColor(value: string, sticky = false): string {
  const channels = rgb(value);
  if (!channels || colorLuminance(value) < .18) return value;
  if (Math.max(...channels) - Math.min(...channels) < .08) return sticky ? '#454b54' : '#20252b';
  return withLightness(channels, sticky ? .30 : .16);
}

export function fullDarkRuleLineColor(value: string): string {
  const channels = rgb(value);
  if (!channels) return value;
  return Math.max(...channels) - Math.min(...channels) < .08 ? '#52606f' : withLightness(channels, .38);
}

export const FULL_DARK_PDF_FILTER = 'invert(0.9) hue-rotate(180deg) brightness(0.9)';

/** Median sampled luminance avoids inverting an already-dark raster. */
export function isBrightDocumentPixels(pixels: ArrayLike<number>): boolean {
  const luminances: number[] = [];
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    luminances.push((pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722) / 255);
  }
  luminances.sort((a, b) => a - b);
  return luminances.length > 0 && luminances[Math.floor(luminances.length / 2)] > .5;
}

export function isBrightDocumentCanvas(canvas: HTMLCanvasElement): boolean {
  if (!canvas.width || !canvas.height) return false;
  const sample = document.createElement('canvas');
  sample.width = sample.height = 12;
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context) return false;
  context.drawImage(canvas, 0, 0, 12, 12);
  return isBrightDocumentPixels(context.getImageData(0, 0, 12, 12).data);
}
