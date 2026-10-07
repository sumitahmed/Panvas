// ============================================
// Panvas — Notebook toolbar responsive contract
// ============================================
// Pure width-to-groups mapping for NotebookFloatingToolbar, kept free of React
// so the breakpoints can be unit-tested (tests/toolbar-layout.test.ts).
// Responsive layout contracts are covered by tests/toolbar-layout.test.ts.
//
// Direct writing ends with Select and Hand. Pencil and utilities use More.

export type ToolbarGroupId =
  | 'history'    // undo / redo
  | 'handwriting' // real-time handwriting to editable text
  | 'primary'    // pen, highlighter, marker, eraser, text
  | 'select'
  | 'hand'
  | 'pencil'
  | 'image'
  | 'shapes'     // rectangle, ellipse, arrow, line
  | 'ruler'
  | 'laser'
  | 'gestures'
  | 'format';    // text formatting menu

/** 'active-tool' only exists in compact mode: a single button showing the
 *  currently active tool, so the active tool never disappears from view. */
export type CompactGroupId = 'active-tool';

export const TOOLBAR_GROUP_ORDER: readonly ToolbarGroupId[] = [
  'history',
  'handwriting',
  'primary',
  'select',
  'hand',
  'pencil',
  'image',
  'shapes',
  'ruler',
  'laser',
  'gestures',
  'format',
] as const;

// Rendered widths in px, including the inter-group separator. Button size is
// 40px with 4px gaps, so single-tool groups are 40 + ~14 separator = 54.
// Rounded up so the fit check never underestimates a group.
export const TOOLBAR_GROUP_WIDTHS: Record<ToolbarGroupId | CompactGroupId, number> = {
  history: 98,   // 2 x 40px buttons + gap + separator
  handwriting: 54,
  primary: 232,  // 5 x 40px buttons + gaps + separator
  select: 54,
  hand: 54,
  pencil: 54,
  image: 98,   // image + sticky note buttons + separator
  shapes: 54,    // one Shapes-family button + separator
  ruler: 54,
  laser: 54,
  gestures: 54,
  format: 54,
  'active-tool': 54,
};

// Toolbar chrome, measured against the rendered bar: px-3 side padding,
// the hide button, and (when anything overflows) the More button plus its
// divider. Rounded up so the fit check never underestimates.
const CHROME_WIDTH = 70;
const OVERFLOW_BUTTON_WIDTH = 48;

export const TOOLBAR_COMPACT_BREAKPOINT = 560;
export const TOOLBAR_MEDIUM_BREAKPOINT = 720;
// The image group now also contains the direct Sticky Note action. Keep a
// little extra full-width reserve so that pair cannot clip at the old 960px
// boundary; narrower windows use the existing More menu path.
export const TOOLBAR_FULL_BREAKPOINT = 1160;

// Below this the compact set (history + active-tool + More) cannot physically
// fit, so the bar degrades once more: the active tool stays visible and every
// other control — undo/redo included — lives behind the More button. With
// Electron's 680px window minimum and the 280px sidebar, the toolbar cell is
// never smaller than ~195px, which this tier still fits.
export const TOOLBAR_MINIMAL_CELL_WIDTH =
  CHROME_WIDTH + OVERFLOW_BUTTON_WIDTH + TOOLBAR_GROUP_WIDTHS['active-tool'];

export interface ToolbarLayout {
  /** Groups rendered directly on the toolbar bar, in display order. */
  visible: readonly (ToolbarGroupId | CompactGroupId)[];
  /** Groups reachable only through the overflow ("More Tools") menu. */
  overflow: readonly ToolbarGroupId[];
  /** Minimum-viable layout for narrow widths (< 560px). */
  compact: boolean;
}

export type MobileQuickTool = 'history' | 'pen' | 'select' | 'hand' | 'eraser' | 'text';

/** Eight 44px touch controls fit the 360px dock. Below that, keep navigation
 * and writing direct and move lower-priority controls to the existing More. */
export function resolveMobileQuickTools(width: number | null): readonly MobileQuickTool[] {
  const candidates: MobileQuickTool[][] = [
    ['history', 'pen', 'select', 'hand', 'eraser', 'text'],
    ['history', 'pen', 'select', 'hand', 'eraser'],
    ['pen', 'select', 'hand', 'eraser'],
    ['pen', 'hand', 'eraser'],
    ['pen', 'hand'],
  ];
  return candidates.find(tools => (tools.length + (tools.includes('history') ? 1 : 0) + 1) * 44 <= (width ?? 360)) ?? candidates[candidates.length - 1];
}

/** Keep a most-recent-first, case-insensitive color history for one tool. */
export function recordRecentColor(
  colors: readonly string[],
  selectedColor: string,
  limit = 5,
): string[] {
  const normalized = selectedColor.toLowerCase();
  return [selectedColor, ...colors.filter(color => color.toLowerCase() !== normalized)].slice(0, limit);
}

/**
 * Resolve the fullscreen notebook tool-only layout.
 *
 * Fullscreen deliberately has a smaller contract than the normal notebook
 * header: history, the complete writing group, and Select are the controls
 * users should reach without opening a utility cluster. Secondary drawing
 * actions remain available from More.  Unlike the normal responsive layout,
 * this resolver never replaces the writing group with an active-tool button
 * while there is enough room for the group itself.
 */
export function resolveFullscreenToolbarLayout(containerWidth: number | null, activeToolGroupId?: ToolbarGroupId): ToolbarLayout {
  const full: ToolbarGroupId[] = ['history', 'handwriting', 'primary', 'select', 'hand'];
  const finish = (visible: (ToolbarGroupId | CompactGroupId)[], compact: boolean): ToolbarLayout => ({
    visible,
    overflow: TOOLBAR_GROUP_ORDER.filter(group => !visible.includes(group)
      && !(visible.includes('active-tool') && group === activeToolGroupId && group !== 'primary')),
    compact,
  });
  if (containerWidth === null) return finish(full, false);
  const canFit = (groups: readonly ToolbarGroupId[]) => CHROME_WIDTH + OVERFLOW_BUTTON_WIDTH
    + groups.reduce((sum, group) => sum + TOOLBAR_GROUP_WIDTHS[group], 0) <= containerWidth;
  for (const candidate of [full, full.slice(0, 4), full.slice(0, 3), full.slice(1), full.slice(1, 4), full.slice(1, 3)]) {
    if (canFit(candidate)) return finish(candidate, containerWidth < TOOLBAR_COMPACT_BREAKPOINT);
  }
  return finish(['active-tool'], true);
}

/**
 * Resolve the deterministic toolbar layout for the width actually available to
 * the toolbar container.
 *
 * Wide bars show history, H2T, the five writing controls, Select and Hand.
 * Pencil and utilities remain in More. Measured fit moves trailing groups
 * into More; compact bars retain one active tool and reachable alternatives.
 */
export function resolveToolbarLayout(containerWidth: number | null, activeToolGroupId?: ToolbarGroupId): ToolbarLayout {
  const primaryEnd = TOOLBAR_GROUP_ORDER.indexOf('hand');
  if (containerWidth === null) {
    return {
      visible: TOOLBAR_GROUP_ORDER.slice(0, primaryEnd + 1),
      overflow: TOOLBAR_GROUP_ORDER.slice(primaryEnd + 1),
      compact: false,
    };
  }

  const compact = containerWidth < TOOLBAR_COMPACT_BREAKPOINT;

  // Stable primary ceiling: secondary controls never displace the requested
  // Handwriting-to-Text -> writing tools -> Select -> Hand -> More sequence.
  const ceiling = primaryEnd;

  // Measured-fit ceiling: last group index that fits in the container.
  let used = CHROME_WIDTH + OVERFLOW_BUTTON_WIDTH;
  let fit = TOOLBAR_GROUP_ORDER.length - 1;
  for (let i = 0; i < TOOLBAR_GROUP_ORDER.length; i++) {
    const group = TOOLBAR_GROUP_ORDER[i];
    if (used + TOOLBAR_GROUP_WIDTHS[group] > containerWidth) {
      fit = i - 1;
      break;
    }
    used += TOOLBAR_GROUP_WIDTHS[group];
  }

  if (compact) {
    const base = CHROME_WIDTH + OVERFLOW_BUTTON_WIDTH
      + TOOLBAR_GROUP_WIDTHS.history + TOOLBAR_GROUP_WIDTHS.handwriting + TOOLBAR_GROUP_WIDTHS['active-tool'];

    // Degradation ladder inside compact mode:
    //   >= base: history + active-tool (+ select when it fits)
    //   <  base: active-tool alone; everything else — undo/redo included —
    //            lives behind the More button. With Electron's 680px window
    //            minimum and the 280px sidebar, the toolbar cell is never
    //            smaller than ~195px, which this tier still fits.
    if (containerWidth < base) {
      const handwritingAndActive = CHROME_WIDTH + OVERFLOW_BUTTON_WIDTH
        + TOOLBAR_GROUP_WIDTHS.handwriting + TOOLBAR_GROUP_WIDTHS['active-tool'];
      if (containerWidth >= handwritingAndActive) {
        return {
          visible: ['handwriting', 'active-tool'],
          overflow: TOOLBAR_GROUP_ORDER.filter(group => group !== 'handwriting' && (group !== activeToolGroupId || group === 'primary')),
          compact: true,
        };
      }
      return {
        visible: ['active-tool'],
        overflow: TOOLBAR_GROUP_ORDER.filter(group => (group !== activeToolGroupId || group === 'primary')),
        compact: true,
      };
    }
    const withSelect = base + TOOLBAR_GROUP_WIDTHS.select <= containerWidth;
    const visible: (ToolbarGroupId | CompactGroupId)[] = ['history', 'handwriting', 'active-tool'];
    if (withSelect && activeToolGroupId !== 'select') visible.push('select');
    if (base + TOOLBAR_GROUP_WIDTHS.select + TOOLBAR_GROUP_WIDTHS.hand <= containerWidth && activeToolGroupId !== 'hand') visible.push('hand');
    const overflow = TOOLBAR_GROUP_ORDER.filter(group => !visible.includes(group) && (group !== activeToolGroupId || group === 'primary'));
    return { visible, overflow, compact: true };
  }

  const lastVisible = Math.max(0, Math.min(ceiling, fit));
  const visible: (ToolbarGroupId | CompactGroupId)[] = [...TOOLBAR_GROUP_ORDER.slice(0, lastVisible + 1)];

  return {
    visible,
    overflow: TOOLBAR_GROUP_ORDER.filter(group => !visible.includes(group)),
    compact: false,
  };
}
