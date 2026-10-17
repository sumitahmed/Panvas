import { Extension, type Editor } from '@tiptap/core';
import type { NotebookEngine } from './engine/NotebookEngine';
import type { HistoryCommand, TextObject, PageProperties } from './engine/drawingTypes';
import { generateId } from '@/lib/utils/id';
import { isDocumentBody, documentInsets } from './documentFlowGeometry';
import { resolveBasePageDimensions } from '@/lib/pageProperties';

export function documentConversionSource(engine: NotebookEngine): TextObject | undefined {
  const eligible = engine.texts.getTexts().filter(text => !text.metadata?.documentRole && !text.metadata?.audioNoteId && !text.metadata?.isVoiceNote && engine.texts.isEditable(text));
  const focused = engine.texts.getFocusedText();
  const selected = engine.selection.getSelectedElements().filter(object => object.type === 'text') as TextObject[];
  const candidate = engine.tools.getState().mode === 'text' && focused ? focused
    : selected.length === 1 ? selected[0] : selected.length > 1 ? undefined : focused ?? (eligible.length === 1 ? eligible[0] : undefined);
  return eligible.find(text => text.id === candidate?.id);
}

/** One existing canvas-history command. Text JSON is copied without parsing or flattening. */
export function createDocumentLayoutTransition(engine: NotebookEngine, mode: 'document' | 'freeform',
  applyProperties: (properties: PageProperties) => void, sourceId?: string): HistoryCommand | null {
  const pageId = engine.getDrawingOwnership().pageId;
  if (!pageId) return null;
  const previousProperties = structuredClone(engine.getProperties());
  const before = structuredClone(engine.texts.getTexts());
  const body = before.find(isDocumentBody), source = sourceId ? before.find(text => text.id === sourceId) : mode === 'document' ? before.find(text => text.metadata?.documentDormantBody) : undefined;
  const dormant = before.find(text => text.metadata?.documentDormantBody);
  if (sourceId && (!source || isDocumentBody(source) || !engine.texts.isEditable(source))) return null;
  // Never replace an existing document to consume another positioned object.
  if (source && body) return null;
  if (sourceId && dormant && dormant.id !== sourceId) return null;
  if (!source && (previousProperties.layoutMode ?? 'freeform') === mode && (mode !== 'document' || body)) return null;
  const after = structuredClone(before);
  if (mode === 'document' && !body) {
    const next: TextObject = source ? {
      ...structuredClone(source), x: 0, y: 0, width: 0, height: 0,
      metadata: { ...source.metadata, documentDormantBody: undefined, documentRole: 'body', documentConversionOriginal: structuredClone(source.metadata?.documentConversionOriginal ?? source) },
    } : {
      id: generateId('document'), type: 'text', x: 0, y: 0, width: 0, height: 0, createdAt: Date.now(),
      content: { type: 'doc', content: [{ type: 'paragraph' }] }, metadata: { documentRole: 'body', richTextSchemaVersion: 3 },
    };
    if (source) after[after.findIndex(text => text.id === source.id)] = next; else after.push(next);
  } else if (mode === 'freeform' && body) {
    const original = body.metadata?.documentConversionOriginal as TextObject | undefined;
    const inset = documentInsets(previousProperties);
    const positioned = original ? structuredClone(original) : { ...body, x: inset, y: inset,
      width: resolveBasePageDimensions(previousProperties).width - inset * 2, height: body.height };
    // Keep the current authored content when changing layout; the source backup remains available.
    positioned.content = structuredClone(body.content);
    positioned.metadata = { ...positioned.metadata, documentDormantBody: true, documentConversionOriginal: original ? structuredClone(original) : undefined };
    delete positioned.metadata.documentRole;
    after[after.findIndex(text => text.id === body.id)] = positioned;
  }
  const nextProperties = { ...previousProperties, layoutMode: mode, layoutExtent: undefined };
  const apply = (texts: TextObject[], properties: PageProperties) => {
    if (engine.getDrawingOwnership().pageId !== pageId) return;
    engine.texts.getFocusedText() && engine.texts.getEditor(engine.texts.getFocusedText()!.id)?.commands.blur();
    engine.selection.clearSelection();
    engine.texts.setActiveTextId(undefined);
    engine.texts.setTexts(structuredClone(texts));
    engine.texts.setDocumentBodyId(properties.layoutMode === 'document' ? texts.find(isDocumentBody)?.id : undefined);
    applyProperties(structuredClone(properties));
  };
  return { description: source ? 'Convert text to document' : 'Change writing layout', documentLayoutPageId: pageId,
    execute: () => apply(after, nextProperties), undo: () => apply(before, previousProperties) };
}

export function canUseDocumentLayoutHistory(engine: NotebookEngine, direction: 'undo' | 'redo', editor?: Editor | null): boolean {
  if (editor && !editor.isDestroyed && editor.can()[direction]()) return false;
  return engine.history.nextCommand(direction)?.documentLayoutPageId === engine.getDrawingOwnership().pageId;
}

export function runDocumentLayoutHistory(engine: NotebookEngine, direction: 'undo' | 'redo', editor?: Editor | null): boolean {
  if (!canUseDocumentLayoutHistory(engine, direction, editor)) return false;
  engine.history[direction]();
  return true;
}

export const documentLayoutHistoryExtension = (engine: NotebookEngine) => Extension.create({
  name: 'documentLayoutHistory', priority: 1100,
  addKeyboardShortcuts() {
    return {
      'Mod-z': () => runDocumentLayoutHistory(engine, 'undo', this.editor),
      'Mod-Shift-z': () => runDocumentLayoutHistory(engine, 'redo', this.editor),
      'Mod-y': () => runDocumentLayoutHistory(engine, 'redo', this.editor),
    };
  },
});
