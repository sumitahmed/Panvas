// ============================================
// Panvas — Notebook Page Template Registry
// ============================================
// Authoritative Single Source of Truth for all template
// background definitions, layout geometry, and previews.

import React from 'react';
import type { PageTemplate } from '../engine/drawingTypes';
import { marginRuling, MARGIN_RULE_ACCENT, type MarginRulingStyle } from './marginRuling';

function renderMarginRuling(width: number, height: number, color: string, style: MarginRulingStyle) {
  const ruling = marginRuling(width, height, style);
  return <g opacity={0.85}>
    {ruling.horizontal.map(y => <line key={y} x1={0} y1={y} x2={width} y2={y} stroke={color} strokeWidth={1} />)}
    {ruling.margins.map((x, index) => <line key={x} x1={x} y1={ruling.top} x2={x} y2={ruling.bottom}
      stroke={style === 'Double margin ruled' && index === 0 ? MARGIN_RULE_ACCENT : color} strokeWidth={1} />)}
  </g>;
}

export type TemplateCategory = 'Basic' | 'Grid' | 'Study' | 'Planning' | 'Special';

export interface TemplateDefinition {
  id: PageTemplate;
  name: string;
  category: TemplateCategory;
  description: string;
  supportsLineColor: boolean;
  renderSVG: (width: number, height: number, lineColor: string, isDark: boolean, resourceScope: string) => React.ReactNode;
}

function paintResourceId(resourceScope: string, name: string): string {
  const safeScope = resourceScope.replace(/[^a-zA-Z0-9_-]/g, '') || 'template';
  return `panvas-${safeScope}-${name}`;
}

export const TEMPLATE_REGISTRY: Record<PageTemplate, TemplateDefinition> = {
  // ========================================================
  // 1. BASIC TEMPLATES
  // ========================================================
  Blank: {
    id: 'Blank',
    name: 'Blank',
    category: 'Basic',
    description: 'Clean unlined paper for freeform drawing and sketching',
    supportsLineColor: false,
    renderSVG: () => null,
  },

  Ruled: {
    id: 'Ruled',
    name: 'Ruled',
    category: 'Basic',
    description: 'Standard lined paper (~28px spacing) with top margin space',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const topMargin = 60;
      const spacing = 28;
      const lines: React.ReactNode[] = [];
      for (let y = topMargin; y < height - 20; y += spacing) {
        lines.push(<line key={y} x1={0} y1={y} x2={width} y2={y} stroke={color} strokeWidth={1} />);
      }
      return <g opacity={0.85}>{lines}</g>;
    },
  },

  'Narrow ruled': {
    id: 'Narrow ruled',
    name: 'Narrow Ruled',
    category: 'Basic',
    description: 'Compact lined paper (~20px spacing) for dense writing',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const topMargin = 50;
      const spacing = 20;
      const lines: React.ReactNode[] = [];
      for (let y = topMargin; y < height - 20; y += spacing) {
        lines.push(<line key={y} x1={0} y1={y} x2={width} y2={y} stroke={color} strokeWidth={1} />);
      }
      return <g opacity={0.85}>{lines}</g>;
    },
  },

  'Wide ruled': {
    id: 'Wide ruled',
    name: 'Wide Ruled',
    category: 'Basic',
    description: 'Spacious lined paper (~36px spacing) for larger handwriting',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const topMargin = 64;
      const spacing = 36;
      const lines: React.ReactNode[] = [];
      for (let y = topMargin; y < height - 20; y += spacing) {
        lines.push(<line key={y} x1={0} y1={y} x2={width} y2={y} stroke={color} strokeWidth={1} />);
      }
      return <g opacity={0.85}>{lines}</g>;
    },
  },

  'Large ruled with margin': {
    id: 'Large ruled with margin',
    name: 'Large Ruled with Margin',
    category: 'Basic',
    description: 'Wide writing bands (~150px) with a single left margin',
    supportsLineColor: true,
    renderSVG: (width, height, color) => renderMarginRuling(width, height, color, 'Large ruled with margin'),
  },
  'Double margin ruled': {
    id: 'Double margin ruled',
    name: 'Double Margin Ruled',
    category: 'Basic',
    description: 'Notebook ruling (~32px) with a double left margin',
    supportsLineColor: true,
    renderSVG: (width, height, color) => renderMarginRuling(width, height, color, 'Double margin ruled'),
  },

  // ========================================================
  // 2. GRID & DOTTED TEMPLATES
  // ========================================================
  'Small grid': {
    id: 'Small grid',
    name: 'Small Grid',
    category: 'Grid',
    description: 'Fine 14px square grid for math calculations and diagrams',
    supportsLineColor: true,
    renderSVG: (width, height, color, _isDark, resourceScope) => {
      const patternId = paintResourceId(resourceScope, 'small-grid');
      return (
        <g opacity={0.75}>
          <defs>
            <pattern id={patternId} width="14" height="14" patternUnits="userSpaceOnUse">
              <path d="M 14 0 L 0 0 0 14" fill="none" stroke={color} strokeWidth="0.75" />
            </pattern>
          </defs>
          <rect width={width} height={height} fill={`url(#${patternId})`} />
        </g>
      );
    },
  },

  'Large grid': {
    id: 'Large grid',
    name: 'Large Grid',
    category: 'Grid',
    description: 'Spacious 28px square grid for technical sketching and layout',
    supportsLineColor: true,
    renderSVG: (width, height, color, _isDark, resourceScope) => {
      const patternId = paintResourceId(resourceScope, 'large-grid');
      return (
        <g opacity={0.8}>
          <defs>
            <pattern id={patternId} width="28" height="28" patternUnits="userSpaceOnUse">
              <path d="M 28 0 L 0 0 0 28" fill="none" stroke={color} strokeWidth="1" />
            </pattern>
          </defs>
          <rect width={width} height={height} fill={`url(#${patternId})`} />
        </g>
      );
    },
  },

  Dotted: {
    id: 'Dotted',
    name: 'Dotted',
    category: 'Grid',
    description: '16px dot matrix pattern for bullet journaling and mockups',
    supportsLineColor: true,
    renderSVG: (width, height, color, _isDark, resourceScope) => {
      const patternId = paintResourceId(resourceScope, 'dotted');
      return (
        <g opacity={0.85}>
          <defs>
            <pattern id={patternId} width="16" height="16" patternUnits="userSpaceOnUse">
              <circle cx="8" cy="8" r="1" fill={color} />
            </pattern>
          </defs>
          <rect width={width} height={height} fill={`url(#${patternId})`} />
        </g>
      );
    },
  },

  Engineering: {
    id: 'Engineering',
    name: 'Engineering Grid',
    category: 'Grid',
    description: 'Multi-level engineering grid with major and minor divisions',
    supportsLineColor: true,
    renderSVG: (width, height, color, _isDark, resourceScope) => {
      const minorPatternId = paintResourceId(resourceScope, 'engineering-minor');
      const majorPatternId = paintResourceId(resourceScope, 'engineering-major');
      return (
        <g opacity={0.85}>
          <defs>
            <pattern id={minorPatternId} width="8" height="8" patternUnits="userSpaceOnUse">
              <path d="M 8 0 L 0 0 0 8" fill="none" stroke={color} strokeWidth="0.4" opacity="0.6" />
            </pattern>
            <pattern id={majorPatternId} width="40" height="40" patternUnits="userSpaceOnUse">
              <rect width="40" height="40" fill={`url(#${minorPatternId})`} />
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke={color} strokeWidth="1.2" />
            </pattern>
          </defs>
          <rect width={width} height={height} fill={`url(#${majorPatternId})`} />
        </g>
      );
    },
  },

  // ========================================================
  // 3. STUDY TEMPLATES
  // ========================================================
  Cornell: {
    id: 'Cornell',
    name: 'Cornell Notes',
    category: 'Study',
    description: 'Structured Cornell method with Cue column, Notes area, and Summary block',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const cueWidth = Math.round(width * 0.28);
      const summaryHeight = Math.round(height * 0.18);
      const topMargin = 54;
      const notesHeight = height - summaryHeight;
      const accent = 'rgba(239, 68, 68, 0.55)'; // Red cue margin divider

      const lines: React.ReactNode[] = [];
      for (let y = topMargin; y < notesHeight; y += 28) {
        lines.push(<line key={y} x1={cueWidth} y1={y} x2={width} y2={y} stroke={color} strokeWidth={1} />);
      }

      return (
        <g>
          {/* Top Title Line */}
          <line x1={0} y1={topMargin} x2={width} y2={topMargin} stroke={color} strokeWidth={1.5} />
          {/* Cue Vertical Line */}
          <line x1={cueWidth} y1={topMargin} x2={cueWidth} y2={notesHeight} stroke={accent} strokeWidth={1.5} />
          {/* Summary Horizontal Line */}
          <line x1={0} y1={notesHeight} x2={width} y2={notesHeight} stroke={accent} strokeWidth={1.5} />
          {/* Ruled Notes Lines */}
          <g opacity={0.8}>{lines}</g>
          {/* Section Label Text */}
          <text x={16} y={topMargin - 16} fill={color} fontSize="11" fontWeight="600" opacity="0.65" fontFamily="sans-serif">CUES / QUESTIONS</text>
          <text x={cueWidth + 16} y={topMargin - 16} fill={color} fontSize="11" fontWeight="600" opacity="0.65" fontFamily="sans-serif">NOTES</text>
          <text x={16} y={notesHeight + 24} fill={color} fontSize="11" fontWeight="600" opacity="0.65" fontFamily="sans-serif">SUMMARY</text>
        </g>
      );
    },
  },

  'Lecture Notes': {
    id: 'Lecture Notes',
    name: 'Lecture Notes',
    category: 'Study',
    description: 'Header box for Topic/Date with two-column Key Concepts & Detailed Notes',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const headerH = 70;
      const splitX = Math.round(width * 0.35);
      const lines: React.ReactNode[] = [];
      for (let y = headerH + 28; y < height - 20; y += 28) {
        lines.push(<line key={y} x1={0} y1={y} x2={width} y2={y} stroke={color} strokeWidth={1} />);
      }
      return (
        <g>
          {/* Header Box */}
          <rect x={16} y={16} width={width - 32} height={headerH - 24} fill="none" stroke={color} strokeWidth={1.2} rx={4} />
          <line x1={Math.round(width * 0.6)} y1={16} x2={Math.round(width * 0.6)} y2={headerH - 8} stroke={color} strokeWidth={1} />
          {/* Column Divider */}
          <line x1={splitX} y1={headerH} x2={splitX} y2={height - 10} stroke={color} strokeWidth={1.5} />
          {/* Column Labels */}
          <text x={20} y={headerH + 18} fill={color} fontSize="10" fontWeight="700" opacity="0.7" fontFamily="sans-serif">KEY CONCEPTS</text>
          <text x={splitX + 16} y={headerH + 18} fill={color} fontSize="10" fontWeight="700" opacity="0.7" fontFamily="sans-serif">DETAILED NOTES</text>
          {/* Lined area */}
          <g opacity={0.75}>{lines}</g>
        </g>
      );
    },
  },

  Assignment: {
    id: 'Assignment',
    name: 'Assignment Sheet',
    category: 'Study',
    description: 'Header for Subject/Due Date with Problem statement & Solution sections',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const headerH = 65;
      const midH = Math.round((height - headerH) * 0.35 + headerH);
      const lines: React.ReactNode[] = [];
      for (let y = headerH + 26; y < height - 20; y += 26) {
        lines.push(<line key={y} x1={0} y1={y} x2={width} y2={y} stroke={color} strokeWidth={0.8} />);
      }
      return (
        <g>
          {/* Header Block */}
          <rect x={16} y={14} width={width - 32} height={headerH - 22} fill="none" stroke={color} strokeWidth={1.2} rx={4} />
          {/* Lined body */}
          <g opacity={0.7}>{lines}</g>
          {/* Problem section divider */}
          <line x1={0} y1={midH} x2={width} y2={midH} stroke={color} strokeWidth={1.5} />
          <text x={20} y={headerH + 18} fill={color} fontSize="10" fontWeight="700" opacity="0.75" fontFamily="sans-serif">PROBLEM & REQUIREMENTS</text>
          <text x={20} y={midH + 18} fill={color} fontSize="10" fontWeight="700" opacity="0.75" fontFamily="sans-serif">WORK & SOLUTION</text>
        </g>
      );
    },
  },

  Checklist: {
    id: 'Checklist',
    name: 'Checklist',
    category: 'Study',
    description: 'Lined paper with square checkboxes down the left margin',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const topMargin = 50;
      const spacing = 32;
      const items: React.ReactNode[] = [];
      for (let y = topMargin; y < height - 20; y += spacing) {
        items.push(
          <g key={y} opacity={0.85}>
            {/* Checkbox square */}
            <rect x={24} y={y - 14} width={14} height={14} rx={3} fill="none" stroke={color} strokeWidth={1.2} />
            {/* Lined text rule */}
            <line x1={48} y1={y} x2={width - 24} y2={y} stroke={color} strokeWidth={1} />
          </g>
        );
      }
      return <g>{items}</g>;
    },
  },

  // ========================================================
  // 4. PLANNING TEMPLATES
  // ========================================================
  'To-do': {
    id: 'To-do',
    name: 'To-Do List',
    category: 'Planning',
    description: 'Structured task list with Priority column, Checkboxes, and Notes',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const topMargin = 56;
      const spacing = 30;
      const rows: React.ReactNode[] = [];
      for (let y = topMargin; y < height - 30; y += spacing) {
        rows.push(
          <g key={y} opacity={0.85}>
            {/* Checkbox */}
            <circle cx={32} cy={y - 7} r={6} fill="none" stroke={color} strokeWidth={1.2} />
            {/* Priority circle */}
            <circle cx={54} cy={y - 7} r={3} fill="none" stroke={color} strokeWidth={0.8} opacity="0.6" />
            {/* Task Line */}
            <line x1={68} y1={y} x2={width - 24} y2={y} stroke={color} strokeWidth={1} />
          </g>
        );
      }
      return (
        <g>
          {/* Header Title */}
          <line x1={20} y1={42} x2={width - 20} y2={42} stroke={color} strokeWidth={1.5} />
          {rows}
        </g>
      );
    },
  },

  'Daily planner': {
    id: 'Daily planner',
    name: 'Daily Planner',
    category: 'Planning',
    description: 'Hourly schedule (6AM-9PM) with Top Priorities and Notes section',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const headerH = 50;
      const splitX = Math.round(width * 0.45);
      const hours = ['6 AM', '7 AM', '8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM', '6 PM', '7 PM', '8 PM', '9 PM'];
      const hourSpacing = (height - headerH - 30) / hours.length;

      const scheduleRows = hours.map((h, i) => {
        const y = headerH + 20 + i * hourSpacing;
        return (
          <g key={h} opacity={0.85}>
            <text x={18} y={y - 4} fill={color} fontSize="8" fontWeight="600" opacity="0.6" fontFamily="sans-serif">{h}</text>
            <line x1={48} y1={y} x2={splitX - 10} y2={y} stroke={color} strokeWidth={0.8} />
          </g>
        );
      });

      const priorityBoxes = [1, 2, 3, 4, 5].map((num, i) => {
        const y = headerH + 30 + i * 32;
        return (
          <g key={num} opacity={0.85}>
            <rect x={splitX + 16} y={y - 12} width={12} height={12} rx={2} fill="none" stroke={color} strokeWidth={1} />
            <line x1={splitX + 36} y1={y} x2={width - 20} y2={y} stroke={color} strokeWidth={0.8} />
          </g>
        );
      });

      return (
        <g>
          {/* Header Banner */}
          <line x1={16} y1={40} x2={width - 16} y2={40} stroke={color} strokeWidth={1.2} />

          {/* Schedule Column */}
          <text x={18} y={headerH + 10} fill={color} fontSize="9" fontWeight="700" opacity="0.75" fontFamily="sans-serif">SCHEDULE</text>
          {scheduleRows}

          {/* Vertical Split */}
          <line x1={splitX} y1={headerH} x2={splitX} y2={height - 20} stroke={color} strokeWidth={1.2} />

          {/* Right Column: Priorities */}
          <text x={splitX + 16} y={headerH + 10} fill={color} fontSize="9" fontWeight="700" opacity="0.75" fontFamily="sans-serif">TOP PRIORITIES</text>
          {priorityBoxes}

          {/* Right Column: Notes Block */}
          <text x={splitX + 16} y={headerH + 215} fill={color} fontSize="9" fontWeight="700" opacity="0.75" fontFamily="sans-serif">NOTES & ACTIONS</text>
          <rect x={splitX + 16} y={headerH + 225} width={width - splitX - 36} height={height - headerH - 245} rx={4} fill="none" stroke={color} strokeWidth={0.8} />
        </g>
      );
    },
  },

  'Weekly planner': {
    id: 'Weekly planner',
    name: 'Weekly Planner',
    category: 'Planning',
    description: '7-day planning blocks with day headers and note rows',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY / NOTES'];
      const topMargin = 45;
      const colH = (height - topMargin - 20) / days.length;

      const blocks = days.map((day, i) => {
        const y = topMargin + i * colH;
        return (
          <g key={day} opacity={0.85}>
            <rect x={18} y={y} width={width - 36} height={colH - 8} rx={4} fill="none" stroke={color} strokeWidth={1} />
            <text x={28} y={y + 16} fill={color} fontSize="9" fontWeight="700" opacity="0.7" fontFamily="sans-serif">{day}</text>
            <line x1={28} y1={y + 22} x2={width - 28} y2={y + 22} stroke={color} strokeWidth={0.5} opacity="0.5" />
          </g>
        );
      });

      return (
        <g>
          {blocks}
        </g>
      );
    },
  },

  'Monthly planner': {
    id: 'Monthly planner',
    name: 'Monthly Planner',
    category: 'Planning',
    description: 'Full calendar grid matrix with day of week headers',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const topMargin = 55;
      const gridW = width - 40;
      const gridH = height - topMargin - 30;
      const colW = gridW / 7;
      const rowH = gridH / 5;
      const dayHeaders = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

      const headers = dayHeaders.map((d, i) => (
        <text key={d} x={20 + i * colW + colW / 2} y={topMargin - 8} textAnchor="middle" fill={color} fontSize="9" fontWeight="700" opacity="0.7" fontFamily="sans-serif">{d}</text>
      ));

      const gridLines: React.ReactNode[] = [];
      for (let c = 0; c <= 7; c++) {
        const x = 20 + c * colW;
        gridLines.push(<line key={`v-${c}`} x1={x} y1={topMargin} x2={x} y2={topMargin + gridH} stroke={color} strokeWidth={1} />);
      }
      for (let r = 0; r <= 5; r++) {
        const y = topMargin + r * rowH;
        gridLines.push(<line key={`h-${r}`} x1={20} y1={y} x2={20 + gridW} y2={y} stroke={color} strokeWidth={1} />);
      }

      return (
        <g opacity={0.85}>
          {headers}
          {gridLines}
        </g>
      );
    },
  },

  // ========================================================
  // 5. SPECIAL TEMPLATES
  // ========================================================
  Journal: {
    id: 'Journal',
    name: 'Journal',
    category: 'Special',
    description: 'Lined journal page with Date/Mood header and generous margins',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const topMargin = 75;
      const spacing = 30;
      const lines: React.ReactNode[] = [];
      for (let y = topMargin; y < height - 30; y += spacing) {
        lines.push(<line key={y} x1={40} y1={y} x2={width - 40} y2={y} stroke={color} strokeWidth={0.9} />);
      }
      return (
        <g>
          {/* Header Details */}
          <line x1={78} y1={38} x2={200} y2={38} stroke={color} strokeWidth={1} opacity="0.5" />
          <line x1={width - 70} y1={38} x2={width - 40} y2={38} stroke={color} strokeWidth={1} opacity="0.5" />
          <line x1={40} y1={52} x2={width - 40} y2={52} stroke={color} strokeWidth={1.5} opacity="0.8" />
          {/* Lined body */}
          <g opacity={0.75}>{lines}</g>
        </g>
      );
    },
  },

  Music: {
    id: 'Music',
    name: 'Music Staff',
    category: 'Special',
    description: '5-line musical notation staves spaced down the sheet',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const staffCount = 8;
      const staffSpacing = (height - 60) / staffCount;
      const staves: React.ReactNode[] = [];

      for (let s = 0; s < staffCount; s++) {
        const startY = 40 + s * staffSpacing;
        const staffLines: React.ReactNode[] = [];
        for (let l = 0; l < 5; l++) {
          const y = startY + l * 7;
          staffLines.push(<line key={l} x1={30} y1={y} x2={width - 30} y2={y} stroke={color} strokeWidth={1} />);
        }
        staves.push(
          <g key={s} opacity={0.9}>
            {/* Start and end bar lines */}
            <line x1={30} y1={startY} x2={30} y2={startY + 28} stroke={color} strokeWidth={1.5} />
            <line x1={width - 30} y1={startY} x2={width - 30} y2={startY + 28} stroke={color} strokeWidth={1.5} />
            {staffLines}
          </g>
        );
      }
      return <g>{staves}</g>;
    },
  },

  Calendar: {
    id: 'Calendar',
    name: 'Calendar Grid',
    category: 'Special',
    description: 'Monthly schedule calendar with side Notes & Objectives block',
    supportsLineColor: true,
    renderSVG: (width, height, color) => {
      const topMargin = 55;
      const calWidth = Math.round(width * 0.72);
      const gridW = calWidth - 30;
      const gridH = height - topMargin - 30;
      const colW = gridW / 7;
      const rowH = gridH / 5;

      const gridLines: React.ReactNode[] = [];
      for (let c = 0; c <= 7; c++) {
        const x = 20 + c * colW;
        gridLines.push(<line key={`cv-${c}`} x1={x} y1={topMargin} x2={x} y2={topMargin + gridH} stroke={color} strokeWidth={1} />);
      }
      for (let r = 0; r <= 5; r++) {
        const y = topMargin + r * rowH;
        gridLines.push(<line key={`ch-${r}`} x1={20} y1={y} x2={20 + gridW} y2={y} stroke={color} strokeWidth={1} />);
      }

      return (
        <g opacity={0.85}>
          {gridLines}
          {/* Side Notes column */}
          <rect x={calWidth + 10} y={topMargin} width={width - calWidth - 26} height={gridH} rx={4} fill="none" stroke={color} strokeWidth={1} />
          <text x={calWidth + 20} y={topMargin + 20} fill={color} fontSize="10" fontWeight="700" opacity="0.75" fontFamily="sans-serif">GOALS & EVENTS</text>
        </g>
      );
    },
  },
};

export const TEMPLATE_CATEGORIES: { id: TemplateCategory; title: string; templates: PageTemplate[] }[] = [
  {
    id: 'Basic',
    title: 'Basic Paper',
    templates: ['Blank', 'Ruled', 'Narrow ruled', 'Wide ruled', 'Large ruled with margin', 'Double margin ruled'],
  },
  {
    id: 'Grid',
    title: 'Grid & Dotted',
    templates: ['Small grid', 'Large grid', 'Dotted', 'Engineering'],
  },
  {
    id: 'Study',
    title: 'Study & Learning',
    templates: ['Cornell', 'Lecture Notes', 'Assignment', 'Checklist'],
  },
  {
    id: 'Planning',
    title: 'Productivity & Planning',
    templates: ['To-do', 'Daily planner', 'Weekly planner', 'Monthly planner'],
  },
  {
    id: 'Special',
    title: 'Specialty Formats',
    templates: ['Journal', 'Music', 'Calendar'],
  },
];
