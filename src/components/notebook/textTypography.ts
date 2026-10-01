import type { TextObject } from './engine/drawingTypes.ts';
import type { NotebookEngine } from './engine/NotebookEngine';
import type { Editor } from '@tiptap/react';

export const DEFAULT_TEXT_FONT = 'Inter, sans-serif';

/** Preserve every other mark (especially size) while changing the document face. */
export function withTextFont(content: any, fontFamily: string): any {
  if (!content || typeof content !== 'object') return content;
  const next = { ...content };
  if (content.type === 'text') {
    const marks = (content.marks ?? []).map((mark: any) => ({ ...mark, attrs: { ...mark.attrs } }));
    const style = marks.find((mark: any) => mark.type === 'textStyle');
    if (style) style.attrs.fontFamily = fontFamily;
    else marks.push({ type: 'textStyle', attrs: { fontFamily } });
    next.marks = marks;
  }
  if (Array.isArray(content.content)) next.content = content.content.map((child: any) => withTextFont(child, fontFamily));
  return next;
}

export function isHandwritingTextObject(object: TextObject): boolean {
  return object.metadata?.generatedFrom === 'handwriting-recognition';
}

function firstTextFont(content: any): string | undefined {
  if (!content || typeof content !== 'object') return undefined;
  const family = content.marks?.find((mark: any) => mark.type === 'textStyle')?.attrs?.fontFamily;
  if (typeof family === 'string') return family;
  for (const child of content.content ?? []) {
    const found = firstTextFont(child);
    if (found) return found;
  }
  return undefined;
}

export function textObjectStyle(object: TextObject): { fontFamily: string; fontSize?: number; lineHeight?: string } {
  if (!isHandwritingTextObject(object)) return { fontFamily: object.fontFamily || DEFAULT_TEXT_FONT };
  const fontSize = object.metadata?.handwritingFontSize;
  const lineHeight = object.metadata?.handwritingLineHeight;
  return {
    fontFamily: object.fontFamily || firstTextFont(object.content) || DEFAULT_TEXT_FONT,
    ...(Number.isFinite(fontSize) && fontSize > 0 ? { fontSize } : {}),
    ...(Number.isFinite(lineHeight) && lineHeight > 0 ? { lineHeight: `${lineHeight}px` } : {}),
  };
}

/** Object selection changes the entire object; a live range changes only that range. */
export function applyNotebookTextFont(engine: NotebookEngine, font: string, editor?: Editor | null): void {
  const family = font || DEFAULT_TEXT_FONT;
  engine.texts.setDefaultFontFamily(family);
  const selected = new Set(engine.selection.getSelectedElements().filter(item => item.type === 'text').map(item => item.id));
  let targets = engine.texts.getTexts().filter(item => selected.has(item.id) && !item.metadata?.isVoiceNote && engine.texts.isEditable(item));
  if (!targets.length && editor?.isFocused && !editor.isDestroyed) {
    targets = engine.texts.getTexts().filter(item => engine.texts.getEditor(item.id) === editor && !item.metadata?.isVoiceNote);
  }
  if (!targets.length) { engine.input.notifyChange(); return; }
  const snapshots = targets.map(object => ({ id: object.id, fontFamily: object.fontFamily, content: structuredClone(object.content) }));
  const after = targets.map(object => ({ id: object.id, fontFamily: family, content: withTextFont(object.content, family) }));
  const apply = (values: typeof snapshots) => {
    for (const value of values) {
      const object = engine.texts.getTexts().find(item => item.id === value.id);
      if (!object) continue;
      object.fontFamily = value.fontFamily;
      object.content = structuredClone(value.content);
      const live = engine.texts.getEditor(value.id);
      if (live && !live.isDestroyed) { live.commands.setContent(object.content, false); live.commands.blur(); }
    }
    engine.input.notifyChange();
  };
  engine.history.push({ description: 'Change text font', execute: () => apply(after), undo: () => apply(snapshots) });
}
