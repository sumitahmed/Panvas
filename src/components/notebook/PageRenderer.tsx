// ============================================
// Panvas — Notebook Page Renderer
// ============================================

import React, { useEffect, useId, useRef, useState } from 'react';
import type { PageProperties } from './engine/drawingTypes';
import { TEMPLATE_REGISTRY } from './templates/TemplateRegistry.tsx';
import { resolvePageTemplateRenderModel } from '@/lib/pageProperties';

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

function TemplateFieldInput({ field, template, scale, value, color, editable, onChange }: {
  field: TemplateField;
  template: PageProperties['template'];
  scale: number;
  value: string;
  color: string;
  editable: boolean;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(value);
  }, [value]);
  return (
    <input
      ref={inputRef}
      key={`${template}-${field.key}`}
      type="text"
      value={draft}
      placeholder={field.placeholder}
      aria-label={`${field.placeholder} template field`}
      readOnly={!editable}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onChange={event => { setDraft(event.target.value); onChange(event.target.value); }}
      className="panvas-colored-content absolute z-30 border-0 border-b border-current bg-transparent px-0 outline-none placeholder:opacity-60 focus:border-panvas-accent-blue"
      style={{ left: field.x * scale, top: field.y * scale, width: field.width * scale, height: 22 * scale, fontSize: (field.fontSize ?? 10) * scale, fontWeight: field.weight ?? 600, color }}
    />
  );
}

export const PageRenderer: React.FC<PageRendererProps> = ({ id, width, height, properties, className = '', children, pageNumberText, editable = false, onUpdateProperties }) => {
  const templateResourceScope = useId();
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
  const effectiveBgColor = renderModel.paperColor;
  const effectiveLineColor = renderModel.lineColor;

  // Retrieve template definition from registry
  const templateDef = TEMPLATE_REGISTRY[template] || TEMPLATE_REGISTRY.Blank;

  return (
    <div
      id={`page-${id}`}
      data-page-id={id}
      className={`relative shadow-2xl transition-colors duration-200 overflow-hidden ${className}`}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        backgroundColor: effectiveBgColor,
      }}
    >
      {/* Background Template SVG Layer */}
      <svg 
        className="panvas-colored-content absolute inset-0 pointer-events-none select-none"
        width="100%"
        height="100%"
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        style={{ width: '100%', height: '100%' }}
      >
        {templateDef.renderSVG(geometry.width, geometry.height, effectiveLineColor, false, templateResourceScope)}
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

      {/* Structured Content & Drawing Layer */}
      {children}

      {/* Page Number Indicator */}
      {pageNumberText && (
        <div 
          className="absolute pointer-events-none select-none whitespace-nowrap text-right text-[11px] font-mono font-medium tabular-nums text-panvas-text-tertiary"
          style={{
            opacity: 0.75,
            left: Math.max(8, source.left + source.width - 92),
            top: source.top + source.height - 28,
            width: 84,
            minWidth: 84,
          }}
        >
          {pageNumberText}
        </div>
      )}
    </div>
  );
};
