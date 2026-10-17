import { TableView } from '@tiptap/extension-table';
import { TableMap } from '@tiptap/pm/tables';
import { getRenderedAttributes, type NodeViewRenderer } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorView, ViewMutationRecord } from '@tiptap/pm/view';
import { NOTEBOOK_TABLE_COLUMN_MIN_WIDTH } from './notebookDocumentView';

interface CellLayout {
  node: ProseMirrorNode; pos: number; dom: HTMLTableCellElement;
  left: number; right: number; top: number; bottom: number;
}
const participants = new WeakMap<HTMLElement, DocumentTableView>();
export const documentTableParticipant = (dom: HTMLElement) => participants.get(dom);

/** Keep derived track styles out of the DOM-to-document observer. */
export function documentTablePartView(tag: 'tr' | 'td' | 'th', defaults: Record<string, unknown>): NodeViewRenderer {
  return ({ editor, node }) => {
    const dom = document.createElement(tag);
    let current = node, keys = new Set<string>();
    const paint = () => {
      const attributes = { ...defaults, ...getRenderedAttributes(current, editor.extensionManager.attributes) };
      const layout = { display: dom.style.display, gridRow: dom.style.gridRow, gridColumn: dom.style.gridColumn, minWidth: dom.style.minWidth };
      for (const key of keys) if (!(key in attributes)) dom.removeAttribute(key);
      for (const [key, value] of Object.entries(attributes)) if (value != null) dom.setAttribute(key, String(value));
      Object.assign(dom.style, layout);
      keys = new Set(Object.keys(attributes));
    };
    paint();
    return { dom, contentDOM: dom,
      update: next => { if (next.type !== current.type) return false; current = next; paint(); return true; },
      ignoreMutation: mutation => mutation.type === 'attributes' && mutation.target === dom,
    };
  };
}

/** Native table schema, maps and commands; only flowing views use grid tracks.
 * Gap tracks do not add DOM rows or change authoring row/column spans.
 */
export class DocumentTableView extends TableView {
  private flowing: boolean;
  private destroyed = false;
  private columnsObserver?: MutationObserver;
  private view?: EditorView;
  private heights: number[] = [];
  private gaps: number[] = [];

  constructor(node: ProseMirrorNode, minimumWidth: number, view?: EditorView, attributes: Record<string, unknown> = {}) {
    super(node, minimumWidth, view, attributes);
    this.dom.tabIndex = 0; this.dom.setAttribute('role', 'region'); this.dom.setAttribute('aria-label', 'Table, scroll horizontally');
    this.view = view;
    const attrs = typeof view?.props.attributes === 'function' ? view.props.attributes(view.state) : view?.props.attributes;
    this.flowing = String(attrs?.class ?? '').includes('panvas-document-content');
    if (!this.flowing) return;
    participants.set(this.dom, this);
    this.table.classList.add('panvas-flow-table');
    this.table.style.display = 'block';
    this.colgroup.style.display = 'none';
    this.contentDOM.style.display = 'grid';
    this.columnsObserver = new MutationObserver(() => {
      this.columns();
      this.view?.dom.dispatchEvent(new Event('panvas-layout'));
    });
    this.columnsObserver.observe(this.colgroup, { subtree: true, attributes: true, childList: true });
    queueMicrotask(() => { if (!this.destroyed) this.resetLayout(); });
  }

  update(node: ProseMirrorNode): boolean {
    const changed = node !== this.node;
    if (!super.update(node)) return false;
    if (this.flowing) this.columns();
    if (this.flowing && changed) queueMicrotask(() => {
      if (!this.destroyed) { this.resetLayout(); this.view?.dom.dispatchEvent(new Event('panvas-layout')); }
    });
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (this.flowing && mutation.type === 'attributes' && mutation.attributeName === 'style'
      && mutation.target instanceof HTMLElement && (mutation.target === this.contentDOM
        || ['TR', 'TD', 'TH'].includes(mutation.target.tagName) && mutation.target.closest('table') === this.table)) return true;
    return super.ignoreMutation(mutation);
  }

  destroy(): void { this.destroyed = true; this.columnsObserver?.disconnect(); participants.delete(this.dom); }

  private columns(): void {
    const map = TableMap.get(this.node), columns = Array.from(this.colgroup.children) as HTMLTableColElement[];
    const widths = Array.from({ length: map.width }, (_, index) => parseFloat(columns[index]?.style.width) || 0);
    const minimum = Math.max(this.cellMinWidth, NOTEBOOK_TABLE_COLUMN_MIN_WIDTH);
    this.contentDOM.style.gridTemplateColumns = widths.map(width => width ? `${Math.max(minimum, width)}px` : `minmax(${minimum}px,1fr)`).join(' ');
    this.table.style.width = '100%';
    this.table.style.minWidth = `${widths.reduce((total, width) => total + Math.max(minimum, width), 0)}px`;
  }

  cells(): CellLayout[] {
    const map = TableMap.get(this.node), rows = Array.from(this.table.rows), cells: CellLayout[] = [];
    this.node.forEach((row, rowOffset, rowIndex) => row.forEach((cell, cellOffset, cellIndex) => {
      const pos = rowOffset + 1 + cellOffset, dom = rows[rowIndex]?.cells[cellIndex];
      if (!dom) return;
      const rect = map.findCell(pos);
      cells.push({ node: cell, pos, dom, ...rect });
    }));
    return cells;
  }

  resetLayout(): void {
    if (!this.flowing) return;
    this.heights = []; this.gaps = [];
    this.columns(); this.contentDOM.style.gridTemplateRows = '';
    for (const row of Array.from(this.table.rows)) row.style.display = 'contents';
    for (const cell of this.cells()) {
      cell.dom.style.display = 'block'; cell.dom.style.minWidth = '0';
      cell.dom.style.gridColumn = `${cell.left + 1} / ${cell.right + 1}`;
      cell.dom.style.gridRow = `${cell.top + 1} / ${cell.bottom + 1}`;
    }
  }

  private intrinsicHeight(dom: HTMLTableCellElement, scale: number): number {
    const rect = dom.getBoundingClientRect(), style = getComputedStyle(dom);
    const bottomPadding = parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
    let bottom = rect.top + parseFloat(style.paddingTop) * scale;
    for (const child of Array.from(dom.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const childRect = child.getBoundingClientRect();
      bottom = Math.max(bottom, childRect.bottom + (parseFloat(getComputedStyle(child).marginBottom) || 0) * scale);
    }
    return Math.max(24, (bottom - rect.top) / scale + bottomPadding);
  }

  measureRows(scale: number): number[] {
    const rows = Array.from({ length: this.node.childCount }, () => 24);
    const cells = this.cells();
    for (const cell of cells) if (cell.bottom === cell.top + 1) rows[cell.top] = Math.max(rows[cell.top], this.intrinsicHeight(cell.dom, scale));
    for (const cell of cells) if (cell.bottom > cell.top + 1) {
      const required = this.intrinsicHeight(cell.dom, scale), total = rows.slice(cell.top, cell.bottom).reduce((sum, height) => sum + height, 0);
      const extra = Math.max(0, required - total) / (cell.bottom - cell.top);
      for (let row = cell.top; row < cell.bottom; row++) rows[row] += extra;
    }
    return rows;
  }

  setTracks(heights: number[], gaps: number[]): void {
    this.heights = [...heights]; this.gaps = [...gaps];
    const starts: number[] = [], ends: number[] = [], tracks: string[] = [];
    heights.forEach((height, row) => {
      if (gaps[row] > .1) tracks.push(`${gaps[row]}px`);
      starts[row] = tracks.length + 1; tracks.push(`${height}px`); ends[row] = tracks.length + 1;
    });
    this.contentDOM.style.gridTemplateRows = tracks.join(' ');
    for (const cell of this.cells()) cell.dom.style.gridRow = `${starts[cell.top]} / ${ends[cell.bottom - 1]}`;
  }

  /** A split span can grow its last row without shifting its preceding content. */
  fitContent(scale: number): void {
    if (!this.heights.length) return;
    const heights = [...this.heights];
    for (const cell of this.cells()) {
      const allocated = heights.slice(cell.top, cell.bottom).reduce((sum, height) => sum + height, 0)
        + this.gaps.slice(cell.top + 1, cell.bottom).reduce((sum, height) => sum + height, 0);
      heights[cell.bottom - 1] += Math.max(0, this.intrinsicHeight(cell.dom, scale) - allocated);
    }
    this.setTracks(heights, this.gaps);
  }
}
