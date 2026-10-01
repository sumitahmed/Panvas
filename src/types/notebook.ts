export type PageTemplateId =
  | 'Blank'
  | 'Ruled' | 'Narrow ruled' | 'Wide ruled'
  | 'Large ruled with margin' | 'Double margin ruled'
  | 'Small grid' | 'Large grid' | 'Dotted' | 'Engineering'
  | 'Cornell' | 'Lecture Notes' | 'Assignment' | 'Checklist'
  | 'To-do' | 'Daily planner' | 'Weekly planner' | 'Monthly planner'
  | 'Journal' | 'Music' | 'Calendar';

/** Portable document properties. View zoom intentionally lives outside this model. */
export interface PagePropertySet {
  paperColor: string;
  template: PageTemplateId;
  ruleLineColor: string;
  orientation: 'portrait' | 'landscape';
  pageSize: 'A3' | 'A4' | 'A5' | 'Letter' | 'Custom';
  margins: 'No Margin' | 'Normal' | 'Narrow' | 'Wide';
  /** User-entered values for editable labels supplied by structured paper templates. */
  templateFields?: Record<string, string>;
  /** Additional writable page space in logical page pixels. The source page/PDF is unchanged. */
  extraHeight?: number;
  /** Writable research space surrounding the fixed-size source page. */
  extraTop?: number;
  extraRight?: number;
  extraBottom?: number;
  extraLeft?: number;
}

export const DEFAULT_PAGE_PROPERTY_SET: PagePropertySet = {
  paperColor: '#ffffff',
  template: 'Blank',
  ruleLineColor: '#e0e0e0',
  orientation: 'portrait',
  pageSize: 'A4',
  margins: 'Normal',
  extraHeight: 0,
};

export type NotebookCoverTemplateId = 'linen' | 'leather' | 'midnight' | 'sage' | 'plum' | 'sand';

export type NotebookCover =
  | { kind: 'template'; id: NotebookCoverTemplateId }
  | { kind: 'image'; dataUrl: string; position?: string };

export interface Notebook {
  id: string;
  workspaceId: string;
  folderId: string | null;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
  order: number;
  isExpanded: boolean;
  isPinned?: boolean;
  userId: string | null;
  deletedAt?: number | null;
  /** Set only when an ancestor deletion hid this record from Trash roots. */
  deletedByAncestorId?: string | null;
  /** Defaults inherited by pages that do not override a property. */
  defaultPageProperties?: PagePropertySet;
  /** Optional shelf cover; stored as a template descriptor or bounded data URL. */
  cover?: NotebookCover;
}

export interface NotebookSection {
  id: string;
  notebookId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  order: number;
  isExpanded: boolean;
  userId: string | null;
  deletedAt?: number | null;
  /** Set only when an ancestor deletion hid this record from Trash roots. */
  deletedByAncestorId?: string | null;
}

export interface NotebookPage {
  id: string;
  notebookId: string;
  sectionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
  order: number;
  userId: string | null;
  deletedAt?: number | null;
  /** Set only when an ancestor deletion hid this record from Trash roots. */
  deletedByAncestorId?: string | null;
  type?: 'default' | 'pdf';
  pdfDataId?: string;
  /** Non-destructive PDF viewer state. Source-page annotations stay keyed by source page. */
  pdfPageState?: PdfPageState;
  /** Only values that differ from the owning notebook defaults. */
  pagePropertyOverrides?: Partial<PagePropertySet>;
}

export type PdfPageRotation = 0 | 90 | 180 | 270;

export interface PdfPageState {
  version: 1;
  /** Ordered source-page numbers. This never rewrites the original PDF bytes. */
  pageOrder: number[];
  /** Clockwise rotation relative to the source page's intrinsic rotation. */
  rotations: Record<number, PdfPageRotation>;
}

export interface NotebookPropertyBatchSnapshot {
  notebookId: string;
  defaultPageProperties: PagePropertySet;
  pages: Array<{ pageId: string; overrides: Partial<PagePropertySet> }>;
}

/** Browser-local persisted rich page content (Electron stores the same payload in a JSON file). */
export interface NotebookPageContentRecord {
  pageId: string;
  workspaceId: string;
  notebookId: string;
  data: unknown;
  version: 1;
  updatedAt: number;
  userId: string | null;
}

/** Browser-local persisted drawing payload (Electron stores the same payload in a JSON file). */
export interface NotebookPageDrawingRecord {
  pageId: string;
  workspaceId: string;
  notebookId: string;
  data: unknown;
  version: 1;
  updatedAt: number;
  userId: string | null;
}
