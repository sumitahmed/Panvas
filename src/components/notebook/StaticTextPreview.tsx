import React, { useMemo, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useFullDarkView } from '@/hooks/useFullDarkView';
import { colorLuminance, fullDarkSurfaceColor } from '@/lib/fullDarkView';
import { useDocumentTextPresentation } from './useDocumentTextPresentation';
import type { TextObject } from './engine/drawingTypes';
import type { NotebookEngine } from './engine/NotebookEngine';
import { renderNotebookStaticHtml } from './notebookStaticHtml';
import { hydrateAssetImages } from './notebookAssetImage';
import { isHandwritingTextObject, textObjectStyle } from './textTypography';
import { preloadObjectFontStylesheets } from './textFonts';
import { stickyPaperStyle, getStickyNoteColor, getStickyNoteOpacity, getStickyNoteShape, getShapeBorderRadius, hexToRgba, isStickyNote } from './stickyNotes';
import { gate0Profiler } from '@/dev/gate0Profiler';

function sanitizeTipTapDoc(content: unknown): Record<string, any> | null {
  if (!content || typeof content !== 'object') return null;
  const raw = content as Record<string, any>;

  function sanitizeNode(node: any): any {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'text') {
      if (typeof node.text !== 'string' || node.text.length === 0) {
        return null;
      }
      return node;
    }
    if (Array.isArray(node.content)) {
      const sanitizedChildren = node.content.map(sanitizeNode).filter(Boolean);
      return {
        ...node,
        content: sanitizedChildren,
      };
    }
    return node;
  }

  const sanitized = sanitizeNode(raw);
  if (!sanitized) return null;
  if (sanitized.type !== 'doc') {
    return {
      type: 'doc',
      content: Array.isArray(sanitized) ? sanitized : [sanitized],
    };
  }
  return sanitized;
}

export const StaticTextPreview: React.FC<{
  object: TextObject;
  scale: number;
  zIndex?: number;
  offset?: { x: number; y: number };
  paperColor?: string;
  engine?: NotebookEngine;
  interactiveMode?: 'select' | 'text' | 'none';
  onActivateEdit?: (object: TextObject) => void;
  onEditMathObject?: (object: TextObject) => void;
}> = React.memo(({
  object,
  scale,
  zIndex,
  offset,
  paperColor,
  engine,
  interactiveMode = 'none',
  onActivateEdit,
  onEditMathObject,
}) => {
  gate0Profiler.resource('reactRenders.StaticTextPreview', 1);
  const fullDarkView = useFullDarkView();
  const isSticky = isStickyNote(object);
  const isMathObject = object.metadata?.generatedFrom === 'handwriting-math'
    || (Array.isArray(object.content?.content) && object.content.content.length === 1 && object.content.content[0]?.type === 'blockMath');
  const paperIsDark = !isSticky && colorLuminance(fullDarkView ? fullDarkSurfaceColor(paperColor || '#ffffff') : (paperColor || '#ffffff')) < 0.35;
  const textRef = useRef<HTMLDivElement>(null);
  useDocumentTextPresentation(textRef, fullDarkView || paperIsDark, object.content);
  const html = useMemo(() => {
    try {
      const doc = sanitizeTipTapDoc(object.content);
      if (!doc) return '';
      return renderNotebookStaticHtml(doc);
    } catch (err) {
      console.warn('[StaticTextPreview] Failed to generate HTML from text content:', err);
      return '';
    }
  }, [object.content]);
  useEffect(() => {
    preloadObjectFontStylesheets(object.fontFamily, object.content);
  }, [object.fontFamily, object.content]);
  useEffect(() => textRef.current ? hydrateAssetImages(textRef.current) : undefined, [html]);

  const snuggedKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || !engine || !isMathObject || object.metadata?.userResized) return;
    const key = `${object.id}:${String(object.metadata?.latex ?? html)}`;
    if (snuggedKeyRef.current === key) return;
    const katexEl = el.querySelector('.tiptap-mathematics-render .katex') as HTMLElement | null;
    if (!katexEl) return;
    const formulaWidth = Math.max(katexEl.scrollWidth, katexEl.getBoundingClientRect().width / Math.max(0.05, scale));
    if (formulaWidth <= 10) return;
    snuggedKeyRef.current = key;
    const snugWidth = Math.max(88, Math.ceil(formulaWidth + 28));
    const measuredHeight = Math.max(44, Math.ceil(el.scrollHeight));
    const currentWidth = object.width ?? snugWidth;
    if (Math.abs(snugWidth - currentWidth) >= 10 || Math.abs((object.height ?? 0) - measuredHeight) >= 2) {
      const nextWidth = Math.abs(snugWidth - currentWidth) >= 10 ? snugWidth : currentWidth;
      const nextX = nextWidth !== currentWidth
        ? Math.max(0, Math.round(object.x + (currentWidth - nextWidth) / 2))
        : object.x;
      object.x = nextX;
      object.width = nextWidth;
      object.height = measuredHeight;
      engine.texts.updateTextPositionAndBounds(object.id, nextX, object.y, nextWidth, measuredHeight);
    }
  }, [engine, isMathObject, object, object.id, object.metadata?.latex, object.metadata?.userResized, object.x, object.y, object.width, object.height, html, scale]);

  const handwritingText = isHandwritingTextObject(object) && !isSticky;
  const stickyColor = getStickyNoteColor(object);
  const stickyOpacity = getStickyNoteOpacity(object);
  const stickyShape = getStickyNoteShape(object);
  const bgRgba = isSticky ? hexToRgba(fullDarkView ? fullDarkSurfaceColor(stickyColor, true) : stickyColor, stickyOpacity) : undefined;
  const legacyBg = /^#[0-9a-f]{6}$/i.test(String(object.metadata?.elementBackground ?? ''))
    ? String(object.metadata?.elementBackground)
    : undefined;
  const interactive = !isSticky && (interactiveMode === 'select' || interactiveMode === 'text');
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!interactive || !engine || e.button !== 0 || !engine.texts.isEditable(object)) return;
    if (interactiveMode === 'text') {
      e.stopPropagation();
      engine.selection.select(object.id, 'text', false);
      onActivateEdit?.(object);
      return;
    }
    if (isMathObject && onEditMathObject && !e.shiftKey && e.detail >= 2) {
      e.preventDefault();
      e.stopPropagation();
      onEditMathObject(object);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    engine.input.routeOverlayPointerDown(e.nativeEvent);
  }, [interactive, engine, object, interactiveMode, isMathObject, onActivateEdit, onEditMathObject]);
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!interactive || !engine || !engine.texts.isEditable(object) || e.shiftKey) return;
    e.stopPropagation();
    if (isMathObject && onEditMathObject) {
      onEditMathObject(object);
      return;
    }
    engine.tools.setMode('text');
    engine.selection.select(object.id, 'text', false);
    onActivateEdit?.(object);
  }, [interactive, engine, object, isMathObject, onEditMathObject, onActivateEdit]);

  return (
    <div
      data-text-object-id={object.id}
      className={`absolute ${interactive ? 'pointer-events-auto hover:ring-1 hover:ring-panvas-accent-blue/35 hover:rounded-sm' : 'pointer-events-none'} z-0 ${!isSticky && object.metadata?.pastePresentation === 'sticky-note' ? 'panvas-pasted-note' : object.metadata?.pastePresentation === 'mixed-paste' ? 'panvas-mixed-paste' : ''}`}
      style={{
        zIndex,
        ...textObjectStyle(object),
        left: `${(object.x + (offset?.x ?? 0)) * scale}px`,
        top: `${(object.y + (offset?.y ?? 0)) * scale}px`,
        width: `${object.width}px`,
        minHeight: object.height ? `${object.height}px` : undefined,
        height: isSticky && object.height ? `${object.height}px` : undefined,
        transform: `scale(${scale}) rotate(${object.rotation ?? 0}deg)`,
        transformOrigin: 'center',
        ...(!isSticky && /^#[0-9a-f]{6}$/i.test(String(object.metadata?.elementBackground ?? ''))
          ? { backgroundColor: String(object.metadata?.elementBackground) }
          : {}),
        ...(legacyBg && !isSticky ? { backgroundColor: legacyBg } : {}),
      }}
      onPointerDown={interactive ? handlePointerDown : undefined}
      onDoubleClick={interactive ? handleDoubleClick : undefined}
    >
      {isSticky && (
        <div className="absolute inset-0 -z-10 overflow-visible pointer-events-none">
          {stickyShape === 'star' ? (
            <svg className="w-full h-full drop-shadow-md" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polygon points="50,0 63,38 100,38 69,59 82,100 50,75 18,100 31,59 0,38 37,38" fill={bgRgba} />
            </svg>
          ) : (
            <div
              className="w-full h-full shadow-md"
              style={{
                backgroundColor: bgRgba,
                ...stickyPaperStyle(object),
                borderRadius: getShapeBorderRadius(stickyShape),
              }}
            />
          )}
        </div>
      )}
      <div
        ref={textRef}
        data-panvas-dark-paper={paperIsDark ? 'true' : undefined}
        dangerouslySetInnerHTML={{ __html: html }}
        className={`panvas-document-text tiptap ProseMirror outline-none ${handwritingText ? 'panvas-h2t-text' : `prose prose-neutral max-w-none prose-sm ${isSticky ? 'p-0' : 'p-1'}`}`}
        style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', ...(isSticky ? { height: '100%', overflow: 'hidden', padding: stickyShape === 'star' ? '34% 24% 20%' : ['circle', 'oval'].includes(stickyShape) ? '20% 18%' : '14px 16px' } : {}) }}
      />
    </div>
  );
});
StaticTextPreview.displayName = 'StaticTextPreview';

