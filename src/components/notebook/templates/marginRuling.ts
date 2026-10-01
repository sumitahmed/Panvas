/** Shared page/preview/PDF geometry for the two notebook ruling styles. */
export const MARGIN_RULE_ACCENT = '#ba6e65';
export type MarginRulingStyle = 'Large ruled with margin' | 'Double margin ruled';

export function marginRuling(width: number, height: number, style: MarginRulingStyle) {
  const top = 58;
  const spacing = style === 'Large ruled with margin' ? 150 : 32;
  const margin = Math.round(width * 0.148);
  const horizontal: number[] = [];
  for (let y = top; y < height - 12; y += spacing) horizontal.push(y);
  return { top, bottom: height - 12, horizontal, margins: style === 'Large ruled with margin' ? [margin] : [margin, margin + 6] };
}
