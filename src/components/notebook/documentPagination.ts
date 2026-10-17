import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { PagePropertySet } from '@/types/notebook';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { resolveBasePageDimensions } from '@/lib/pageProperties';
import { documentInsets, documentSheetStride } from './documentFlowGeometry';
import { documentTableParticipant, type DocumentTableView } from './DocumentTableView';

type Gap = { pos: number; height: number; row?: boolean; block?: boolean };
type Unit = { pos: number; top: number; bottom: number; row?: boolean; block?: boolean; heading?: boolean; cells?: Unit[][]; deliberateBreak?: boolean; table?: { node: ProseMirrorNode; pos: number; participant: DocumentTableView } };
type LineCache = WeakMap<ProseMirrorNode, { width: number; lines: Array<{ offset: number; top: number; bottom: number }> }>;
export interface DocumentLayoutConfig {
  properties: PagePropertySet;
  /** Export-only logical height when a continuous surface fits a physical sheet. */
  printPageHeight?: number;
  onLayout: (bottom: number, milliseconds: number, issues: string[]) => void;
}
export const documentPaginationKey = new PluginKey<DecorationSet>('panvasDocumentPagination');

function keepsCodeLineLayout(transaction: Transaction): boolean {
  const step = transaction.steps.length === 1 ? transaction.steps[0] : undefined;
  if (!(step instanceof ReplaceStep) || step.slice.openStart || step.slice.openEnd) return false;
  const from = transaction.before.resolve(step.from), to = transaction.before.resolve(step.to);
  if (!from.sameParent(to) || from.parent.type.name !== 'codeBlock' || from.parent.attrs.wrap) return false;
  let textOnly = true;
  step.slice.content.forEach(node => { if (!node.isText) textOnly = false; });
  return textOnly && !step.slice.content.textBetween(0, step.slice.content.size).includes('\n')
    && !from.parent.textBetween(from.parentOffset, to.parentOffset).includes('\n');
}

function decoration(gap: Gap): Decoration {
  if (gap.block) return Decoration.widget(gap.pos, () => {
    const element = document.createElement('div');
    element.className = 'panvas-page-gap'; element.style.height = `${gap.height}px`;
    element.contentEditable = 'false'; element.setAttribute('aria-hidden', 'true');
    return element;
  }, { side: -1, key: `${gap.pos}:${gap.height}` });
  return Decoration.widget(gap.pos, () => {
    const element = document.createElement(gap.row ? 'tr' : 'span');
    element.className = 'panvas-page-gap'; element.contentEditable = 'false';
    element.setAttribute('aria-hidden', 'true');
    if (gap.row) {
      const cell = document.createElement('td'); cell.colSpan = 100;
      cell.style.cssText = `height:${gap.height}px;padding:0;border:0;`;
      element.append(cell);
    } else element.style.cssText = `display:block;height:${gap.height}px;width:100%;line-height:0;`;
    return element;
  }, { side: -1, key: `${gap.pos}:${gap.height}`, ignoreSelection: true });
}

/** View-only spacers. Never split or duplicate the ProseMirror document. */
export function createDocumentPagination(config: () => DocumentLayoutConfig) {
  return Extension.create({
    name: 'panvasDocumentPagination',
    addProseMirrorPlugins() {
      let codeLineLayoutUnchanged = false;
      return [new Plugin<DecorationSet>({
        key: documentPaginationKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (transaction, previous) => {
            codeLineLayoutUnchanged = transaction.docChanged && keepsCodeLineLayout(transaction);
            const gaps = transaction.getMeta(documentPaginationKey) as Gap[] | undefined;
            if (gaps) return DecorationSet.create(transaction.doc, gaps.map(decoration));
            if (codeLineLayoutUnchanged) return previous.map(transaction.mapping, transaction.doc);
            return transaction.docChanged ? DecorationSet.empty : previous;
          },
        },
        props: {
          decorations: state => documentPaginationKey.getState(state),
          handleKeyDown: (view, event) => {
            if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return false;
            const { selection, doc } = view.state;
            if (!(selection instanceof TextSelection)) return false;
            if (!event.shiftKey && !selection.empty) return false;
            const gaps = documentPaginationKey.getState(view.state)?.find() ?? [];
            let target: number | undefined;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              const direction = event.key === 'ArrowRight' ? 1 : -1;
              if (!gaps.some(gap => Math.abs(gap.from - selection.head) <= 1)) return false;
              const $head = selection.$head, offset = $head.parentOffset;
              const text = $head.parent.textBetween(0, $head.parent.content.size, '', '\ufffc');
              let distance = 1;
              // Preserve native UTF-16 surrogate pairs at a visual line seam.
              const first = text.charCodeAt(direction > 0 ? offset : offset - 2);
              const second = text.charCodeAt(direction > 0 ? offset + 1 : offset - 1);
              if (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) distance = 2;
              target = Math.max(0, Math.min(doc.content.size, selection.head + direction * distance));
            } else {
              const current = view.coordsAtPos(selection.head);
              const down = event.key === 'ArrowDown';
              for (const gap of gaps) {
                if (!gap.from || gap.from >= doc.content.size) continue;
                const parent = doc.resolve(gap.from).parent;
                if (parent.isTextblock && parent !== selection.$head.parent) continue;
                const before = view.coordsAtPos(gap.from - 1), after = view.coordsAtPos(gap.from + 1);
                if (Math.abs(current.top - (down ? before.top : after.top)) > 1 || after.top - before.top < 20) continue;
                const line = down ? after : before;
                target = view.posAtCoords({ left: current.left, top: (line.top + line.bottom) / 2 })?.pos;
                // At a wrapped line's far edge, posAtCoords can return the
                // position whose caret has already moved onto the next line.
                // Keep the target inside the requested visible row, including
                // surrogate pairs, so the reverse arrow crosses the same gap.
                for (let attempt = 0; target !== undefined && attempt < 3; attempt++) {
                  const caret = view.coordsAtPos(target);
                  if (caret.top < line.bottom - .5 && caret.bottom > line.top + .5) break;
                  const direction = caret.top >= line.bottom - .5 ? -1 : 1;
                  const $target = doc.resolve(target), text = $target.parent.textBetween(0, $target.parent.content.size, '', '\ufffc'), offset = $target.parentOffset;
                  const first = text.charCodeAt(direction > 0 ? offset : offset - 2), second = text.charCodeAt(direction > 0 ? offset + 1 : offset - 1);
                  const distance = first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? 2 : 1;
                  target = Math.max(0, Math.min(doc.content.size, target + direction * distance));
                }
                break;
              }
            }
            if (target === undefined || target === selection.head) return false;
            const next = Selection.near(doc.resolve(target), target > selection.head ? 1 : -1);
            view.dispatch(view.state.tr.setSelection(event.shiftKey ? TextSelection.create(doc, selection.anchor, next.head) : next).scrollIntoView());
            return true;
          },
        },
        view: view => {
          let frame = 0, disposed = false, publishing = false;
          let lastPageSize: PagePropertySet['pageSize'] | undefined;
          let cache: LineCache = new WeakMap();
          const measure = () => {
            frame = 0;
            if (disposed || !view.dom.isConnected) return;
            if (view.composing) { schedule(); return; }
            const started = performance.now();
            const { properties, onLayout, printPageHeight } = config();
            publishing = true;
            // Clear old presentation synchronously before measuring natural flow.
            if (documentPaginationKey.getState(view.state)?.find().length) view.dispatch(view.state.tr.setMeta(documentPaginationKey, []).setMeta('addToHistory', false));
            if (properties.pageSize !== 'Infinite' || lastPageSize !== 'Infinite') view.state.doc.descendants((node, pos) => {
              if (node.type.name === 'table') {
                const dom = view.nodeDOM(pos);
                if (dom instanceof HTMLElement) documentTableParticipant(dom)?.resetLayout();
              }
              return true;
            });
            const rect = view.dom.getBoundingClientRect();
            const scale = rect.width / view.dom.offsetWidth || 1;
            const naturalHeight = view.dom.offsetHeight;
            const gaps: Gap[] = [], issues: string[] = [];
            lastPageSize = properties.pageSize;
            if (properties.pageSize === 'Infinite') {
              publishing = false;
              onLayout(naturalHeight, performance.now() - started, issues);
              return;
            }
            {
              const baseHeight = resolveBasePageDimensions(properties).height;
              const inset = documentInsets(properties), pageHeight = printPageHeight ?? baseHeight;
              const writingHeight = pageHeight - inset * 2, stride = documentSheetStride(properties) + pageHeight - baseHeight;
              const units = layoutUnits(view, rect.top, scale, writingHeight, issues, cache);
              let shift = 0, sheet = 0;
              for (let index = 0; index < units.length; index++) {
                const unit = units[index];
                if (unit.table) {
                  shift = paginateTable(view, unit.table, rect.top, scale, shift, writingHeight, stride, gaps, issues, cache, unit.bottom);
                  sheet = Math.floor((unit.bottom + shift) / stride);
                  continue;
                }
                if (unit.deliberateBreak) {
                  const target = (Math.floor((unit.top + shift) / stride) + 1) * stride;
                  const height = Math.max(0, target - unit.top - shift);
                  gaps.push({ pos: unit.pos, height, block: true }); shift += height;
                  sheet = Math.floor(target / stride); continue;
                }
                if (unit.cells) {
                  let rowShift = 0, finalSheet = sheet;
                  for (const cell of unit.cells) {
                    let cellShift = shift, cellSheet = sheet;
                    for (const line of cell) {
                      if (line.bottom + cellShift > cellSheet * stride + writingHeight + .5) {
                        const height = Math.max(0, (cellSheet + 1) * stride - line.top - cellShift);
                        if (height) { gaps.push({ pos: line.pos, height }); cellShift += height; }
                        cellSheet++;
                      }
                    }
                    rowShift = Math.max(rowShift, cellShift - shift);
                    finalSheet = Math.max(finalSheet, cellSheet);
                  }
                  shift += rowShift; sheet = finalSheet;
                  continue;
                }
                let bottom = unit.bottom + shift;
                if (unit.heading && units[index + 1]) bottom = Math.max(bottom, units[index + 1].bottom + shift);
                const limit = sheet * stride + writingHeight;
                if (bottom > limit + .5) {
                  const nextTop = (sheet + 1) * stride;
                  const height = Math.max(0, nextTop - (unit.top + shift));
                  if (height > 0) {
                    gaps.push({ pos: unit.pos, height, row: unit.row, block: unit.block });
                    shift += height;
                  }
                  sheet++;
                }
              }
            }
            const presentation = view.state.tr.setMeta(documentPaginationKey, gaps).setMeta('addToHistory', false);
            if (view.hasFocus()) presentation.scrollIntoView();
            view.dispatch(presentation);
            publishing = false;
            onLayout(Math.max(naturalHeight, view.dom.offsetHeight), performance.now() - started, issues);
          };
          const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(measure); };
          const resize = new ResizeObserver(() => { if (!publishing) schedule(); });
          // Width changes, font loading and collapse affect pagination independently of JSON.
          resize.observe(view.dom);
          const onToggle = (event: Event) => {
            if (event.type === 'toggle' && event.target instanceof HTMLElement && event.target.classList.contains('panvas-code-language')) return;
            if (event.type === 'panvas-layout') cache = new WeakMap();
            schedule();
          };
          const onFonts = () => { cache = new WeakMap(); schedule(); };
          view.dom.addEventListener('toggle', onToggle, true);
          view.dom.addEventListener('compositionend', onToggle);
          view.dom.addEventListener('panvas-layout', onToggle);
          document.fonts.ready.then(schedule);
          document.fonts.addEventListener('loadingdone', onFonts);
          schedule();
          return {
            update: (_view, previous) => {
              // ResizeObserver owns width/height invalidation. Reading offsetWidth
              // here forces layout during every text and selection transaction,
              // before the scheduled pagination measurement can batch DOM work.
              // Unwrapped code edits without newline changes retain line boxes.
              // Map the existing view spacers instead of rebuilding every sheet.
              // ResizeObserver still catches scrollbar/size changes; newlines,
              // wrapping, fonts and all other edits take the normal measure path.
              if (!publishing && view.state.doc !== previous.doc && !codeLineLayoutUnchanged) schedule();
            },
            destroy: () => {
              disposed = true; cancelAnimationFrame(frame); resize.disconnect();
              view.dom.removeEventListener('toggle', onToggle, true);
              view.dom.removeEventListener('compositionend', onToggle);
              view.dom.removeEventListener('panvas-layout', onToggle);
              document.fonts.removeEventListener('loadingdone', onFonts);
            },
          };
        },
      })];
    },
  });
}

function layoutUnits(view: EditorView, origin: number, scale: number, writingHeight: number, issues: string[], cache: LineCache): Unit[] {
  const units: Unit[] = [];
  view.state.doc.descendants((node, pos) => {
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement) || dom.getClientRects().length === 0) return false;
    const box = dom.getBoundingClientRect();
    if (node.type.name === 'table') {
      const participant = documentTableParticipant(dom);
      if (participant) {
        units.push({ pos, top: (box.top - origin) / scale, bottom: (box.bottom - origin) / scale, table: { node, pos, participant } });
        return false;
      }
    }
    if (node.type.name === 'tableRow') {
      const height = box.height / scale;
      const row: Unit = { pos, top: (box.top - origin) / scale, bottom: (box.bottom - origin) / scale, row: true };
      if (height > writingHeight) {
        row.cells = [];
        node.forEach((cell, cellOffset) => {
          const cellLines: Unit[] = [];
          cell.descendants((block, blockOffset) => {
            if (block.isTextblock) { cellLines.push(...textLines(view, pos + 2 + cellOffset + blockOffset, block, origin, scale, cache)); return false; }
            return true;
          });
          row.cells!.push(cellLines);
        });
      }
      units.push(row);
      return false;
    }
    if (node.isTextblock) {
      const lines = textLines(view, pos, node, origin, scale, cache);
      if (node.type.name === 'codeBlock' && lines.length) {
        lines[0] = { ...lines[0], pos, top: (box.top - origin) / scale, block: true };
        // Keep the final source line, code padding, and optional caption together.
        lines[lines.length - 1] = { ...lines[lines.length - 1], bottom: (box.bottom - origin) / scale };
      }
      lines.forEach(line => {
        line.heading = node.type.name === 'heading';
        if (line.bottom - line.top > writingHeight) issues.push('A line exceeds the writing area. Reduce its font size or use Infinite.');
      });
      units.push(...lines);
      return false;
    }
    if (node.isAtom && node.isBlock) {
      units.push({ pos, top: (box.top - origin) / scale, bottom: (box.bottom - origin) / scale, block: true, deliberateBreak: node.type.name === 'documentPageBreak' });
      if (box.height / scale > writingHeight) issues.push('An indivisible block exceeds the writing area. Use Infinite or reduce its size.');
      return false;
    }
    return true;
  });
  return units.sort((a, b) => a.top - b.top || a.pos - b.pos);
}

function paginateTable(view: EditorView, table: NonNullable<Unit['table']>, origin: number, scale: number,
  incomingShift: number, writingHeight: number, stride: number, gaps: Gap[], issues: string[], cache: LineCache, naturalBottom: number): number {
  const participant = table.participant;
  const natural = participant.dom.getBoundingClientRect();
  const top = (natural.top - origin) / scale + incomingShift;
  if ((natural.bottom - origin) / scale + incomingShift <= Math.floor(top / stride) * stride + writingHeight + .5) return incomingShift;
  const heights = participant.measureRows(scale), rowGaps = heights.map(() => 0);
  let rowTop = (participant.contentDOM.getBoundingClientRect().top - origin) / scale + incomingShift;
  heights.forEach((height, row) => {
    const sheet = Math.floor(rowTop / stride);
    if (height <= writingHeight && rowTop + height > sheet * stride + writingHeight + .5) rowGaps[row] = Math.max(0, (sheet + 1) * stride - rowTop);
    rowTop += rowGaps[row] + height;
  });
  participant.setTracks(heights, rowGaps);
  const cellLines = (cell: ReturnType<DocumentTableView['cells']>[number], lineCache: LineCache): Unit[] => {
    const currentOrigin = view.dom.getBoundingClientRect().top;
    const lines: Unit[] = [];
    cell.node.descendants((block, offset) => {
      const pos = table.pos + 2 + cell.pos + offset;
      const dom = view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement) || !dom.getClientRects().length) return false;
      if (block.isTextblock) { lines.push(...textLines(view, pos, block, currentOrigin, scale, lineCache)); return false; }
      if (block.isBlock && block.isAtom) {
        const rect = dom.getBoundingClientRect();
        lines.push({ pos, top: (rect.top - currentOrigin) / scale, bottom: (rect.bottom - currentOrigin) / scale, block: true });
        return false;
      }
      return true;
    });
    return lines;
  };
  for (const cell of participant.cells()) {
    let shift = incomingShift;
    for (const line of cellLines(cell, cache)) {
      if (line.bottom - line.top > writingHeight) { issues.push('An indivisible table-cell block exceeds the writing area. Use Infinite.'); continue; }
      const top = line.top + shift, sheet = Math.floor(top / stride);
      if (line.bottom + shift > sheet * stride + writingHeight + .5) {
        const height = Math.max(0, (sheet + 1) * stride - top);
        if (height > .1) { gaps.push({ pos: line.pos, height, block: line.block }); shift += height; }
      }
    }
  }
  const apply = () => {
    view.dispatch(view.state.tr.setMeta(documentPaginationKey, gaps).setMeta('addToHistory', false));
    participant.fitContent(scale);
  };
  apply();
  // Span constraints can move later cells. Validate their actual caret rectangles,
  // adding view-only space until every line is back inside a writing area.
  for (let attempt = 0; attempt < 12; attempt++) {
    let changed = false;
    const actual: LineCache = new WeakMap();
    for (const cell of participant.cells()) {
      let added = 0;
      for (const line of cellLines(cell, actual)) {
        if (line.bottom - line.top > writingHeight) continue;
        const top = line.top + added, sheet = Math.floor(top / stride);
        if (line.bottom + added <= sheet * stride + writingHeight + .5) continue;
        const height = Math.max(0, (sheet + 1) * stride - top);
        if (height < .1) continue;
        const existing = gaps.find(gap => gap.pos === line.pos);
        if (existing) existing.height += height; else gaps.push({ pos: line.pos, height, block: line.block });
        added += height; changed = true;
      }
    }
    if (!changed) break;
    apply();
    if (attempt === 11) issues.push('This table needs a simpler span layout or Infinite to fit reliably.');
  }
  return Math.max(0, (participant.dom.getBoundingClientRect().bottom - view.dom.getBoundingClientRect().top) / scale - naturalBottom);
}

function textLines(view: EditorView, pos: number, node: ProseMirrorNode, origin: number, scale: number, cache: LineCache): Unit[] {
  const element = view.nodeDOM(pos) as HTMLElement;
  const rect = element.getBoundingClientRect(), blockTop = (rect.top - origin) / scale, width = rect.width / scale;
  const cached = cache.get(node);
  if (cached && Math.abs(cached.width - width) < .1) return cached.lines.map(line => ({ pos: pos + 1 + line.offset, top: blockTop + line.top, bottom: blockTop + line.bottom }));
  const size = node.content.size;
  const lines: Unit[] = [];
  if (node.type.name === 'codeBlock' && !node.attrs.wrap) {
    // Unwrapped code has only explicit source newlines. Binary searching every
    // visual line needlessly asks ProseMirror for hundreds of caret rectangles.
    // Still measure each line, so font sizes, indentation and page seams retain
    // the same geometry as the general (wrapped prose/code) path below.
    const source = node.textContent;
    let start = 0;
    while (start <= size) {
      const caret = view.coordsAtPos(pos + 1 + start, 1);
      lines.push({ pos: pos + 1 + start, top: (caret.top - origin) / scale, bottom: (caret.bottom - origin) / scale });
      const newline = source.indexOf('\n', start);
      if (newline < 0) break;
      start = newline + 1;
    }
    cache.set(node, { width, lines: lines.map(line => ({ offset: line.pos - pos - 1, top: line.top - blockTop, bottom: line.bottom - blockTop })) });
    return lines;
  }
  let offset = 0;
  while (offset <= size) {
    const caret = view.coordsAtPos(pos + 1 + offset, 1);
    lines.push({ pos: pos + 1 + offset, top: (caret.top - origin) / scale, bottom: (caret.bottom - origin) / scale });
    if (offset === size) break;
    let low = offset + 1, high = size + 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (mid <= size && view.coordsAtPos(pos + 1 + mid, 1).top <= caret.top + .5 * scale) low = mid + 1;
      else high = mid;
    }
    if (low > size) break;
    offset = low;
  }
  cache.set(node, { width, lines: lines.map(line => ({ offset: line.pos - pos - 1, top: line.top - blockTop, bottom: line.bottom - blockTop })) });
  return lines;
}
