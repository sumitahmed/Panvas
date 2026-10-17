import {
  DEFAULT_PAGE_PROPERTY_SET,
  type Notebook,
  type NotebookPage,
  type PagePropertySet,
} from '../types/notebook.ts';

export interface PageGeometryFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageGeometryAnchor {
  normalizedX: number;
  normalizedY: number;
  viewportX: number;
  viewportY: number;
}

export interface PageDimensions {
  width: number;
  height: number;
}

export interface PageNoteSpace {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PageSurfaceGeometry extends PageDimensions {
  source: PageGeometryFrame;
  noteSpace: PageNoteSpace;
}

export interface NotebookPageLayoutPosition extends PageDimensions {
  id: string;
  x: number;
  y: number;
}

export interface NotebookPageLayout {
  positions: NotebookPageLayoutPosition[];
  totalWidth: number;
  totalHeight: number;
  gap: number;
  paddingY: number;
}

const PAGE_DIMENSIONS: Record<PagePropertySet['pageSize'], PageDimensions> = {
  A3: { width: 1123, height: 1587 },
  A4: { width: 794, height: 1123 },
  A5: { width: 595, height: 842 },
  Letter: { width: 816, height: 1056 },
  // The current property model has no persisted custom width/height. Preserve
  // the existing renderer fallback until that model gains explicit dimensions.
  Custom: { width: 794, height: 1123 },
  Infinite: { width: 794, height: 1123 },
};

const clampNoteSpace = (value: number | undefined) => Number.isFinite(value)
  ? Math.max(0, Math.min(6000, value ?? 0))
  : 0;

/** Legacy `extraHeight` remains bottom space until the page writes `extraBottom`. */
export function resolvePageNoteSpace(properties: Partial<PagePropertySet>): PageNoteSpace {
  return {
    top: clampNoteSpace(properties.extraTop),
    right: clampNoteSpace(properties.extraRight),
    bottom: clampNoteSpace(properties.extraBottom ?? properties.extraHeight),
    left: clampNoteSpace(properties.extraLeft),
  };
}

/** Resolve the unchanged physical/source dimensions belonging to one page. */
export function resolveBasePageDimensions(properties: PagePropertySet): PageDimensions {
  const dimensions = PAGE_DIMENSIONS[properties.pageSize];
  if (properties.pageSize === 'Infinite') return { width: Number.isFinite(properties.infiniteWidth) && properties.infiniteWidth! > 0 ? properties.infiniteWidth! : 794, height: 1123 };
  return properties.orientation === 'landscape'
    ? { width: dimensions.height, height: dimensions.width }
    : { ...dimensions };
}

/** Overall writable surface plus the fixed source-page frame inside it. */
export function resolvePageSurfaceGeometry(properties: PagePropertySet): PageSurfaceGeometry {
  const base = resolveBasePageDimensions(properties);
  const noteSpace = resolvePageNoteSpace(properties);
  const expanded = properties.pageSize === 'Infinite' || properties.layoutMode === 'document';
  const extent = expanded && Number.isFinite(properties.layoutExtent) ? Math.max(base.height, properties.layoutExtent!) : base.height;
  return {
    width: noteSpace.left + base.width + noteSpace.right,
    height: noteSpace.top + extent + noteSpace.bottom,
    source: { left: noteSpace.left, top: noteSpace.top, ...base },
    noteSpace,
  };
}

/** Resolve total writable dimensions; source dimensions stay available separately. */
export function resolvePageDimensions(properties: PagePropertySet): PageDimensions {
  const { width, height } = resolvePageSurfaceGeometry(properties);
  return { width, height };
}

/**
 * Build section geometry solely from per-page persisted properties. Focus and
 * scroll state are deliberately absent from this contract.
 */
export function resolveNotebookPageLayout(
  pages: ReadonlyArray<{ id: string; properties: PagePropertySet }>,
  spreadMode = false,
): NotebookPageLayout {
  const gap = 32;
  const paddingY = 32;
  const sizedPages = pages.map(page => ({ ...page, ...resolvePageDimensions(page.properties) }));

  if (!spreadMode) {
    const totalWidth = sizedPages.reduce((widest, page) => Math.max(widest, page.width), 0);
    let nextY = paddingY;
    const positions = sizedPages.map(page => {
      const position = {
        id: page.id,
        x: (totalWidth - page.width) / 2,
        y: nextY,
        width: page.width,
        height: page.height,
      };
      nextY += page.height + gap;
      return position;
    });
    const contentHeight = sizedPages.length > 0 ? nextY - gap : paddingY;
    return { positions, totalWidth, totalHeight: contentHeight + paddingY, gap, paddingY };
  }

  // Preserve two-page spread behavior while allowing each slot to keep its
  // own dimensions. Columns and rows size independently from their contents.
  const columnWidths = [0, 0];
  const rowHeights: number[] = [];
  sizedPages.forEach((page, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    columnWidths[column] = Math.max(columnWidths[column], page.width);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, page.height);
  });

  const rowTops: number[] = [];
  let nextY = paddingY;
  rowHeights.forEach((height, row) => {
    rowTops[row] = nextY;
    nextY += height + gap;
  });
  const totalWidth = columnWidths[0] + (columnWidths[1] > 0 ? gap + columnWidths[1] : 0);
  const positions = sizedPages.map((page, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const columnLeft = column === 0 ? 0 : columnWidths[0] + gap;
    return {
      id: page.id,
      x: columnLeft + (columnWidths[column] - page.width) / 2,
      y: rowTops[row],
      width: page.width,
      height: page.height,
    };
  });
  const contentHeight = sizedPages.length > 0 ? nextY - gap : paddingY;
  return { positions, totalWidth, totalHeight: contentHeight + paddingY, gap, paddingY };
}

/** Capture the document point currently held at a viewport position. */
export function capturePageGeometryAnchor(
  page: PageGeometryFrame,
  viewportPoint: { x: number; y: number },
): PageGeometryAnchor {
  return {
    normalizedX: page.width > 0 ? (viewportPoint.x - page.left) / page.width : 0.5,
    normalizedY: page.height > 0 ? (viewportPoint.y - page.top) / page.height : 0.5,
    viewportX: viewportPoint.x,
    viewportY: viewportPoint.y,
  };
}

/** Scroll delta required to keep a captured page point visually stationary. */
export function resolvePageGeometryScrollDelta(
  anchor: PageGeometryAnchor,
  nextPage: PageGeometryFrame,
): { x: number; y: number } {
  return {
    x: nextPage.left + anchor.normalizedX * nextPage.width - anchor.viewportX,
    y: nextPage.top + anchor.normalizedY * nextPage.height - anchor.viewportY,
  };
}

export function getNotebookPageDefaults(notebook?: Notebook): PagePropertySet {
  const defaults = { ...DEFAULT_PAGE_PROPERTY_SET, ...(notebook?.defaultPageProperties ?? {}) };
  delete defaults.layoutExtent;
  delete defaults.layoutMode;
  delete defaults.infiniteWidth;
  return defaults;
}

/**
 * Resolve a notebook paper color without consulting application chrome.
 *
 * Older drawing payloads may omit the value or use the historical `default`
 * sentinel. Those records use the canonical white paper default forever;
 * Light/Dark/Ink application themes never rewrite document appearance.
 */
export function resolveNotebookPaperColor(value: string | null | undefined): string {
  return typeof value === 'string' && value.trim() !== '' && value !== 'default'
    ? value
    : DEFAULT_PAGE_PROPERTY_SET.paperColor;
}

/** Resolve a notebook template line color independently of application theme. */
export function resolveNotebookLineColor(value: string | null | undefined): string {
  return typeof value === 'string' && value.trim() !== '' && value !== 'default'
    ? value
    : DEFAULT_PAGE_PROPERTY_SET.ruleLineColor;
}

/**
 * Resolve the complete input consumed by the page template renderer.
 *
 * Keeping geometry and document colors together makes the final rendering
 * boundary explicit: a change to either persisted paper value produces a new
 * render model, while application theme state remains outside this contract.
 */
export interface PageTemplateRenderModel extends PageSurfaceGeometry {
  template: PagePropertySet['template'];
  paperColor: string;
  lineColor: string;
}

export function resolvePageTemplateRenderModel(properties: PagePropertySet): PageTemplateRenderModel {
  return {
    ...resolvePageSurfaceGeometry(properties),
    template: properties.template,
    paperColor: resolveNotebookPaperColor(properties.paperColor),
    lineColor: resolveNotebookLineColor(properties.ruleLineColor),
  };
}

export function resolvePageProperties(
  notebook: Notebook | undefined,
  page: NotebookPage | undefined,
  legacyProperties?: Partial<PagePropertySet>,
): PagePropertySet {
  const defaults = getNotebookPageDefaults(notebook);
  // Metadata with an explicit overrides object uses the new inheritance model.
  // Missing metadata identifies a legacy page whose drawing payload remains the
  // source of its presentation until it is edited or included in apply-to-all.
  const properties = page?.pagePropertyOverrides !== undefined
    ? { ...defaults, ...page.pagePropertyOverrides }
    : { ...defaults, ...(legacyProperties ?? {}) };
  if ((properties.pageSize === 'Infinite' || properties.layoutMode === 'document') && Number.isFinite(legacyProperties?.layoutExtent) && legacyProperties!.layoutExtent! >= 0) properties.layoutExtent = legacyProperties!.layoutExtent;
  return properties;
}

/**
 * Pages created after page-property metadata was introduced always carry an
 * overrides object, including an empty one. Older pages stored appearance only
 * inside DrawingData. Those legacy pages must resolve that record before their
 * shell is painted, otherwise the notebook briefly shows its defaults.
 */
export function hasAuthoritativePageAppearance(
  page: Pick<NotebookPage, 'pagePropertyOverrides'>,
  cachedProperties?: PagePropertySet,
): boolean {
  return page.pagePropertyOverrides !== undefined || cachedProperties !== undefined;
}

/**
 * Resolve the properties used by a visible page view.
 *
 * A page's in-memory/cache snapshot may be newer than its metadata override.
 * Merge that snapshot after inheritance for every page state. Restricting the
 * merge to the focused page makes the same page switch appearance as scrolling
 * toggles active ownership.
 */
export function resolvePageRenderProperties(
  notebook: Notebook | undefined,
  page: NotebookPage | undefined,
  cachedProperties: Partial<PagePropertySet> | undefined,
): PagePropertySet {
  const resolved = resolvePageProperties(notebook, page, cachedProperties);
  return cachedProperties ? { ...resolved, ...cachedProperties } : resolved;
}

export function derivePagePropertyOverrides(
  properties: PagePropertySet,
  notebook?: Notebook,
): Partial<PagePropertySet> {
  const defaults = getNotebookPageDefaults(notebook);
  const overrides: Partial<PagePropertySet> = {};
  const keys = new Set<keyof PagePropertySet>([
    ...(Object.keys(defaults) as (keyof PagePropertySet)[]),
    ...(Object.keys(properties) as (keyof PagePropertySet)[]),
  ]);
  for (const key of keys) {
    if (key === 'layoutExtent') continue;
    if (properties[key] !== defaults[key]) {
      // TypeScript cannot correlate the indexed key/value pair here, but both
      // come from the same PagePropertySet contract.
      (overrides as Record<string, unknown>)[key] = properties[key];
    }
  }
  if (properties.templateFields && Object.keys(properties.templateFields).length > 0) {
    overrides.templateFields = { ...properties.templateFields };
  }
  return overrides;
}
