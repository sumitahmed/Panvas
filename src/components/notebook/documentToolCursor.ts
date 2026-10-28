import type { ToolState } from './engine/drawingTypes.ts';

export interface ToolCursorDescriptor {
  svg: string;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  cssCursor: string;
}

const descriptorCache = new Map<string, ToolCursorDescriptor>();

/**
 * Native-looking ink cursors keep the pen tip, rather than a crosshair centre,
 * on the document point that receives the stroke. They are deliberately small
 * and monochrome so they work on every paper colour and theme.
 */
const svgCursor = (svg: string, hotspotX: number, hotspotY: number, fallback = 'crosshair') =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspotX} ${hotspotY}, ${fallback}`;

function getCachedDescriptor(key: string, create: () => ToolCursorDescriptor): ToolCursorDescriptor {
  const cached = descriptorCache.get(key);
  if (cached) return cached;
  const result = create();
  descriptorCache.set(key, result);
  return result;
}

function normalizeColor(color: string): string {
  if (!color) return '#2563eb';
  const trimmed = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  if (/^#[0-9a-f]{8}$/i.test(trimmed)) {
    return trimmed.slice(0, 7);
  }
  return trimmed.startsWith('#') ? trimmed : '#2563eb';
}

/**
 * Dedicated authentic eraser cursor matching original Panvas design:
 * an angled block eraser with pink body, dark outline, and white highlight stripe.
 */
const AUTHENTIC_ERASER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
  `<path d="m7 20 10-10a3 3 0 0 1 4.2 0l4.8 4.8a3 3 0 0 1 0 4.2l-8 8H9l-4-4 2-7Z" fill="#f6c7d7" stroke="#5d4650" stroke-width="1.7" stroke-linejoin="round"/>` +
  `<path d="m11 24 5-5" fill="none" stroke="#fff" stroke-width="1.5"/>` +
  `</svg>`;

export function authenticEraserDescriptor(): ToolCursorDescriptor {
  const key = 'eraser-authentic';
  return getCachedDescriptor(key, () => ({
    svg: AUTHENTIC_ERASER_SVG,
    width: 32,
    height: 32,
    hotspotX: 9,
    hotspotY: 25,
    cssCursor: svgCursor(AUTHENTIC_ERASER_SVG, 9, 25, 'cell'),
  }));
}

export function dynamicEraserDescriptor(_thickness?: number): ToolCursorDescriptor {
  return authenticEraserDescriptor();
}

export function dynamicEraserCursor(_thickness?: number): string {
  return authenticEraserDescriptor().cssCursor;
}

export function dynamicInkDescriptor(tool: ToolState['drawingTool'], color: string): ToolCursorDescriptor {
  const ink = normalizeColor(color);
  const key = `ink-${tool}-${ink}`;
  return getCachedDescriptor(key, () => {
    if (tool === 'eraser') {
      return authenticEraserDescriptor();
    }

    if (tool === 'laser') {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
        `<circle cx="16" cy="16" r="9" fill="${ink}" fill-opacity=".18"/>` +
        `<circle cx="16" cy="16" r="4.5" fill="${ink}" stroke="#fff" stroke-width="1.5"/>` +
        `<circle cx="16" cy="16" r="1.4" fill="#fff"/>` +
        `</svg>`;
      return {
        svg,
        width: 32,
        height: 32,
        hotspotX: 16,
        hotspotY: 16,
        cssCursor: svgCursor(svg, 16, 16),
      };
    }

    if (tool === 'pencil') {
      // Authentic pencil: hexagonal shaft, sharpened wood cone, graphite lead tip with active ink color
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">` +
        `<path d="m11 20 12-12 5.5 5.5-12 12Z" fill="#facc15" stroke="#24201a" stroke-width="1.6" stroke-linejoin="round"/>` +
        `<path d="m7 26 4-6 5.5 5.5-6.5 2.5Z" fill="#fef08a" stroke="#24201a" stroke-width="1.3" stroke-linejoin="round"/>` +
        `<path d="m7 26 2.2-3.3 2.5 2.5-3.5 1.5Z" fill="${ink}" stroke="#24201a" stroke-width="1.1" stroke-linejoin="round"/>` +
        `<path d="m22.5 8.5 5.5 5.5" fill="none" stroke="#71717a" stroke-width="2"/>` +
        `</svg>`;
      return {
        svg,
        width: 34,
        height: 34,
        hotspotX: 7,
        hotspotY: 26,
        cssCursor: svgCursor(svg, 7, 26),
      };
    }

    if (tool === 'marker') {
      // Authentic marker: cylindrical marker casing, color indicator band, tapered collar, bold bullet felt tip
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">` +
        `<path d="m13 18 10-10a2.5 2.5 0 0 1 3.5 0l2 2a2.5 2.5 0 0 1 0 3.5l-10 10Z" fill="#27272a" stroke="#18181b" stroke-width="1.6" stroke-linejoin="round"/>` +
        `<path d="m20.5 10.5 5.5 5.5" fill="none" stroke="${ink}" stroke-width="2.5"/>` +
        `<path d="m9 23.5 4-5.5 5.5 5.5-5.5 4Z" fill="#e4e4e7" stroke="#24201a" stroke-width="1.3" stroke-linejoin="round"/>` +
        `<path d="m7 26 2-4.5 4 4-4.5 2c-.8.8-1.5-.5-1.5-1.5Z" fill="${ink}" stroke="#18181b" stroke-width="1.2" stroke-linejoin="round"/>` +
        `</svg>`;
      return {
        svg,
        width: 34,
        height: 34,
        hotspotX: 7,
        hotspotY: 26,
        cssCursor: svgCursor(svg, 7, 26),
      };
    }

    if (tool === 'highlighter') {
      // Authentic highlighter: broad rectangular barrel, active ink collar band, dark ferrule, angled chisel wedge tip
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">` +
        `<path d="m14 17 9.5-9.5 5 5L19 22Z" fill="#fef08a" stroke="#24201a" stroke-width="1.6" stroke-linejoin="round"/>` +
        `<path d="m19 12 5 5" fill="none" stroke="${ink}" stroke-width="2.5"/>` +
        `<path d="m11 20 3-3 5 5-3 3Z" fill="#24201a" stroke="#24201a" stroke-width="1.2"/>` +
        `<path d="m7 26 2.5-4.5 4 1.5 1 4.5-6 0.5c-.8 0-1.5-.7-1.5-1.5Z" fill="${ink}" stroke="#24201a" stroke-width="1.2" stroke-linejoin="round"/>` +
        `</svg>`;
      return {
        svg,
        width: 34,
        height: 34,
        hotspotX: 7,
        hotspotY: 26,
        cssCursor: svgCursor(svg, 7, 26),
      };
    }

    // Default: authentic fountain pen nib
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">` +
      `<path d="m7 26 3.5-8L24 4.5l5.5 5.5L16 23.5 7 26Z" fill="${ink}" stroke="#24201a" stroke-width="1.8" stroke-linejoin="round"/>` +
      `<path d="m21.5 7 5.5 5.5" fill="none" stroke="#24201a" stroke-width="2"/>` +
      `<path d="m7 26 6.2-2.2-4-4L7 26Z" fill="${ink}" stroke="#24201a" stroke-width="1.2" stroke-linejoin="round"/>` +
      `</svg>`;
    return {
      svg,
      width: 34,
      height: 34,
      hotspotX: 7,
      hotspotY: 26,
      cssCursor: svgCursor(svg, 7, 26),
    };
  });
}

export function resolveToolCursorDescriptor(toolState: ToolState): ToolCursorDescriptor | undefined {
  if (toolState.mode === 'erase' || (toolState.mode === 'draw' && toolState.drawingTool === 'eraser')) {
    return authenticEraserDescriptor();
  }
  if (toolState.mode !== 'draw') return undefined;
  const handwritingInk = toolState.handwritingToTextEnabled
    && (toolState.drawingTool === 'pen' || toolState.drawingTool === 'pencil');
  return dynamicInkDescriptor(
    toolState.drawingTool,
    handwritingInk ? toolState.handwritingInkColor : toolState.color,
  );
}

export function resolveDocumentToolCursor(toolState: ToolState): string | undefined {
  return resolveToolCursorDescriptor(toolState)?.cssCursor;
}

export function computeCursorTransform(
  clientX: number,
  clientY: number,
  hotspotX: number,
  hotspotY: number,
): string {
  const x = clientX - hotspotX;
  const y = clientY - hotspotY;
  return `translate3d(${x}px, ${y}px, 0)`;
}

export function isPointInsideElement(
  element: HTMLElement | null,
  clientX: number,
  clientY: number,
): boolean {
  if (!element || typeof element.getBoundingClientRect !== 'function') return false;
  const rect = element.getBoundingClientRect();
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

export function isInteractiveUIElement(el: unknown): boolean {
  if (!el || typeof el !== 'object' || typeof (el as any).closest !== 'function') return false;
  return !!(el as Element).closest(
    'button, [role="button"], a, input, select, textarea, [role="menuitem"], [role="tab"], [role="switch"], [role="option"], summary, [role="toolbar"], [role="dialog"], [role="menu"], .panvas-floating-toolbar, .panvas-toolbar, .panvas-layer-popover, .panvas-dialog, .panvas-menu, .panvas-properties-sheet, .panvas-action-button, [data-panvas-ui="true"]'
  );
}

function resolveEventTargetElement(target: unknown, clientX: number, clientY: number): Element | null {
  if (target && typeof target === 'object' && typeof (target as any).closest === 'function') {
    return target as Element;
  }
  if (typeof document !== 'undefined' && typeof document.elementFromPoint === 'function') {
    return document.elementFromPoint(clientX, clientY);
  }
  return null;
}

export function shouldShowPenCursor(
  pointerType: string,
  hasDescriptor: boolean,
  inContainer: boolean,
  isPenDown: boolean,
  isOverUI = false,
): boolean {
  if (pointerType !== 'pen') return false;
  if (!hasDescriptor) return false;
  if (isOverUI && !isPenDown) return false;
  return isPenDown || inContainer;
}

export interface StylusCursorOverlayOptions {
  getDescriptor: () => ToolCursorDescriptor | undefined;
  getContainer: () => HTMLElement | null;
  onVisibilityChange: (visible: boolean) => void;
  onPositionChange: (transform: string) => void;
  onStylusActiveChange?: (active: boolean) => void;
}

export class StylusCursorOverlayController {
  private readonly options: StylusCursorOverlayOptions;
  private isVisible = false;
  private isPenDown = false;
  private latestCoords = { x: -1000, y: -1000 };

  constructor(options: StylusCursorOverlayOptions) {
    this.options = options;
  }

  private applyPosition(): void {
    const desc = this.options.getDescriptor();
    if (!desc) return;
    const transform = computeCursorTransform(
      this.latestCoords.x,
      this.latestCoords.y,
      desc.hotspotX,
      desc.hotspotY,
    );
    this.options.onPositionChange(transform);
  }

  private setVisible(visible: boolean): void {
    if (this.isVisible !== visible) {
      this.isVisible = visible;
      this.options.onVisibilityChange(visible);
      this.options.onStylusActiveChange?.(visible);
    }
  }

  handlePointerMove(e: { pointerType: string; clientX: number; clientY: number; target?: EventTarget | null }): void {
    if (e.pointerType !== 'pen') {
      if (this.isVisible) this.setVisible(false);
      return;
    }

    const desc = this.options.getDescriptor();
    if (!desc) {
      if (this.isVisible) this.setVisible(false);
      return;
    }

    this.latestCoords = { x: e.clientX, y: e.clientY };
    const container = this.options.getContainer();
    const inContainer = isPointInsideElement(container, e.clientX, e.clientY);

    const targetEl = resolveEventTargetElement(e.target, e.clientX, e.clientY);
    const isOverUI = isInteractiveUIElement(targetEl);

    if (shouldShowPenCursor(e.pointerType, true, inContainer, this.isPenDown, isOverUI)) {
      this.applyPosition();
      this.setVisible(true);
    } else {
      this.setVisible(false);
    }
  }

  handlePointerDown(e: { pointerType: string; clientX: number; clientY: number; target?: EventTarget | null }): void {
    if (e.pointerType !== 'pen') {
      this.setVisible(false);
      return;
    }

    const desc = this.options.getDescriptor();
    if (!desc) {
      this.setVisible(false);
      return;
    }

    const targetEl = resolveEventTargetElement(e.target, e.clientX, e.clientY);
    if (isInteractiveUIElement(targetEl)) {
      this.setVisible(false);
      return;
    }

    const container = this.options.getContainer();
    const inContainer = isPointInsideElement(container, e.clientX, e.clientY);

    if (inContainer) {
      this.isPenDown = true;
      this.latestCoords = { x: e.clientX, y: e.clientY };
      this.applyPosition();
      this.setVisible(true);
    }
  }

  handlePointerUp(e: { pointerType: string; clientX: number; clientY: number; target?: EventTarget | null }): void {
    if (e.pointerType !== 'pen') {
      this.setVisible(false);
      return;
    }

    this.isPenDown = false;
    const container = this.options.getContainer();
    const inContainer = isPointInsideElement(container, e.clientX, e.clientY);

    const targetEl = resolveEventTargetElement(e.target, e.clientX, e.clientY);
    if (!inContainer || isInteractiveUIElement(targetEl)) {
      this.setVisible(false);
    }
  }

  handlePointerCancel(e: { pointerType: string }): void {
    if (e.pointerType === 'pen') {
      this.isPenDown = false;
      this.setVisible(false);
    }
  }

  handleContainerPointerEnter(e: { pointerType: string; clientX: number; clientY: number }): void {
    if (e.pointerType === 'pen' && this.options.getDescriptor()) {
      this.latestCoords = { x: e.clientX, y: e.clientY };
      this.applyPosition();
      this.setVisible(true);
    }
  }

  handleContainerPointerLeave(e: { pointerType: string }): void {
    if (e.pointerType === 'pen' && !this.isPenDown) {
      this.setVisible(false);
    }
  }

  handleBlur(): void {
    this.isPenDown = false;
    this.setVisible(false);
  }

  syncDescriptor(desc: ToolCursorDescriptor | undefined): void {
    if (!desc) {
      this.isPenDown = false;
      this.setVisible(false);
    } else if (this.isVisible) {
      this.applyPosition();
    }
  }

  destroy(): void {
    this.setVisible(false);
  }

  getIsVisible(): boolean {
    return this.isVisible;
  }

  getIsPenDown(): boolean {
    return this.isPenDown;
  }
}
