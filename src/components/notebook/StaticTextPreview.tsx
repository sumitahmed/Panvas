import React, { useMemo } from 'react';
import { generateHTML } from '@tiptap/core';
import type { TextObject } from './engine/drawingTypes';
import { notebookTipTapExtensions } from './tiptapExtensions';
import { textObjectStyle } from './textTypography';
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

export const StaticTextPreview: React.FC<{ object: TextObject; scale: number; zIndex?: number; offset?: { x: number; y: number } }> = ({ object, scale, zIndex, offset }) => {
  gate0Profiler.resource('reactRenders.StaticTextPreview', 1);
  const html = useMemo(() => {
    try {
      const doc = sanitizeTipTapDoc(object.content);
      if (!doc) return '';
      return generateHTML(doc, notebookTipTapExtensions);
    } catch (err) {
      console.warn('[StaticTextPreview] Failed to generate HTML from text content:', err);
      return '';
    }
  }, [object.content]);

  const isSticky = isStickyNote(object);
  const stickyColor = getStickyNoteColor(object);
  const stickyOpacity = getStickyNoteOpacity(object);
  const stickyShape = getStickyNoteShape(object);
  const bgRgba = isSticky ? hexToRgba(stickyColor, stickyOpacity) : undefined;
  const legacyBg = /^#[0-9a-f]{6}$/i.test(String(object.metadata?.elementBackground ?? ''))
    ? String(object.metadata?.elementBackground)
    : undefined;

  return (
    <div
      className={`absolute pointer-events-none z-0 ${!isSticky && object.metadata?.pastePresentation === 'sticky-note' ? 'panvas-pasted-note' : object.metadata?.pastePresentation === 'mixed-paste' ? 'panvas-mixed-paste' : ''}`}
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
        dangerouslySetInnerHTML={{ __html: html }} 
        className={`tiptap ProseMirror outline-none prose prose-neutral max-w-none prose-sm ${isSticky ? 'p-0' : 'p-1'}`} 
        style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', ...(isSticky ? { height: '100%', overflow: 'hidden', padding: stickyShape === 'star' ? '34% 24% 20%' : ['circle', 'oval'].includes(stickyShape) ? '20% 18%' : '14px 16px' } : {}) }}
      />
    </div>
  );
};

