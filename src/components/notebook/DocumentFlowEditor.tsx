import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import Placeholder from '@tiptap/extension-placeholder';
import type { TextObject } from './engine/drawingTypes';
import type { NotebookEngine } from './engine/NotebookEngine';
import type { PagePropertySet } from '@/types/notebook';
import { notebookTipTapExtensions, getNotebookSchema } from './tiptapExtensions';
import { unsupportedNotebookContent, unsupportedContentFallback, NOTEBOOK_RICH_TEXT_SCHEMA_VERSION } from './notebookContentCompatibility';
import { SlashMenuExtension } from './SlashMenuExtension';
import slashSuggestion from './slashSuggestion';
import { createDocumentPagination } from './documentPagination';
import { documentInsets, documentExtent, positionedContentBottom, documentSheetStride } from './documentFlowGeometry';
import { resolveBasePageDimensions, resolvePageNoteSpace } from '@/lib/pageProperties';
import { useFullDarkView } from '@/hooks/useFullDarkView';
import { useDocumentTextPresentation } from './useDocumentTextPresentation';
import { notebookDocumentViewContent } from './notebookDocumentView';
import { useUIStore } from '@/stores/uiStore';
import { documentLayoutHistoryExtension } from './documentLayoutTransition';
import { textObjectStyle } from './textTypography';

export function DocumentFlowEditor({ object, engine, properties, toolMode, editable, onFocus, ownerPageId, renderBase = 0 }: {
  object: TextObject; engine: NotebookEngine; properties: PagePropertySet;
  toolMode: string; editable: boolean; onFocus: (editor: Editor) => void; ownerPageId: string; renderBase?: number;
}) {
  const [issues, setIssues] = useState<string[]>([]);
  const requestedFocusPageId = useUIStore(state => state.pendingDocumentFocusPageId);
  const inset = documentInsets(properties);
  const notes = resolvePageNoteSpace(properties);
  const width = resolveBasePageDimensions(properties).width - inset * 2;
  const writingHeight = resolveBasePageDimensions(properties).height - inset * 2;
  const pageMask = properties.pageSize !== 'Infinite' && issues.length === 0
    ? `repeating-linear-gradient(to bottom,#000 0px,#000 ${writingHeight}px,transparent ${writingHeight}px,transparent ${documentSheetStride(properties)}px)` : undefined;
  const authoredContent = useRef<unknown>(null);
  const prepared = useMemo(() => authoredContent.current === object.content
    ? { unsupported: [], content: object.content }
    : { unsupported: unsupportedNotebookContent(object.content, getNotebookSchema()), content: notebookDocumentViewContent(object.content) }, [object.content]);
  const unsupported = prepared.unsupported;
  const protectedContent = unsupported.length > 0 || Number(object.metadata?.richTextSchemaVersion ?? 1) > NOTEBOOK_RICH_TEXT_SCHEMA_VERSION;
  const protection = useRef(protectedContent); protection.current = protectedContent;
  const writingAllowed = useRef(editable); writingAllowed.current = editable;
  const containerRef = useRef<HTMLDivElement>(null);
  const fullDarkView = useFullDarkView();
  useDocumentTextPresentation(containerRef, fullDarkView, object.content);
  const config = useRef({ properties, onLayout: (_height: number, _ms: number, _issues: string[]) => {} });
  config.current = { properties, onLayout: (height, milliseconds, nextIssues) => {
    if (protectedContent || engine.getDrawingOwnership().pageId !== ownerPageId) return;
    object.height = height;
    const extent = documentExtent(properties, inset + height, positionedContentBottom([
      ...engine.drawing.getStrokes(), ...engine.shapes.getShapes(), ...engine.texts.getTexts(), ...engine.images.getImages(),
    ]));
    setIssues(previous => previous.join() === nextIssues.join() ? previous : nextIssues);
    const element = engine.texts.getEditor(object.id)?.view.dom;
    if (element) { element.dataset.layoutMs = milliseconds.toFixed(2); element.dataset.layoutIssues = String(nextIssues.length); }
    const nextExtent = properties.pageSize === 'Infinite' ? Math.max(extent, engine.getProperties().layoutExtent ?? 0) : extent;
    if (nextExtent !== engine.getProperties().layoutExtent) engine.setProperties({ layoutExtent: nextExtent });
  } };
  const editor = useEditor({
    extensions: [
      ...notebookTipTapExtensions,
      documentLayoutHistoryExtension(engine),
      createDocumentPagination(() => config.current),
      Extension.create({ name: 'documentContentProtection', addProseMirrorPlugins: () => [new Plugin({ filterTransaction: tr => !tr.docChanged || !protection.current && writingAllowed.current && engine.getDrawingOwnership().pageId === ownerPageId })] }),
      Placeholder.configure({ placeholder: 'Write a document, paste formatted text, or type / for blocks…' }),
      SlashMenuExtension.configure({ suggestion: slashSuggestion }),
    ],
    content: protectedContent ? unsupportedContentFallback(object.content, unsupported) : prepared.content,
    editable: editable && !protectedContent,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'tiptap prose prose-neutral prose-sm max-w-none panvas-document-content', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Document body', 'data-protected-content': protectedContent ? 'true' : 'false' } },
    onUpdate: ({ editor: current }) => {
      if (protection.current || !editable || engine.getDrawingOwnership().pageId !== ownerPageId) return;
      object.content = current.getJSON();
      authoredContent.current = object.content;
      object.metadata = { ...object.metadata, richTextSchemaVersion: NOTEBOOK_RICH_TEXT_SCHEMA_VERSION };
      engine.texts.updateTextContent(object.id, object.content);
      engine.input.notifyChange('document-text');
    },
    onFocus: ({ editor: current }) => { engine.texts.setActiveTextId(object.id); onFocus(current); },
    onSelectionUpdate: ({ editor: current }) => {
      engine.texts.setActiveTextId(object.id); onFocus(current);
      if (renderBase > 0 || (properties.layoutExtent ?? 0) > 1_000_000) {
        const rect = current.view.dom.getBoundingClientRect(), scale = rect.width / current.view.dom.offsetWidth || 1;
        const y = (current.view.coordsAtPos(current.state.selection.head).top - rect.top) / scale + inset;
        if (y < renderBase || y > renderBase + 1_000_000) document.dispatchEvent(new CustomEvent('panvas:go-to-logical-y', { detail: { y } }));
      }
    },
  });
  useEffect(() => {
    if (!editor) return;
    engine.texts.registerEditor(object.id, editor);
    const focus = (event: Event) => {
      if ((event as CustomEvent).detail?.id === object.id) editor.commands.focus('end');
    };
    document.addEventListener('panvas:focus-text', focus);
    return () => { engine.texts.unregisterEditor(object.id); document.removeEventListener('panvas:focus-text', focus); };
  }, [editor, object.id, engine]);
  useEffect(() => { editor?.setEditable(editable && !protectedContent && toolMode === 'text', false); }, [editor, editable, protectedContent, toolMode]);
  useEffect(() => {
    if (requestedFocusPageId !== ownerPageId || !editor || !editable || protectedContent || engine.getDrawingOwnership().pageId !== ownerPageId) return;
    if (toolMode !== 'text') { engine.tools.setMode('text'); return; }
    editor.commands.focus('start');
    useUIStore.getState().setDocumentFocusPageId(null);
  }, [requestedFocusPageId, ownerPageId, editor, editable, protectedContent, toolMode, engine]);
  useEffect(() => {
    if (!editor) return;
    editor.view.dom.dispatchEvent(new Event('panvas-layout'));
  }, [editor, properties.pageSize, properties.orientation, properties.margins, properties.extraTop, properties.extraBottom, properties.extraHeight, properties.extraLeft, properties.extraRight]);
  useLayoutEffect(() => {
    if (!editor) return;
    const typography = textObjectStyle(object);
    editor.view.dom.style.fontFamily = typography.fontFamily;
    editor.view.dom.style.fontSize = typography.fontSize ? `${typography.fontSize}px` : '';
    editor.view.dom.style.lineHeight = typography.lineHeight ?? '';
    editor.view.dom.dispatchEvent(new Event('panvas-layout'));
  }, [editor, object.fontFamily, object.metadata?.handwritingFontSize, object.metadata?.handwritingLineHeight]);
  return <div ref={containerRef} data-document-body={object.id} data-infinite-document={properties.pageSize === 'Infinite' ? 'true' : 'false'} className="panvas-document-body panvas-document-text absolute" onPointerDown={event => { if (event.pointerType !== 'touch') event.stopPropagation(); }} style={{ left: notes.left + inset, top: notes.top + inset - renderBase, width, zIndex: 12, pointerEvents: editable && toolMode === 'text' ? 'auto' : 'none' }}>
    {protectedContent && <div role="status">This document requires a compatible Panvas version. Its original content is protected.</div>}
    {issues.length > 0 && <div role="status" className="panvas-document-layout-issue">{[...new Set(issues)].join(' ')}</div>}
    <EditorContent editor={editor} style={{ maskImage: pageMask, WebkitMaskImage: pageMask }} />
  </div>;
}
