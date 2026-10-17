import type { Editor } from '@tiptap/react';
import type { NotebookEngine } from './engine/NotebookEngine';
import type { Selection, Transaction } from '@tiptap/pm/state';
import type { Node } from '@tiptap/pm/model';

export interface FormattingSelection {
  from: number;
  to: number;
}
const retainedSelections = new WeakMap<FormattingSelection, { selection: Selection; doc: Node }>();
const normalizedColors = new Map<string, string>();

export type FormattingCommand = (chain: any) => any;

export function isUsableFormattingEditor(editor: Editor | null | undefined): editor is Editor {
  return Boolean(editor && !editor.isDestroyed);
}

/**
 * Resolve one deterministic formatting target. Historical selections in unrelated editors
 * are deliberately ignored: ProseMirror retains them after blur, so they are not evidence
 * that an editor is still active.
 */
export function resolveFormattingEditor(
  activeEditor: Editor | null,
  engine: NotebookEngine,
): Editor | null {
  if (isUsableFormattingEditor(activeEditor)) return activeEditor;

  const selectedText = engine.selection
    .getSelectedElements()
    .find(element => element.type === 'text');
  if (!selectedText) return null;

  const selectedEditor = engine.texts.getEditor(selectedText.id) as Editor | undefined;
  return isUsableFormattingEditor(selectedEditor) ? selectedEditor : null;
}

export function captureFormattingSelection(editor: Editor): FormattingSelection {
  const { from, to } = editor.state.selection;
  const range = { from, to };
  if (typeof editor.state.selection.toJSON === 'function') retainedSelections.set(range, { selection: editor.state.selection, doc: editor.state.doc });
  return range;
}

export function mapFormattingSelection(range: FormattingSelection | null, tr: Transaction): FormattingSelection | null {
  if (!range || !tr.docChanged) return range;
  const retained = retainedSelections.get(range);
  if (!retained || retained.doc !== tr.before) return null;
  const selection = retained.selection.map(tr.doc, tr.mapping);
  const mapped = { from: selection.from, to: selection.to };
  retainedSelections.set(mapped, { selection, doc: tr.doc });
  return mapped;
}

/** Compare CSS colors without losing alpha or mistaking equivalent syntax for mixed colors. */
function formattingColorKey(value: string): string {
  if (/^#[\da-f]{6}$/i.test(value)) return value.toLowerCase();
  const cached = normalizedColors.get(value);
  if (cached) return cached;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return value;
  context.fillStyle = value;
  const normalized = String(context.fillStyle).toLowerCase();
  normalizedColors.set(value, normalized);
  return normalized;
}

/** Native color inputs accept six-digit RGB, while pasted CSS may use rgb()/names. */
export function formattingColorValue(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value) return fallback;
  const normalized = formattingColorKey(value);
  const rgb = normalized.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return /^#[\da-f]{6}$/i.test(normalized) ? normalized : rgb ? '#' + rgb.slice(1, 4).map(channel => Number(channel).toString(16).padStart(2, '0')).join('') : fallback;
}

export function formattingColorIsMixed(editor: Editor | null, mark: 'textStyle' | 'highlight'): boolean {
  if (!editor || editor.state.selection.empty) return false;
  let first: string | undefined, mixed = false;
  editor.state.doc.nodesBetween(editor.state.selection.from, editor.state.selection.to, node => {
    if (mixed) return false;
    if (!node.isInline) return;
    const formatting = node.marks.find(value => value.type.name === mark);
    const color = formatting?.attrs.color;
    const key = color ? formattingColorKey(color) : mark === 'highlight' && formatting ? 'default' : 'none';
    if (first === undefined) first = key;
    else if (key !== first) mixed = true;
  });
  return mixed;
}

export function hasLowContrastFormatting(editor: Editor | null): boolean {
  if (!editor || editor.isDestroyed || !editor.isInitialized || formattingColorIsMixed(editor, 'textStyle') || formattingColorIsMixed(editor, 'highlight')) return false;
  const color = editor.getAttributes('textStyle').color, highlight = editor.getAttributes('highlight').color;
  if (!color && !highlight) return false;
  const root = editor.view.dom;
  let background = highlight, element: HTMLElement | null = root;
  while (!background && element) {
    const value = getComputedStyle(element).backgroundColor;
    if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') background = value;
    element = element.parentElement;
  }
  const luminance = (hex: string) => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const foreground = luminance(formattingColorValue(color || getComputedStyle(root).color, '#202020'));
  const paper = luminance(formattingColorValue(background, '#ffffff'));
  return (Math.max(foreground, paper) + .05) / (Math.min(foreground, paper) + .05) < 4.5;
}

/** Restore the formatting-session range, run exactly one command, and retain the new range. */
export function runFormattingCommand(
  editor: Editor,
  selection: FormattingSelection | null,
  command: FormattingCommand,
): FormattingSelection | null {
  if (!isUsableFormattingEditor(editor)) return null;
  if (editor.isInitialized && (!editor.isEditable || !editor.view.dom.isConnected)) return null;

  let chain = editor.chain();
  const retained = selection && retainedSelections.get(selection);
  if (retained) {
    // Keep NodeSelection, AllSelection and backward text ranges intact. Never
    // restore positions captured against a document that has since changed.
    if (retained.doc !== editor.state.doc) return null;
    chain = chain.command(({ tr, dispatch }) => { if (dispatch) tr.setSelection(retained.selection); return true; });
  } else if (selection) {
    const maxPosition = editor.state.doc.content.size;
    const from = Math.max(0, Math.min(selection.from, maxPosition));
    const to = Math.max(from, Math.min(selection.to, maxPosition));
    chain = chain.setTextSelection({ from, to });
  }

  chain = chain.focus();
  command(chain).run();
  // Keyboard menu choices can remove the focused option immediately. Return
  // DOM focus synchronously so the next shortcut uses this editor's history.
  if (editor.isInitialized) editor.view.focus();
  return captureFormattingSelection(editor);
}
