import './documentation-flow';
import { notebookRepository } from '../../src/repositories/NotebookRepository';

// Profiling instrumentation is confined to this disposable application fixture.
// Inclusive timings overlap and must not be added together.
const fixture = () => (window as any).richFixture;
const flow = () => (window as any).flowFixture;
let active = false, metrics: Record<string, any> = {}, inputPaint: number[] = [];
const wrapped = new WeakMap<object, Set<string>>();
const record = (name: string, duration = 0) => {
  if (!active) return;
  const value = metrics[name] ??= { count: 0, totalMs: 0, maxMs: 0 };
  value.count++; value.totalMs += duration; value.maxMs = Math.max(value.maxMs, duration);
};
function instrument(target: any, key: string, name = key) {
  if (!target || typeof target[key] !== 'function') return;
  const keys = wrapped.get(target) ?? new Set<string>();
  if (keys.has(key)) return;
  keys.add(key); wrapped.set(target, keys);
  const original = target[key];
  target[key] = function(...args: any[]) {
    const started = performance.now();
    try {
      const result = original.apply(this, args);
      if (result?.then) return result.finally(() => record(name, performance.now() - started));
      record(name, performance.now() - started); return result;
    } catch (error) { record(name, performance.now() - started); throw error; }
  };
}
const OriginalResizeObserver = ResizeObserver;
window.ResizeObserver = class extends OriginalResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    super((entries, observer) => {
      const started = performance.now(); callback(entries, observer);
      record('resizeObserver', performance.now() - started);
      for (const entry of entries) if (entry.target.matches('.panvas-document-content')) record('documentResize');
    });
  }
};
instrument(JSON, 'stringify', 'stringify');
instrument(window, 'structuredClone', 'clone');
instrument(notebookRepository, 'saveDrawingData', 'repositoryWrite');
new PerformanceObserver(list => {
  for (const entry of list.getEntries()) record('longTask', entry.duration);
}).observe({ type: 'longtask', buffered: false });
document.addEventListener('beforeinput', event => {
  if (!active || !(event.target instanceof Element) || !event.target.closest('.ProseMirror')) return;
  const started = performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => { if (active) inputPaint.push(performance.now() - started); }));
}, true);
const attach = () => {
  const engine = fixture().engine(), editor = flow().editor() ?? engine.texts.getEditor('rich-text-0');
  for (const method of ['getDrawingData', 'setDrawingData', 'setProperties']) instrument(engine, method);
  instrument(engine.drawing, 'redraw', 'canvasRedraw'); instrument(engine.input, 'notifyChange');
  instrument(engine.texts, 'updateTextContent'); instrument(editor, 'getJSON', 'editorJSON');
  instrument(editor.view, 'dispatch', 'transactionDispatch');
  if (!wrapped.get(editor)?.has('events')) {
    const keys = wrapped.get(editor) ?? new Set<string>(); keys.add('events'); wrapped.set(editor, keys);
    editor.on('transaction', ({ transaction }: any) => {
      record('transactions'); if (transaction.docChanged) record('documentTransactions');
      if (transaction.selectionSet) record('selectionTransactions');
      if (Object.keys(transaction.meta).some(key => key.includes('panvasDocumentPagination'))) record('paginationTransactions');
    });
    editor.on('destroy', () => record('editorDestroy'));
  }
};
Object.assign(window, { stabilizationProfile: {
  commit: (_phase: string, duration: number) => record('reactCommit', duration),
  begin: () => { attach(); metrics = {}; inputPaint = []; active = true; },
  end: () => { active = false; return { metrics, inputPaint }; },
  editor: () => flow().editor() ?? fixture().engine().texts.getEditor('rich-text-0'),
  table: () => {
    const editor = (window as any).stabilizationProfile.editor();
    return [...editor.view.dom.querySelectorAll('table')].map((table: HTMLTableElement) => ({
      width: table.getBoundingClientRect().width, wrapper: table.parentElement!.getBoundingClientRect().width,
      columns: [...table.rows[0].cells].map(cell => ({ width: cell.getBoundingClientRect().width, text: cell.textContent, break: getComputedStyle(cell).overflowWrap })),
      editorWidth: editor.view.dom.getBoundingClientRect().width,
    }));
  },
  prepareFreeform: async (content: any, width = 240) => {
    await fixture().reset([content]);
    const engine = fixture().engine(), text = engine.texts.getTexts()[0]; text.width = width;
    engine.input.notifyChange();
  },
} });
