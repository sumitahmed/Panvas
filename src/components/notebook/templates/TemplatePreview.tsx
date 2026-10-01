import React, { useId } from 'react';
import type { PageProperties, PageTemplate } from '../engine/drawingTypes';
import { resolveBasePageDimensions, resolveNotebookLineColor } from '@/lib/pageProperties';
import { TEMPLATE_REGISTRY } from './TemplateRegistry.tsx';

/**
 * Preview-only visibility boost. Template definitions remain the source of
 * truth for real pages; their deliberately subtle strokes are simply too
 * light at thumbnail size. Cloning the SVG tree keeps the browser preview
 * legible without changing the actual page rendering or export output.
 */
function numericSvgValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function boostPreviewNode(node: React.ReactNode): React.ReactNode {
  return React.Children.map(node, child => {
    if (!React.isValidElement(child)) return child;
    const props = child.props as {
      children?: React.ReactNode;
      strokeWidth?: unknown;
      strokeOpacity?: unknown;
      opacity?: unknown;
      fillOpacity?: unknown;
      r?: unknown;
      vectorEffect?: unknown;
    };
    const nextProps: Record<string, unknown> = {};
    const strokeWidth = numericSvgValue(props.strokeWidth);
    const strokeOpacity = numericSvgValue(props.strokeOpacity);
    const opacity = numericSvgValue(props.opacity);
    const fillOpacity = numericSvgValue(props.fillOpacity);
    const radius = numericSvgValue(props.r);
    if (strokeWidth !== undefined) {
      nextProps.strokeWidth = Math.max(1.05, strokeWidth);
      nextProps.vectorEffect = 'non-scaling-stroke';
    }
    if (strokeOpacity !== undefined) nextProps.strokeOpacity = Math.max(0.72, strokeOpacity);
    if (opacity !== undefined) nextProps.opacity = Math.max(0.72, opacity);
    if (fillOpacity !== undefined) nextProps.fillOpacity = Math.max(0.22, fillOpacity);
    if (radius !== undefined) nextProps.r = Math.max(5, radius);
    if (props.children) nextProps.children = boostPreviewNode(props.children);
    return React.cloneElement(child, nextProps);
  });
}

export function TemplatePreview({ template, properties, backgroundColor }: { template: PageTemplate; properties: PageProperties; backgroundColor?: string }) {
  const templateResourceScope = useId();
  const size = resolveBasePageDimensions(properties);
  const persistedLineColor = resolveNotebookLineColor(properties.ruleLineColor);
  const definition = TEMPLATE_REGISTRY[template] || TEMPLATE_REGISTRY.Blank;
  const previewBackground = backgroundColor || (properties.paperColor && properties.paperColor !== 'default' ? properties.paperColor : undefined);
  return <svg aria-hidden="true" data-template-preview={template} className="block h-full w-full" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="xMidYMid meet" style={{ backgroundColor: previewBackground, shapeRendering: 'geometricPrecision' }}>
    <g className="panvas-colored-content">{boostPreviewNode(definition.renderSVG(size.width, size.height, persistedLineColor, false, templateResourceScope))}</g>
  </svg>;
}
