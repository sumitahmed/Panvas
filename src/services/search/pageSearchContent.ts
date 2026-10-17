import type { DrawingData, TextObject } from '../../components/notebook/engine/drawingTypes.ts';

export interface PageSearchContent {
  handwritingText: string;
  richText: string;
  content: string;
  snippet: string;
}

export function textFromTipTap(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textFromTipTap).filter(Boolean).join(' ');
  if (typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const direct = typeof record.text === 'string' ? record.text : '';
  const attrs = record.attrs && typeof record.attrs === 'object' ? record.attrs as Record<string, unknown> : {};
  const semantic = ['inlineMath', 'blockMath', 'math'].includes(String(record.type))
    ? typeof attrs.latex === 'string' ? attrs.latex : ''
    : ['image', 'inlineImage'].includes(String(record.type)) ? typeof attrs.alt === 'string' ? attrs.alt : ''
      : record.type === 'pageReference' && typeof attrs.label === 'string' ? attrs.label : '';
  const nested = textFromTipTap(record.content);
  return `${direct} ${semantic} ${nested}`.replace(/\s+/g, ' ').trim();
}

export function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function extractPageSearchContent(pageData: unknown, drawingData: unknown): PageSearchContent {
  const drawing = drawingData && typeof drawingData === 'object' ? drawingData as DrawingData : undefined;
  const textObjects = (drawing?.objects ?? []).filter(
    (object): object is TextObject => object.type === 'text',
  );
  const handwritingText = normalizeSearchText(textObjects
    .filter(object => object.metadata?.generatedFrom === 'handwriting-recognition')
    .map(object => textFromTipTap(object.content))
    .join(' '));
  const richText = normalizeSearchText([
    textFromTipTap(pageData),
    ...textObjects
      .filter(object => object.metadata?.generatedFrom !== 'handwriting-recognition')
      .map(object => textFromTipTap(object.content)),
  ].join(' '));
  const content = normalizeSearchText(`${handwritingText} ${richText}`);

  return {
    handwritingText,
    richText,
    content,
    snippet: content.slice(0, 220),
  };
}
