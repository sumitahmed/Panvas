// ============================================
// Panvas — Notebook Page Renderer
// ============================================

import React, { useEffect, useId, useRef, useState } from 'react';
import { Bookmark } from 'lucide-react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import { FontSize } from './FontSizeExtension';
import Placeholder from '@tiptap/extension-placeholder';
import { Extension } from '@tiptap/core';
import type { PageProperties } from './engine/drawingTypes';
import type { NotebookEngine } from './engine/NotebookEngine';
import { TEMPLATE_REGISTRY } from './templates/TemplateRegistry.tsx';
import { resolvePageTemplateRenderModel, resolveBasePageDimensions, resolvePageNoteSpace } from '@/lib/pageProperties';
import { useFullDarkView } from '@/hooks/useFullDarkView';
import { fullDarkSurfaceColor, fullDarkRuleLineColor } from '@/lib/fullDarkView';
import { useBookmarkStore } from '@/stores/bookmarkStore';

export { formatPageIndicator } from './pageIndicator';

export interface PageRendererProps {
  id: string;
  width: number;
  height: number;
  properties: PageProperties;
  className?: string;
  children?: React.ReactNode;
  pageNumberText?: string;
  editable?: boolean;
  onUpdateProperties?: (updates: Partial<PageProperties>) => void;
  renderWindow?: { top: number; height: number };
  logicalBase?: number;
  isBookmarked?: boolean;
  engine?: NotebookEngine;
  onFocusEditor?: (editor: Editor | null) => void;
}

type TemplateField = { key: string; placeholder: string; x: number; y: number; width: number; fontSize?: number; weight?: number };

function editableTemplateFields(template: PageProperties['template'], width: number): TemplateField[] {
  switch (template) {
    case 'Lecture Notes': return [
      { key: 'course-topic', placeholder: 'COURSE & TOPIC', x: 28, y: 18, width: width * .6 - 48 },
      { key: 'date', placeholder: 'DATE', x: width * .6 + 12, y: 18, width: width * .4 - 30 },
    ];
    case 'Assignment': return [{ key: 'assignment-due', placeholder: 'ASSIGNMENT / DUE DATE', x: 28, y: 16, width: width - 56 }];
    case 'To-do': return [{ key: 'title', placeholder: 'TO-DO LIST', x: 24, y: 15, width: width - 48, fontSize: 14, weight: 700 }];
    case 'Daily planner': return [
      { key: 'title', placeholder: 'DAILY PLANNER', x: 20, y: 14, width: width - 210, fontSize: 13, weight: 700 },
      { key: 'date', placeholder: 'DATE', x: width - 160, y: 16, width: 140 },
    ];
    case 'Weekly planner': return [{ key: 'title', placeholder: 'WEEKLY OVERVIEW', x: 20, y: 12, width: width - 40, fontSize: 13, weight: 700 }];
    case 'Monthly planner': return [{ key: 'month', placeholder: 'MONTH', x: 20, y: 14, width: width - 40, fontSize: 14, weight: 700 }];
    case 'Journal': return [
      { key: 'date', placeholder: 'DATE', x: 40, y: 20, width: 160 },
      { key: 'mood-weather', placeholder: 'MOOD / WEATHER', x: width - 180, y: 20, width: 140 },
    ];
    case 'Calendar': return [{ key: 'title', placeholder: 'MONTHLY CALENDAR', x: 20, y: 16, width: width - 40, fontSize: 13, weight: 700 }];
    default: return [];
  }
}

interface TemplateFieldInputProps {
  field: TemplateField;
  template: PageProperties['template'];
  scale: number;
  value: string;
  color: string;
  editable: boolean;
  onChange: (value: string) => void;
  engine?: NotebookEngine;
  onFocusEditor?: (editor: Editor | null) => void;
}

function StaticTemplateField({ field, template, scale, value, color }: TemplateFieldInputProps) {
  return (
    <div
      key={`${template}-${field.key}`}
      aria-label={`${field.placeholder} template field`}
      className="panvas-colored-content absolute z-30 border-0 border-b border-current bg-transparent px-0 outline-none overflow-hidden select-none"
      style={{
        left: field.x * scale,
        top: field.y * scale,
        width: field.width * scale,
        height: 22 * scale,
        fontSize: (field.fontSize ?? 10) * scale,
        fontWeight: field.weight ?? 600,
        color,
        lineHeight: `${22 * scale}px`,
      }}
      dangerouslySetInnerHTML={{ __html: value || `<span style="opacity: 0.6;">${field.placeholder}</span>` }}
    />
  );
}

function ClientTemplateField({ field, template, scale, value, color, editable, onChange, engine, onFocusEditor }: TemplateFieldInputProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
        link: false,
        underline: false,
      }),
      Underline,
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      Placeholder.configure({
        placeholder: field.placeholder,
        emptyEditorClass: 'is-editor-empty',
        showOnlyWhenEditable: false,
      }),
      Extension.create({
        name: 'templateFieldEnterKey',
        addKeyboardShortcuts() {
          return {
            Enter: () => {
              this.editor.commands.blur();
              return true;
            },
          };
        },
      }),
    ],
    content: value || '',
    editable,
    shouldRerenderOnTransaction: true,
    onUpdate: ({ editor: updatedEditor }) => {
      const text = updatedEditor.getText().trim();
      const html = updatedEditor.getHTML();
      onChange(text === '' ? '' : html);
    },
    onFocus: ({ editor: focusedEditor }) => {
      if (engine && engine.tools.getState().mode !== 'text') {
        engine.tools.setMode('text');
      }
      onFocusEditor?.(focusedEditor);
    },
    onSelectionUpdate: ({ editor: currentEditor }) => {
      onFocusEditor?.(currentEditor);
    },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(editable, false);
  }, [editable, editor]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !engine) return;
    const registrationKey = `template-field-${field.key}`;
    engine.texts.registerEditor(registrationKey, editor);
    return () => {
      engine.texts.unregisterEditor(registrationKey);
    };
  }, [editor, engine, field.key]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (editor.isFocused) return;
    const currentHTML = editor.getHTML();
    const currentText = editor.getText().trim();
    const currentNormalized = currentText === '' ? '' : currentHTML;
    const incomingNormalized = (value || '').trim();
    if (incomingNormalized !== currentNormalized && incomingNormalized !== currentText) {
      editor.commands.setContent(value || '', { emitUpdate: false });
    }
  }, [value, editor]);

  return (
    <div
      key={`${template}-${field.key}`}
      aria-label={`${field.placeholder} template field`}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        if (editable && editor && !editor.isFocused) {
          editor.commands.focus();
        }
      }}
      className="panvas-colored-content panvas-template-field-editor absolute z-30 border-0 border-b border-current bg-transparent px-0 outline-none focus-within:border-panvas-accent-blue"
      style={{
        left: field.x * scale,
        top: field.y * scale,
        width: field.width * scale,
        height: 22 * scale,
        fontSize: (field.fontSize ?? 10) * scale,
        fontWeight: field.weight ?? 600,
        color,
        lineHeight: `${22 * scale}px`,
        overflow: 'hidden',
      }}
    >
      <EditorContent editor={editor} className="h-full w-full" />
    </div>
  );
}

function TemplateFieldInput(props: TemplateFieldInputProps) {
  if (typeof window === 'undefined') {
    return <StaticTemplateField {...props} />;
  }
  return <ClientTemplateField {...props} />;
}

const PageRendererComponent: React.FC<PageRendererProps> = ({ id, width, height, properties, className = '', children, pageNumberText, editable = false, onUpdateProperties, renderWindow, logicalBase = 0, isBookmarked: propIsBookmarked, engine, onFocusEditor }) => {
  const templateResourceScope = useId();
  const fullDarkView = useFullDarkView();
  const { template, margins } = properties;
  const renderModel = resolvePageTemplateRenderModel(properties);
  const geometry = renderModel;
  const scale = width / geometry.width;
  const source = {
    left: geometry.source.left * scale,
    top: geometry.source.top * scale,
    width: geometry.source.width * scale,
    height: geometry.source.height * scale,
  };

  const isContinuationSheet = id.includes('-sheet-') && !id.endsWith('-sheet-1');
  const baseId = id.includes('-sheet-') ? id.split('-sheet-')[0] : id;

  const isStoreBookmarked = useBookmarkStore(state => {
    if (propIsBookmarked !== undefined || isContinuationSheet) return false;
    return state.bookmarks.some(b => b.pageId === id || b.pageId === baseId || b.id.endsWith(`:${id}`) || b.id.endsWith(`:${baseId}`));
  });

  const isBookmarked = propIsBookmarked ?? isStoreBookmarked;

  // Margin insets based on selection
  const getMarginInset = () => {
    if (margins === 'No Margin') return 0;
    let baseInset = 64; // Normal (~8%)
    if (margins === 'Narrow') baseInset = 32; // Narrow (~4%)
    if (margins === 'Wide') baseInset = 104; // Wide (~13%)
    return Math.round(baseInset * scale);
  };

  const marginInset = getMarginInset();

  // Paper and template ink are persisted document values. Application theme
  // only styles Panvas chrome and must never rewrite either value.
  const effectiveBgColor = fullDarkView ? fullDarkSurfaceColor(renderModel.paperColor) : renderModel.paperColor;
  const effectiveLineColor = fullDarkView ? fullDarkRuleLineColor(renderModel.lineColor) : renderModel.lineColor;

  // Retrieve template definition from registry
  const templateDef = TEMPLATE_REGISTRY[template] || TEMPLATE_REGISTRY.Blank;
  const baseHeight = resolveBasePageDimensions(properties).height;
  const notes = resolvePageNoteSpace(properties);
  const sheetHeight = baseHeight + notes.top + notes.bottom;
  const paged = properties.layoutMode === 'document' && properties.pageSize !== 'Infinite' && height > sheetHeight + 1;
  let paperFrames: React.ReactNode = null;
  let sheetCount = 1;
  if (paged) {
    const stride = sheetHeight + 32;
    const count = Math.max(1, Math.round(((properties.layoutExtent ?? (height - notes.top - notes.bottom)) + notes.top + notes.bottom + 32) / stride));
    const first = Math.max(0, Math.floor(((renderWindow?.top ?? 0) + logicalBase) / stride) - 1);
    const last = Math.min(count - 1, Math.ceil(((renderWindow?.top ?? 0) + logicalBase + (renderWindow?.height ?? height)) / stride));
    sheetCount = count;
    paperFrames = <>{Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) => {
        const index = first + offset;
        const subPageText = pageNumberText
          ? (count > 1 ? `${pageNumberText} (Sheet ${index + 1}/${count})` : pageNumberText)
          : (count > 1 ? `Sheet ${index + 1}/${count}` : undefined);
        return <div key={index} data-document-sheet={index + 1} className="absolute" style={{ top: index * stride - logicalBase, width, height: sheetHeight }}>
          <PageRenderer id={`${id}-sheet-${index + 1}`} width={width} height={sheetHeight} properties={{ ...properties, layoutMode: 'freeform', layoutExtent: undefined }} pageNumberText={subPageText} />
        </div>;
      })}</>;
  }

  return (
    <div
      id={`page-${id}`}
      data-page-id={id}
      data-document-sheet-count={properties.layoutMode === 'document' ? sheetCount : undefined}
      className={`relative shadow-2xl transition-colors duration-200 overflow-hidden ${className}`}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        backgroundColor: paged ? 'transparent' : effectiveBgColor,
      }}
    >
      <div key="paper-background" className="absolute inset-0">
      {paged ? paperFrames : <>
      {/* Background Template SVG Layer */}
      <svg 
        className="panvas-colored-content absolute inset-0 pointer-events-none select-none"
        width="100%"
        height={renderWindow?.height ?? height}
        viewBox={`0 0 ${geometry.width} ${renderWindow?.height ?? geometry.height}`}
        style={{ width: '100%', height: renderWindow?.height ?? '100%', top: renderWindow?.top ?? 0 }}
      >
        {templateDef.renderSVG(geometry.width, renderWindow?.height ?? geometry.height, effectiveLineColor, false, templateResourceScope)}
      </svg>

      {editableTemplateFields(template, geometry.source.width).map(field => (
        <TemplateFieldInput
          key={`${template}-${field.key}`}
          value={properties.templateFields?.[field.key] ?? ''}
          field={{ ...field, x: field.x + geometry.source.left, y: field.y + geometry.source.top }}
          template={template}
          scale={scale}
          color={effectiveLineColor}
          editable={editable && Boolean(onUpdateProperties)}
          onChange={value => onUpdateProperties?.({ templateFields: { ...(properties.templateFields ?? {}), [field.key]: value } })}
          engine={engine}
          onFocusEditor={onFocusEditor}
        />
      ))}

      {/* Visual Margin Guidelines */}
      {marginInset > 0 && (
        <div 
          className="absolute pointer-events-none transition-all duration-200 border border-dashed"
          style={{
            left: `${source.left + marginInset}px`,
            top: `${source.top + marginInset}px`,
            width: `${Math.max(10, source.width - marginInset * 2)}px`,
            height: `${Math.max(10, source.height - marginInset * 2)}px`,
            borderColor: 'rgba(0, 0, 0, 0.1)',
          }}
          aria-hidden="true"
        />
      )}

      {(geometry.noteSpace.top || geometry.noteSpace.right || geometry.noteSpace.bottom || geometry.noteSpace.left) > 0 && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute border border-panvas-border-default/45"
          style={{ left: source.left, top: source.top, width: source.width, height: source.height }}
        />
      )}
      </>}
      </div>

      {/* Structured Content & Drawing Layer */}
      <div key="page-content" className="absolute inset-0">{children}</div>

      {/* Bookmarked Page Corner Ribbon / Marker */}
      {isBookmarked && (
        <div
          data-testid="page-bookmark-marker"
          aria-label="Bookmarked page marker"
          className="absolute top-0 right-0 pointer-events-none select-none z-20"
        >
          <div className="relative w-9 h-9 overflow-hidden pointer-events-none select-none">
            <div className="absolute top-0 right-0 w-0 h-0 border-t-[36px] border-l-[36px] border-t-panvas-accent-blue border-l-transparent drop-shadow-xs pointer-events-none select-none" />
            <Bookmark
              size={11}
              className="absolute top-1 right-1 text-white fill-white pointer-events-none select-none"
            />
          </div>
        </div>
      )}

      {/* Page Number Indicator */}
      {pageNumberText && !paged && properties.pageSize !== 'Infinite' && (
        <div 
          className="absolute pointer-events-none select-none whitespace-nowrap text-right text-[11px] font-mono font-medium tabular-nums text-panvas-text-tertiary"
          style={{
            opacity: 0.75,
            left: Math.max(8, source.left + source.width - 132),
            top: source.top + source.height - 28,
            width: 124,
            minWidth: 124,
          }}
        >
          {pageNumberText}
        </div>
      )}
    </div>
  );
};

export const PageRenderer = React.memo(PageRendererComponent, (prev, next) => {
  if (prev.id !== next.id) return false;
  if (prev.width !== next.width || prev.height !== next.height) return false;
  if (prev.className !== next.className) return false;
  if (prev.pageNumberText !== next.pageNumberText) return false;
  if (prev.editable !== next.editable) return false;
  if (prev.logicalBase !== next.logicalBase) return false;
  if (prev.children !== next.children) return false;
  if (prev.onUpdateProperties !== next.onUpdateProperties) return false;
  if (prev.renderWindow?.top !== next.renderWindow?.top || prev.renderWindow?.height !== next.renderWindow?.height) return false;
  if (prev.isBookmarked !== next.isBookmarked) return false;
  if (prev.engine !== next.engine) return false;
  if (prev.onFocusEditor !== next.onFocusEditor) return false;
  if (prev.properties !== next.properties) {
    if (JSON.stringify(prev.properties) !== JSON.stringify(next.properties)) return false;
  }
  return true;
});
