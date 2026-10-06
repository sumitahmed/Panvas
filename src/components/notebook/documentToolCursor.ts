import type { ToolState } from './engine/drawingTypes.ts';

/**
 * Native-looking ink cursors keep the pen tip, rather than a crosshair centre,
 * on the document point that receives the stroke. They are deliberately small
 * and monochrome so they work on every paper colour and theme.
 */
const svgCursor = (svg: string, hotspotX: number, hotspotY: number, fallback = 'crosshair') =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspotX} ${hotspotY}, ${fallback}`;

const ERASER_CURSOR = svgCursor(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="m7 20 10-10a3 3 0 0 1 4.2 0l4.8 4.8a3 3 0 0 1 0 4.2l-8 8H9l-4-4 2-7Z" fill="#f6c7d7" stroke="#5d4650" stroke-width="1.7" stroke-linejoin="round"/><path d="m11 24 5-5" fill="none" stroke="#fff" stroke-width="1.5"/></svg>`, 9, 25, 'cell');

function dynamicInkCursor(tool: ToolState['drawingTool'], color: string): string {
  const ink = /^#[0-9a-f]{6}$/i.test(color) ? color : '#2563eb';
  if (tool === 'laser') {
    return svgCursor(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="9" fill="${ink}" fill-opacity=".18"/><circle cx="16" cy="16" r="4.5" fill="${ink}" stroke="#fff" stroke-width="1.5"/><circle cx="16" cy="16" r="1.4" fill="#fff"/></svg>`, 16, 16);
  }
  const tip = tool === 'highlighter' ? '#fef08a' : ink;
  const body = tool === 'pencil' ? '#fbfaf7' : tip;
  const accent = tool === 'highlighter' ? ink : '#24201a';
  return svgCursor(`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34"><path d="m7 26 3.5-8L24 4.5l5.5 5.5L16 23.5 7 26Z" fill="${body}" stroke="${accent}" stroke-width="1.8" stroke-linejoin="round"/><path d="m21.5 7 5.5 5.5" fill="none" stroke="${ink}" stroke-width="2"/><path d="m7 26 6.2-2.2-4-4L7 26Z" fill="${ink}" stroke="#24201a" stroke-width="1.2" stroke-linejoin="round"/></svg>`, 7, 26);
}

export function resolveDocumentToolCursor(toolState: ToolState): string | undefined {
  if (toolState.mode === 'erase') return ERASER_CURSOR;
  if (toolState.mode !== 'draw') return undefined;
  const handwritingInk = toolState.handwritingToTextEnabled
    && (toolState.drawingTool === 'pen' || toolState.drawingTool === 'pencil');
  return dynamicInkCursor(
    toolState.drawingTool,
    handwritingInk ? toolState.handwritingInkColor : toolState.color,
  );
}

