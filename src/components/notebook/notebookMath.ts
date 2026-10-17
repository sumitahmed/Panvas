import { InputRule } from '@tiptap/core';
import { InlineMath, BlockMath } from '@tiptap/extension-mathematics';
import katex, { type KatexOptions } from 'katex';
import 'katex/dist/katex.min.css';

export const notebookKatexOptions: KatexOptions = Object.freeze({
  trust: false, throwOnError: false, strict: 'warn', maxExpand: 1000, maxSize: 20,
  output: 'htmlAndMathml',
});

// Deliberate LaTeX delimiters only. Do not migrate legacy dollar signs or prices.
export const NotebookInlineMath = InlineMath.extend({
  addInputRules() {
    return [new InputRule({
      find: /\\\(([^\n]+?)\\\)$/,
      handler: ({ state, range, match }) => {
        state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[1] }));
      },
    })];
  },
}).configure({ katexOptions: notebookKatexOptions });

export const NotebookBlockMath = BlockMath.extend({
  addInputRules() {
    return [new InputRule({
      find: /^\\\[([^\n]+?)\\\]$/,
      handler: ({ state, range, match }) => {
        const $from = state.doc.resolve(range.from);
        if (!$from.parent.isTextblock) return;
        state.tr.replaceWith($from.before(), $from.after(), this.type.create({ latex: match[1] }));
      },
    })];
  },
}).configure({ katexOptions: { ...notebookKatexOptions, displayMode: true } });

/** Called only on authoring nodes, never on arbitrary imported presentation HTML. */
export function renderStaticMath(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-type="inline-math"], [data-type="block-math"]').forEach(element => {
    const latex = element.getAttribute('data-latex') ?? '';
    const displayMode = element.dataset.type === 'block-math';
    element.classList.add('tiptap-mathematics-render');
    try {
      katex.render(latex, element, { ...notebookKatexOptions, displayMode });
    } catch {
      element.textContent = latex;
      element.classList.add('math-source-error');
    }
  });
}
