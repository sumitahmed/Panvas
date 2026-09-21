import { FloatingLineControls } from './FloatingLineControls';
import { StickyGallery } from './StickyGallery';
import { LINE_STYLES, buildLineStyleGeometry, type LineStyle } from './engine/lineStyleGeometry';
import type { InkFamily } from './engine/drawingTypes';
import { INK_FAMILIES, buildInkFamilyGeometry, inkPolygonsPath } from './engine/inkFamilyGeometry';
import React, { useState, useRef, useEffect } from 'react';
import { 
  Bold, Italic, Underline, Heading1, Heading2, Heading3, 
  List, ListChecks, Quote, Code2, 
  PenTool, Pencil, Highlighter, Eraser, MousePointer2, Square, Circle, ArrowRight, Minus, Slash, Type, Hand,
  Undo2, Redo2, X, MoreHorizontal, PenTool as PenToolIcon, ChevronLeft, ChevronRight, Maximize2, Minimize2, PanelLeft, PanelRight,
  Strikethrough, AlignLeft, AlignCenter, AlignRight, AlignJustify, ListOrdered, Palette, PaintBucket, Image as ImageIcon, Ruler, StickyNote, Languages,
  CircleDot, Crosshair, LassoSelect, ScanLine, Shapes, Spline, Check
} from 'lucide-react';
import { FloatingImageControls } from './FloatingImageControls';
import { TextFontPicker } from './TextFontPicker';
import { applyNotebookTextFont } from './textTypography';
import type { Editor } from '@tiptap/react';
import type { NotebookEngine } from './engine/NotebookEngine';
import type { DrawingToolId, EraserMode, ShapeType, StrokePattern } from './engine/drawingTypes';
import { useUIStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { notebookRepository } from '@/repositories/NotebookRepository';
import { NEURAL_STATUS_EVENT, type NeuralStatusDetail } from '@/services/recognition';
import { OverlayManager } from '@/components/ui/OverlayManager';
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport';
import { useToolState } from './useEngineState';
import {
  captureFormattingSelection,
  isUsableFormattingEditor,
  resolveFormattingEditor,
  runFormattingCommand,
  type FormattingCommand,
  type FormattingSelection,
} from './textFormatting';
import {
  resolveToolbarLayout,
  resolveFullscreenToolbarLayout,
  recordRecentColor,
  type ToolbarGroupId,
} from './toolbarLayout';
import {
  DEFAULT_HANDWRITING_TOOL_PREFERENCES,
  SUPPORTED_HANDWRITING_RECOGNITION_LANGUAGES,
  applyHandwritingInkPreferences,
  sanitizeHandwritingToolPreferences,
  type HandwritingToolPreferences,
} from '@/services/beautification/handwritingBeautification';

const DRAWING_TOOLS = ['pen', 'pencil', 'highlighter', 'marker'] as const;
type DrawingTool = typeof DRAWING_TOOLS[number];

const ACTIVE_TOOL_LABELS: Record<string, string> = {
  pen: 'Pen',
  pencil: 'Pencil',
  highlighter: 'Highlighter',
  marker: 'Marker',
  eraser: 'Eraser',
  text: 'Text',
  select: 'Select',
  hand: 'Hand',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  arrow: 'Arrow',
  line: 'Line',
  laser: 'Laser Pointer',
  'handwriting-to-text': 'Handwriting to Text',
};

const DEFAULT_COLORS = [
  '#000000', '#333333', '#666666', '#999999',
  '#CC0000', '#FF4444', '#FF8800', '#FFCC00',
  '#00AA00', '#44CC44', '#0066CC', '#4488FF',
  '#6600CC', '#AA44FF', '#CC0066', '#FF4488',
];

interface ToolSettings {
  color: string;
  thickness: number;
  opacity: number;
  pressureSensitivity: boolean;
  stabilization: number;
  strokePattern: StrokePattern;
  inkFamily?: InkFamily;
}

const DEFAULT_TOOL_SETTINGS: Record<DrawingTool, ToolSettings> = {
  pen: { color: '#000000', thickness: 2.4, opacity: 100, pressureSensitivity: true, stabilization: 52, strokePattern: 'solid' },
  pencil: { color: '#333333', thickness: 1.5, opacity: 85, pressureSensitivity: true, stabilization: 30, strokePattern: 'solid' },
  highlighter: { color: '#FFCC00', thickness: 12, opacity: 40, pressureSensitivity: false, stabilization: 20, strokePattern: 'solid' },
  marker: { color: '#CC0000', thickness: 5, opacity: 90, pressureSensitivity: false, stabilization: 40, strokePattern: 'solid' },
};

// Small, per-tool palettes keep common writing changes one tap away without
// replacing the full settings popover. These values are intentionally scoped
// by tool so a pen choice never silently changes a pencil or highlighter.
const QUICK_COLOR_PRESETS: Record<DrawingTool, readonly string[]> = {
  pen: ['#000000', '#2563eb', '#dc2626', '#16a34a', '#7c3aed'],
  pencil: ['#333333', '#2563eb', '#7c3aed', '#b45309', '#64748b'],
  marker: ['#dc2626', '#f97316', '#2563eb', '#16a34a', '#7c3aed'],
  highlighter: ['#facc15', '#22c55e', '#f9a8d4', '#67e8f9', '#c4b5fd'],
};

const QUICK_THICKNESS_PRESETS: Record<DrawingTool, readonly number[]> = {
  pen: [1.2, 2.4, 3.6],
  pencil: [1, 1.5, 2.5],
  marker: [3, 5, 8],
  highlighter: [8, 12, 16],
};

const HANDWRITING_THICKNESS_PRESETS = QUICK_THICKNESS_PRESETS.pen;

function ToolGlyph({ tool, color, size = 16 }: { tool: string; color?: string; size?: number }) {
  const style = color
    ? { color, filter: color.toLowerCase() === '#ffffff' ? 'drop-shadow(0 0 1px rgba(35, 31, 24, .8))' : undefined }
    : undefined;
  const props = { size, style, strokeWidth: 1.8 };
  switch (tool) {
    case 'pen': return <PenTool {...props} />;
    case 'pencil': return <Pencil {...props} />;
    case 'highlighter': return <Highlighter {...props} />;
    case 'marker': return <PenToolIcon {...props} />;
    case 'eraser': return <Eraser {...props} />;
    case 'text': return <Type {...props} />;
    case 'select': return <MousePointer2 {...props} />;
    case 'hand': return <Hand {...props} />;
    case 'rectangle': return <Square {...props} />;
    case 'ellipse': return <Circle {...props} />;
    case 'arrow': return <ArrowRight {...props} />;
    case 'line': return <Minus {...props} />;
    case 'laser': return <Crosshair {...props} />;
    case 'handwriting-to-text': return <Languages {...props} />;
    default: return <PenTool {...props} />;
  }
}

function getActiveToolColor(tool: string, settings: Record<DrawingTool, ToolSettings>): string | undefined {
  if (tool === 'laser') return '#ef4444';
  return isConfigurableToolName(tool) ? settings[tool].color : undefined;
}

function isConfigurableToolName(tool: string): tool is DrawingTool {
  return (DRAWING_TOOLS as readonly string[]).includes(tool);
}

interface EraserSettings {
  thickness: number;
  mode: Exclude<EraserMode, 'all'>;
}
const DEFAULT_ERASER_SETTINGS: EraserSettings = { thickness: 10, mode: 'pixel' };

interface NotebookFloatingToolbarProps {
  editor: Editor | null;
  engine: NotebookEngine;
  saveKey?: string; // Optional custom key for persistence (e.g. PDF composite key)
  workspaceId?: string;
  hasSelectedStrokes?: boolean;
  onConvertHandwriting?: () => void;
  embedded?: boolean;
  hideCollapseButton?: boolean;
  fullscreenToolOnly?: boolean;
  availableWidth?: number | null;
  pageUtilities?: React.ReactNode;
}

export const NotebookFloatingToolbar: React.FC<NotebookFloatingToolbarProps> = ({ editor, engine, saveKey, workspaceId, hasSelectedStrokes = false, onConvertHandwriting, embedded = false, hideCollapseButton = false, fullscreenToolOnly = false, availableWidth, pageUtilities }) => {
  const isPhone = useIsMobileViewport();
  const compactTools = useIsMobileViewport(1023);
  // Derive the displayed tool from the same ToolManager snapshot used by input routing.
  const toolState = useToolState(engine);
  const activeTool =
    toolState.mode === 'erase' ? 'eraser' :
    toolState.mode === 'draw' ? toolState.drawingTool :
    toolState.mode === 'shape' ? toolState.shapeTool :
    toolState.mode;

  const [showPopup, setShowPopup] = useState(false);
  const [showHandwritingPalette, setShowHandwritingPalette] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [showGesturePopup, setShowGesturePopup] = useState(false);
  
  const { 
    notebookModeLevel, setNotebookModeLevel,
    isToolbarCollapsed, setToolbarCollapsed,
    toggleNotebookPane
  } = useLayoutStore();
  
  const [toolSettings, setToolSettings] = useState<Record<DrawingTool, ToolSettings>>(() => ({ ...DEFAULT_TOOL_SETTINGS }));
  const [recentToolColors, setRecentToolColors] = useState<Record<DrawingTool, string[]>>(() => ({
    pen: [...QUICK_COLOR_PRESETS.pen],
    pencil: [...QUICK_COLOR_PRESETS.pencil],
    marker: [...QUICK_COLOR_PRESETS.marker],
    highlighter: [...QUICK_COLOR_PRESETS.highlighter],
  }));
  const [eraserSettings, setEraserSettings] = useState<EraserSettings>(() => ({ ...DEFAULT_ERASER_SETTINGS }));
  const [handwritingSettings, setHandwritingSettings] = useState<HandwritingToolPreferences>(() => ({ ...DEFAULT_HANDWRITING_TOOL_PREFERENCES }));
  const [scribbleToErase, setScribbleToErase] = useState(false);
  const [circleToSelect, setCircleToSelect] = useState(false);
  const [straightLineRecognition, setStraightLineRecognition] = useState(false);
  const [snapRecognizedLines, setSnapRecognizedLines] = useState(true);
  const [roughShapeRecognition, setRoughShapeRecognition] = useState(false);
  const [snapRecognizedShapes, setSnapRecognizedShapes] = useState(false);
  const [, setSelectionRevision] = useState(0);
  const preferencesLoadedRef = useRef(false);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const overflowAnchorRef = useRef<HTMLButtonElement>(null);
  const gestureAnchorRef = useRef<HTMLButtonElement>(null);
  
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  useEffect(() => engine.selection.subscribe(() => {
    setSelectionRevision(revision => revision + 1);
  }), [engine]);

  useEffect(() => {
    preferencesLoadedRef.current = false;
    if (!workspaceId) return;
    let cancelled = false;
    const load = async () => {
      let raw: any = null;
      try {
        raw = window.panvas
          ? await window.panvas.settings.get(workspaceId, 'toolbar.presets.v1')
          : JSON.parse(localStorage.getItem(`panvas.${workspaceId}.toolbar.presets.v1`) ?? 'null');
      } catch { raw = null; }
      if (cancelled) return;
      if (raw?.toolSettings && typeof raw.toolSettings === 'object') {
        setToolSettings(previous => {
          const next = { ...previous };
          for (const tool of DRAWING_TOOLS) {
            const candidate = raw.toolSettings[tool];
            if (!candidate || typeof candidate !== 'object') continue;
            next[tool] = {
              color: /^#[0-9a-f]{6}$/i.test(candidate.color) ? candidate.color : previous[tool].color,
              thickness: Number.isFinite(candidate.thickness) ? Math.max(0.5, Math.min(20, candidate.thickness)) : previous[tool].thickness,
              opacity: Number.isFinite(candidate.opacity) ? Math.max(5, Math.min(100, candidate.opacity)) : previous[tool].opacity,
              pressureSensitivity: candidate.pressureSensitivity !== false,
              stabilization: Number.isFinite(candidate.stabilization) ? Math.max(0, Math.min(100, candidate.stabilization)) : previous[tool].stabilization,
              inkFamily: INK_FAMILIES.includes(candidate.inkFamily as InkFamily) ? candidate.inkFamily : undefined,
              strokePattern: candidate.strokePattern === 'dashed' || candidate.strokePattern === 'dotted' ? candidate.strokePattern : 'solid',
            };
          }
          return next;
        });
      }
      if (raw?.eraserSettings && typeof raw.eraserSettings === 'object') {
        const savedMode: EraserSettings['mode'] =
          raw.eraserSettings.mode === 'stroke' || raw.eraserSettings.mode === 'highlighter'
            ? raw.eraserSettings.mode
            : 'pixel';
        setEraserSettings({
          thickness: Number.isFinite(raw.eraserSettings.thickness) ? Math.max(2, Math.min(50, raw.eraserSettings.thickness)) : DEFAULT_ERASER_SETTINGS.thickness,
          mode: savedMode,
        });
      }
      if (raw?.recentToolColors && typeof raw.recentToolColors === 'object') {
        setRecentToolColors(previous => {
          const next = { ...previous };
          for (const tool of DRAWING_TOOLS) {
            const colors = raw.recentToolColors[tool];
            if (!Array.isArray(colors)) continue;
            const valid = colors.filter((color: unknown): color is string =>
              typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color));
            if (valid.length > 0) next[tool] = valid.slice(0, 5);
          }
          return next;
        });
      }
      const savedHandwritingSettings = sanitizeHandwritingToolPreferences(raw?.handwritingSettings);
      setHandwritingSettings(savedHandwritingSettings);
      engine.handwriting.setPreferences(savedHandwritingSettings);
      const savedScribbleToErase = raw?.gestureSettings?.scribbleToErase === true;
      const savedCircleToSelect = raw?.gestureSettings?.circleToSelect === true;
      const savedStraightLineRecognition = raw?.gestureSettings?.straightLineRecognition === true;
      const savedSnapRecognizedLines = raw?.gestureSettings?.snapRecognizedLines !== false;
      const savedRoughShapeRecognition = raw?.gestureSettings?.roughShapeRecognition === true;
      const savedSnapRecognizedShapes = raw?.gestureSettings?.snapRecognizedShapes === true;
      const savedRulerEnabled = raw?.gestureSettings?.rulerEnabled === true;
      setScribbleToErase(savedScribbleToErase);
      setCircleToSelect(savedCircleToSelect);
      setStraightLineRecognition(savedStraightLineRecognition);
      setSnapRecognizedLines(savedSnapRecognizedLines);
      setRoughShapeRecognition(savedRoughShapeRecognition);
      setSnapRecognizedShapes(savedSnapRecognizedShapes);
      engine.tools.setScribbleToErase(savedScribbleToErase);
      engine.tools.setCircleToSelect(savedCircleToSelect);
      engine.tools.setStraightLineRecognition(savedStraightLineRecognition);
      engine.tools.setSnapRecognizedLines(savedSnapRecognizedLines);
      engine.tools.setRoughShapeRecognition(savedRoughShapeRecognition);
      engine.tools.setSnapRecognizedShapes(savedSnapRecognizedShapes);
      engine.tools.setRulerEnabled(savedRulerEnabled);
      preferencesLoadedRef.current = true;
    };
    void load();
    return () => { cancelled = true; };
  }, [engine, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !preferencesLoadedRef.current) return;
    const timeout = setTimeout(() => {
      const value = {
        version: 1,
        toolSettings,
        recentToolColors,
        eraserSettings,
        handwritingSettings,
        gestureSettings: {
          scribbleToErase,
          circleToSelect,
          straightLineRecognition,
          snapRecognizedLines,
          roughShapeRecognition,
          snapRecognizedShapes,
          rulerEnabled: toolState.rulerEnabled,
        },
      };
      if (window.panvas) void window.panvas.settings.set(workspaceId, 'toolbar.presets.v1', value);
      else localStorage.setItem(`panvas.${workspaceId}.toolbar.presets.v1`, JSON.stringify(value));
    }, 300);
    return () => clearTimeout(timeout);
  }, [circleToSelect, eraserSettings, handwritingSettings, recentToolColors, roughShapeRecognition, scribbleToErase, snapRecognizedLines, snapRecognizedShapes, straightLineRecognition, toolSettings, toolState.rulerEnabled, workspaceId]);

  useEffect(() => {
    engine.handwriting.setPreferences(handwritingSettings);
    applyHandwritingInkPreferences(engine.tools, handwritingSettings);
  }, [engine, handwritingSettings]);

  useEffect(() => engine.handwriting.subscribeFeedback(feedback => {
    if (feedback.kind === 'error') console.error('[Panvas handwriting recognition]', feedback.message);
    useUIStore.getState().showToast(feedback.message, 'error');
  }), [engine]);

  // Local neural fallback status (EXPERIMENTAL): first-use preparation and
  // download notices. The provider dedupes these; the toolbar only relays.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NeuralStatusDetail>).detail;
      if (!detail) return;
      useUIStore.getState().showToast(detail.message, detail.state === 'error' ? 'error' : 'info');
    };
    document.addEventListener(NEURAL_STATUS_EVENT, handler);
    return () => document.removeEventListener(NEURAL_STATUS_EVENT, handler);
  }, []);

  useEffect(() => {
    if (!toolState.handwritingToTextEnabled) setShowHandwritingPalette(false);
  }, [toolState.handwritingToTextEnabled]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) {
        setContainerWidth(entries[0].contentRect.width);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);



  const isConfigurableDrawingTool = (tool: string): tool is DrawingTool => DRAWING_TOOLS.includes(tool as DrawingTool);
  const isDrawingTool = (tool: string): tool is DrawingToolId => tool === 'laser' || isConfigurableDrawingTool(tool);
  const isShapeTool = (tool: string): tool is ShapeType => ['rectangle', 'rounded-rectangle', 'ellipse', 'triangle', 'diamond', 'arrow', 'line'].includes(tool);

  const handleToolClick = (toolId: string) => {
    if (toolId !== 'text' && editor && !editor.isDestroyed && editor.isFocused) {
      editor.commands.blur();
    }

    if (isConfigurableDrawingTool(toolId)) {
      setShowHandwritingPalette(false);
      if (activeTool === toolId) {
        setShowPopup(prev => !prev);
      } else {
        setShowPopup(true);
      }
    } else if (toolId === 'handwriting-to-text') {
      setShowPopup(false);
    } else if (toolId === 'eraser' || isShapeTool(toolId)) {
      setShowHandwritingPalette(false);
      if (activeTool === toolId) {
        setShowPopup(prev => !prev);
      } else {
        setShowPopup(true);
      }
    } else {
      setShowPopup(false);
      setShowHandwritingPalette(false);
    }

    // Set engine state directly
    if (toolId === 'handwriting-to-text') {
      const turningOff = toolState.handwritingToTextEnabled
        && toolState.mode === 'draw'
        && (toolState.drawingTool === 'pen' || toolState.drawingTool === 'pencil');
      if (turningOff) {
        engine.tools.toggleHandwritingToText();
      } else {
        applyHandwritingInkPreferences(engine.tools, handwritingSettings);
        engine.tools.setDrawingTool(toolState.drawingTool === 'pencil' ? 'pencil' : 'pen');
        if (!toolState.handwritingToTextEnabled) engine.tools.toggleHandwritingToText();
      }
    } else if (toolId === 'select') {
      engine.tools.setMode('select');
    } else if (toolId === 'hand') {
      engine.tools.setMode('hand');
    } else if (toolId === 'text') {
      engine.tools.setMode('text');
    } else if (toolId === 'eraser') {
      engine.tools.setEraserMode(eraserSettings.mode);
      engine.tools.setThickness(eraserSettings.thickness);
    } else if (isShapeTool(toolId)) {
      engine.tools.setShapeTool(toolId as any);
    } else if (toolId === 'laser') {
      engine.tools.setDrawingTool('laser');
    } else if (isConfigurableDrawingTool(toolId)) {
      engine.tools.setDrawingTool(toolId);
      const settings = toolSettings[toolId as DrawingTool];
      engine.tools.setColor(settings.color);
      engine.tools.setThickness(settings.thickness);
      engine.tools.setOpacity(settings.opacity / 100);
      engine.tools.setPressureSensitivity(settings.pressureSensitivity);
      engine.tools.setScribbleToErase(scribbleToErase);
      engine.tools.setCircleToSelect(circleToSelect);
      engine.tools.setStraightLineRecognition(straightLineRecognition);
      engine.tools.setSnapRecognizedLines(snapRecognizedLines);
      engine.tools.setRoughShapeRecognition(roughShapeRecognition);
      engine.tools.setSnapRecognizedShapes(snapRecognizedShapes);
      engine.tools.setStabilization(settings.stabilization);
      engine.tools.setStrokePattern(settings.strokePattern);
      engine.tools.setInkFamily(settings.inkFamily);
    }

    // Close the overflow menu on activation (roadmap section 7). Done at the
    // end of the handler and not via a capture-phase wrapper: unmounting the
    // menu mid-dispatch prevented the clicked button's own handler from running.
    setShowOverflow(false);
  };

  const updateSetting = <K extends keyof ToolSettings>(key: K, value: ToolSettings[K]) => {
    if (!isDrawingTool(activeTool)) return;
    setToolSettings(prev => ({
      ...prev,
      [activeTool]: { ...prev[activeTool as DrawingTool], [key]: value },
    }));

    // Synchronously update engine
    if (key === 'thickness') {
      engine.tools.setThickness(value as number);
      engine.selection.changeThickness(value as number, activeTool);
    }
    if (key === 'opacity') {
      engine.tools.setOpacity((value as number) / 100);
      engine.selection.changeOpacity((value as number) / 100, activeTool);
    }
    if (key === 'color') {
      const color = value as string;
      engine.tools.setColor(color);
      engine.selection.changeColor(color, activeTool);
      if (isConfigurableDrawingTool(activeTool)) {
        setRecentToolColors(previous => ({
          ...previous,
          [activeTool]: recordRecentColor(previous[activeTool], color),
        }));
      }
      if (activeTool === 'pen' || activeTool === 'pencil') {
        const next = sanitizeHandwritingToolPreferences({
          ...handwritingSettings,
          color,
          recentColors: recordRecentColor(handwritingSettings.recentColors, color),
        });
        setHandwritingSettings(next);
        engine.handwriting.setPreferences(next);
        applyHandwritingInkPreferences(engine.tools, next);
      }
    }
    if (key === 'pressureSensitivity') engine.tools.setPressureSensitivity(value as boolean);
    if (key === 'stabilization') engine.tools.setStabilization(value as number);
    if (key === 'inkFamily') engine.tools.setInkFamily(value as InkFamily | undefined);
    if (key === 'strokePattern') engine.tools.setStrokePattern(value as StrokePattern);
  };

  const updateHandwritingSettings = (updates: Partial<HandwritingToolPreferences>) => {
    if (updates.fontFamily) applyNotebookTextFont(engine, updates.fontFamily, editor);
    const recentColors = updates.color
      ? recordRecentColor(handwritingSettings.recentColors, updates.color)
      : handwritingSettings.recentColors;
    const next = sanitizeHandwritingToolPreferences({ ...handwritingSettings, ...updates, recentColors });
    setHandwritingSettings(next);
    engine.handwriting.setPreferences(next);
    applyHandwritingInkPreferences(engine.tools, next);
    if (updates.color && (activeTool === 'pen' || activeTool === 'pencil')) {
      const color = next.color;
      setToolSettings(previous => ({
        ...previous,
        [activeTool]: { ...previous[activeTool], color },
      }));
      setRecentToolColors(previous => ({
        ...previous,
        [activeTool]: recordRecentColor(previous[activeTool], color),
      }));
      engine.tools.setColor(color);
    }
  };

  const currentSettings = isConfigurableDrawingTool(activeTool) ? toolSettings[activeTool] : null;

  const imageSelected = engine.selection.getSelectedElements().length === 1 && engine.selection.getSelectedElements()[0].type === 'image';
  if (isToolbarCollapsed && !imageSelected && !compactTools) {
    return (
      <div
        className="pointer-events-auto flex items-start justify-center shadow-2xl rounded-xl"
      >
        <button
          type="button"
          onClick={() => setToolbarCollapsed(false)}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-panvas-bg-primary text-panvas-text-secondary hover:text-panvas-text-primary hover:bg-panvas-bg-hover transition-colors shadow-lg border border-panvas-border-strong"
          title="Expand Toolbar"
        >
          <MoreHorizontal size={20} />
        </button>
      </div>
    );
  }

  const handleImageImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.png,.jpg,.jpeg,.webp,.gif,.svg,.bmp';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) {
        document.body.removeChild(input);
        return;
      }

      const reader = new FileReader();
      reader.onload = async (re) => {
        const buffer = re.target?.result as ArrayBuffer;
        if (!buffer) return;

        const { activeWorkspaceId, activeNotebookId, activePageId } = useWorkspaceStore.getState();
        if (!activePageId && !saveKey) return;

        try {
          const { canvasRepository } = await import('@/repositories/CanvasRepository');
          const userId = useAuthStore.getState().user?.id || null;
          
          const mimeType = file.type || 'image/png';
          const effectivePageId = saveKey || activePageId;
          if (!effectivePageId) return;
          const imgData = await canvasRepository.storeImage(userId, effectivePageId, file.name, mimeType, buffer);
          
          const imgUrl = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
          const img = new Image();
          img.onload = () => {
            let width = img.width;
            let height = img.height;
            const max = 450;
            if (width > max || height > max) {
              const ratio = Math.min(max / width, max / height);
              width = Math.round(width * ratio);
              height = Math.round(height * ratio);
            }

            // Center on standard A4 / page bounds
            const pageX = 397;
            const pageY = 300;

            const newImg = {
              type: 'image' as const,
              id: imgData.id,
              x: Math.max(20, pageX - width / 2),
              y: Math.max(40, pageY - height / 2),
              width,
              height,
              fileId: imgData.id,
              rotation: 0,
              createdAt: Date.now()
            };

            engine.images.cacheImage(imgData.id, img);
            engine.images.addImage(newImg);
            engine.drawing.redraw();
            
            // Switch to select tool and highlight the inserted image
            engine.tools.setMode('select');
            engine.selection.clearSelection();
            engine.selection.selectAt(newImg.x + 10, newImg.y + 10, false);

            engine.history.pushExecuted({
              description: 'Insert image',
              execute: () => {
                engine.images.addImage(newImg);
                engine.drawing.redraw();
              },
              undo: () => {
                engine.images.removeImage(imgData.id);
                engine.drawing.redraw();
              }
            });

            // Immediate persistence with verified owner
            const effectivePageId = saveKey || activePageId;
            if (effectivePageId) {
              const { notebookPages: allPages, notebooks: allNotebooks } = useWorkspaceStore.getState();
              const pageOwner = allPages.find(p => p.id === effectivePageId);
              const targetNotebookId = pageOwner?.notebookId || activeNotebookId;
              const targetNotebook = targetNotebookId ? allNotebooks.find(n => n.id === targetNotebookId) : null;
              const targetWorkspaceId = targetNotebook?.workspaceId || activeWorkspaceId;
              if (targetWorkspaceId && targetNotebookId) {
                notebookRepository.saveDrawingData(targetWorkspaceId, targetNotebookId, effectivePageId, engine.getDrawingData());
              }
            }

            URL.revokeObjectURL(imgUrl);
          };
          img.onerror = (err) => {
            console.error('Failed to decode inserted image:', err);
          };
          img.src = imgUrl;

        } catch (err) {
          console.error('Failed to store inserted image:', err);
        }
      };
      reader.onerror = (err) => {
        console.error('Failed to read inserted image:', err);
      };
      reader.readAsArrayBuffer(file);
      document.body.removeChild(input);
    };
    input.click();
  };

  // Group order and overflow behavior come from the tested contract in
  // toolbarLayout.ts (roadmap section 7): groups later in the order move into
  // the "More Tools" overflow menu first — format, then shapes, image, hand —
  // while the recognition tool and primary writing tools (Pencil, Pen, Marker, Highlighter, Eraser,
  // Text) and Select stay directly accessible down to the compact breakpoint.
  const toolGroups: { id: ToolbarGroupId; items: React.ReactNode[] }[] = [
    {
      id: 'history',
      items: [
        <ToolButton key="undo" icon={<Undo2 size={16} />} active={false} onClick={() => { if (activeTool === 'text' && editor?.isFocused) editor?.chain().focus().undo().run(); else engine.history.undo(); }} tooltip="Undo (Ctrl+Z)" />,
        <ToolButton key="redo" icon={<Redo2 size={16} />} active={false} onClick={() => { if (activeTool === 'text' && editor?.isFocused) editor?.chain().focus().redo().run(); else engine.history.redo(); }} tooltip="Redo (Ctrl+Y)" />
      ]
    },
    {
      id: 'handwriting',
      items: [
        <ToolButton
          key="handwriting-to-text"
          icon={<Languages size={17} />}
          active={toolState.handwritingToTextEnabled}
          onClick={() => handleToolClick('handwriting-to-text')}
          tooltip="Handwriting to Text"
        />,
      ],
    },
    {
      id: 'primary',
      items: [
        <ToolButton key="pencil" icon={<ToolGlyph tool="pencil" color={toolSettings.pencil.color} />} active={activeTool === 'pencil'} onClick={() => handleToolClick('pencil')} tooltip="Pencil (N)" hasPopup />,
        <ToolButton key="pen" icon={<ToolGlyph tool="pen" color={toolSettings.pen.color} />} active={activeTool === 'pen'} onClick={() => handleToolClick('pen')} tooltip="Pen (P)" hasPopup />,
        <ToolButton key="marker" icon={<ToolGlyph tool="marker" color={toolSettings.marker.color} />} active={activeTool === 'marker'} onClick={() => handleToolClick('marker')} tooltip="Marker (M)" hasPopup />,
        <ToolButton key="highlighter" icon={<ToolGlyph tool="highlighter" color={toolSettings.highlighter.color} />} active={activeTool === 'highlighter'} onClick={() => handleToolClick('highlighter')} tooltip="Highlighter (H)" hasPopup />,
        <ToolButton key="eraser" icon={<Eraser size={16} />} active={activeTool === 'eraser'} onClick={() => handleToolClick('eraser')} tooltip="Eraser (E)" hasPopup />,
        <ToolButton key="text" icon={<Type size={16} />} active={activeTool === 'text'} onClick={() => handleToolClick('text')} tooltip="Text (T)" />
      ]
    },
    {
      id: 'select',
      items: [
        <ToolButton key="select" icon={<MousePointer2 size={16} />} active={activeTool === 'select'} onClick={() => handleToolClick('select')} tooltip="Select (V)" />
      ]
    },
    {
      id: 'hand',
      items: [
        <ToolButton key="hand" icon={<Hand size={16} />} active={activeTool === 'hand'} onClick={() => handleToolClick('hand')} tooltip="Hand (Space)" />
      ]
    },
    {
      id: 'image',
      items: [
        <ToolButton key="image" icon={<ImageIcon size={16} />} active={false} onClick={() => { handleImageImport(); setShowOverflow(false); }} tooltip="Insert Image" />,
        <StickyGallery key="sticky-note" engine={engine} />
      ]
    },
    {
      id: 'shapes',
      items: [
        <ToolButton key="shapes-family" icon={<Shapes size={16} />} active={isShapeTool(activeTool)} onClick={() => handleToolClick(toolState.shapeTool)} tooltip="Shapes" hasPopup />
      ]
    },
    {
      id: 'ruler',
      items: [
        <ToolButton
          key="ruler"
          icon={<Ruler size={16} />}
          active={toolState.rulerEnabled}
          onClick={() => {
            engine.tools.setRulerEnabled(!toolState.rulerEnabled);
            setShowPopup(false);
            setShowOverflow(false);
          }}
          tooltip={toolState.rulerEnabled ? 'Hide Ruler' : 'Show Ruler'}
        />
      ]
    },
    {
      id: 'laser',
      items: [
        <ToolButton key="laser" icon={<ToolGlyph tool="laser" color="#ef4444" />} active={activeTool === 'laser'} onClick={() => handleToolClick('laser')} tooltip="Laser Pointer" />
      ]
    },
    {
      id: 'gestures',
      items: [
        <button
          key="ink-gestures"
          ref={gestureAnchorRef}
          type="button"
          onMouseDown={event => event.preventDefault()}
          onClick={() => {
            setShowGesturePopup(open => !open);
            setShowPopup(false);
            setShowOverflow(false);
          }}
          className="panvas-icon-control h-10 w-10 rounded-xl focus-ring"
          title="Ink Gestures"
          aria-label="Ink Gestures"
          aria-expanded={showGesturePopup}
        >
          <Spline size={17} strokeWidth={1.8} />
        </button>,
      ],
    },
    {
      id: 'format',
      items: [
        <FormatMenuTrigger key="format" editor={editor} engine={engine} />
      ]
    }
  ];

  const layoutWidth = fullscreenToolOnly && availableWidth !== undefined
    ? availableWidth
    : containerWidth;
  const activeToolGroupId: ToolbarGroupId =
    activeTool === 'laser' ? 'laser' :
    isConfigurableDrawingTool(activeTool) || activeTool === 'eraser' || activeTool === 'text' ? 'primary' :
    activeTool === 'select' ? 'select' :
    activeTool === 'hand' ? 'hand' :
    'shapes';
  const layout = compactTools
    ? { visible: [] as ToolbarGroupId[], overflow: ['primary', 'hand', 'handwriting', 'image', 'shapes', 'ruler', 'laser', 'gestures', 'format'] as ToolbarGroupId[] }
    : fullscreenToolOnly
    ? resolveFullscreenToolbarLayout(layoutWidth, activeToolGroupId)
    : resolveToolbarLayout(layoutWidth, activeToolGroupId);
  const groupById = new Map(toolGroups.map(group => [group.id, group]));
  // In compact mode only select is directly visible; every other active tool
  // lives behind the More button, which then carries the active-state dot.
  const activeToolInOverflow = layout.overflow.includes(activeToolGroupId)
    || (toolState.rulerEnabled && layout.overflow.includes('ruler'));
  const showInlineWritingPresets = isConfigurableDrawingTool(activeTool)
    && !toolState.handwritingToTextEnabled
    && layout.visible.includes('primary');
  const showHandwritingSettings = !isPhone && toolState.handwritingToTextEnabled
    && toolState.mode === 'draw'
    && (toolState.drawingTool === 'pen' || toolState.drawingTool === 'pencil');
  const selectedElements = engine.selection.getSelectedElements();
  const selectedImage = activeTool === 'select' && selectedElements.length === 1 && selectedElements[0].type === 'image'
    ? engine.images.getImages().find(image => image.id === selectedElements[0].id)
    : undefined;
  const selectedLine = activeTool === 'select' && selectedElements.length === 1 && selectedElements[0].type === 'shape' ? engine.shapes.getShapes().find(shape => shape.id === selectedElements[0].id && (shape.shapeType === 'line' || shape.shapeType === 'arrow')) : undefined;
  const showSelectionGuide = !isPhone && activeTool === 'select' && !selectedImage && !selectedLine;

  return (
    <div
      className={`panvas-floating-toolbar relative select-none min-w-0 flex justify-center pointer-events-none ${fullscreenToolOnly ? 'w-auto max-w-full' : 'w-full'}`}
      ref={containerRef}
    >
      <OverlayManager
        isOpen={showPopup && currentSettings !== null && activeTool !== 'eraser'}
        onClose={() => setShowPopup(false)}
        anchorRef={toolbarRef}
        placement="bottom-start"
      >
        <DrawingToolPopup
          toolName={activeTool}
          settings={currentSettings as ToolSettings}
          onUpdate={updateSetting}
          onClose={() => setShowPopup(false)}
          onOpenGestures={() => {
            setShowPopup(false);
            setShowGesturePopup(true);
          }}
        />
      </OverlayManager>

      <OverlayManager
        isOpen={showHandwritingPalette && toolState.handwritingToTextEnabled}
        onClose={() => setShowHandwritingPalette(false)}
        anchorRef={toolbarRef}
        placement="bottom-start"
      >
        <ColorPaletteDialog
          label="Handwriting to Text"
          color={handwritingSettings.color}
          onColor={color => updateHandwritingSettings({ color })}
          onClose={() => setShowHandwritingPalette(false)}
        />
      </OverlayManager>

      <OverlayManager isOpen={showGesturePopup} onClose={() => setShowGesturePopup(false)} anchorRef={toolbarRef} placement="bottom-end">
        <GestureSettingsPopup
          scribbleToErase={scribbleToErase}
          circleToSelect={circleToSelect}
          straightLineRecognition={straightLineRecognition}
          snapRecognizedLines={snapRecognizedLines}
          roughShapeRecognition={roughShapeRecognition}
          snapRecognizedShapes={snapRecognizedShapes}
          onScribbleToEraseChange={enabled => { setScribbleToErase(enabled); engine.tools.setScribbleToErase(enabled); }}
          onCircleToSelectChange={enabled => { setCircleToSelect(enabled); engine.tools.setCircleToSelect(enabled); }}
          onStraightLineRecognitionChange={enabled => { setStraightLineRecognition(enabled); engine.tools.setStraightLineRecognition(enabled); }}
          onSnapRecognizedLinesChange={enabled => { setSnapRecognizedLines(enabled); engine.tools.setSnapRecognizedLines(enabled); }}
          onRoughShapeRecognitionChange={enabled => { setRoughShapeRecognition(enabled); engine.tools.setRoughShapeRecognition(enabled); }}
          onSnapRecognizedShapesChange={enabled => { setSnapRecognizedShapes(enabled); engine.tools.setSnapRecognizedShapes(enabled); }}
          onClose={() => setShowGesturePopup(false)}
        />
      </OverlayManager>

      <OverlayManager
        isOpen={showPopup && activeTool === 'eraser'}
        onClose={() => setShowPopup(false)}
        anchorRef={toolbarRef}
        placement="bottom-start"
      >
        <EraserPopup
          settings={eraserSettings}
          onUpdate={(key: keyof EraserSettings | 'mode', val: any) => {
            setEraserSettings(s => {
              const next = { ...s, [key]: val };
              if (key === 'mode') {
                engine.tools.setEraserMode(val);
              }
              if (key === 'thickness') {
                engine.tools.setThickness(val);
              }
              return next;
            });
          }}
          onClose={() => setShowPopup(false)}
        />
      </OverlayManager>

      <OverlayManager
        isOpen={showPopup && isShapeTool(activeTool)}
        onClose={() => setShowPopup(false)}
        anchorRef={toolbarRef}
        placement="bottom-start"
      >
        <ShapePopup
          activeShape={activeTool as ShapeType}
          color={toolState.color}
          thickness={toolState.thickness}
          opacity={toolState.opacity}
          lineStyle={toolState.lineStyle ?? 'solid'}
          onLineStyle={style => { engine.tools.setLineStyle(style); engine.selection.changeLineStyle(style); }}
          fillEnabled={toolState.shapeFillEnabled}
          onShape={shape => handleToolClick(shape)}
          onColor={value => {
            engine.tools.setColor(value);
            engine.selection.changeColor(value);
            if (toolState.shapeFillEnabled) engine.selection.changeShapeFill(value);
          }}
          onThickness={value => { engine.tools.setThickness(value); engine.selection.changeThickness(value); }}
          onOpacity={value => { engine.tools.setOpacity(value); engine.selection.changeOpacity(value); }}
          onFill={enabled => {
            engine.tools.setShapeFillEnabled(enabled);
            engine.selection.changeShapeFill(enabled ? toolState.color : null);
          }}
          onRotate={degrees => engine.selection.rotateSelection(degrees)}
          onClose={() => setShowPopup(false)}
        />
      </OverlayManager>

      <div ref={toolbarRef} className={`pointer-events-auto flex items-center justify-center gap-1 text-panvas-text-primary max-[599px]:gap-0.5 ${embedded ? 'px-1 py-1' : 'panvas-toolbar-surface panvas-floating-surface px-3 py-2 max-[599px]:px-1.5 max-[599px]:py-1'}`}>
        {compactTools && <>
          {groupById.get('history')?.items}
          <ToolButton icon={<ToolGlyph tool={isConfigurableDrawingTool(activeTool) ? activeTool : 'pen'} color={getActiveToolColor(isConfigurableDrawingTool(activeTool) ? activeTool : 'pen', toolSettings)} />} active={isConfigurableDrawingTool(activeTool)} onClick={() => handleToolClick(isConfigurableDrawingTool(activeTool) ? activeTool : 'pen')} tooltip="Pen and writing settings" hasPopup />
          {groupById.get('select')?.items}
          <ToolButton icon={<Eraser size={18} />} active={activeTool === 'eraser'} onClick={() => handleToolClick('eraser')} tooltip="Eraser (E)" />
          <ToolButton icon={<Type size={18} />} active={activeTool === 'text'} onClick={() => handleToolClick('text')} tooltip="Text (T)" />
        </>}
        
        {layout.visible.map((groupId, index) => (
          <React.Fragment key={groupId}>
            {groupId === 'active-tool' ? (
              <ToolButton
                icon={<ToolGlyph tool={activeTool} color={getActiveToolColor(activeTool, toolSettings)} />}
                active
                hasPopup={isConfigurableDrawingTool(activeTool) || activeTool === 'eraser'}
                onClick={() => {
                  if (isConfigurableDrawingTool(activeTool) || activeTool === 'eraser') {
                    handleToolClick(activeTool);
                  } else {
                    setShowOverflow(true);
                  }
                }}
                tooltip={`${ACTIVE_TOOL_LABELS[activeTool] ?? 'Tool'} — active`}
              />
            ) : (
              groupById.get(groupId)?.items
            )}
            {index < layout.visible.length - 1 && <Divider />}
          </React.Fragment>
        ))}

        {layout.overflow.length > 0 && (
          <>
            {!compactTools && <Divider />}
            <button
              ref={overflowAnchorRef}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setShowOverflow(!showOverflow)}
              className="panvas-icon-control relative h-10 w-10 rounded-xl focus-ring max-[599px]:h-9 max-[599px]:w-9 max-[599px]:rounded-lg"
              title="More Tools"
              aria-label="More Tools"
              aria-expanded={showOverflow}
            >
              <MoreHorizontal size={16} />
              {activeToolInOverflow && (
                <span className="absolute right-1 top-1 h-[5px] w-[5px] rounded-full bg-panvas-accent-blue" />
              )}
            </button>

            <OverlayManager isOpen={showOverflow} onClose={() => setShowOverflow(false)} anchorRef={overflowAnchorRef} placement={isPhone ? 'top-end' : 'bottom-end'}>
              <div
                className="panvas-floating-surface flex w-max flex-col gap-2 p-2 max-[599px]:w-[min(20rem,calc(100vw-1.5rem))] max-[599px]:max-h-[60vh] max-[599px]:overflow-y-auto"
                role="menu"
                aria-label="More Tools"
              >
                {pageUtilities && (
                  <div>
                    {isPhone && <div className="px-2 pb-1 text-xs font-medium text-panvas-text-secondary">Page actions</div>}
                    <div className="flex items-center gap-1 max-[599px]:flex-wrap max-[599px]:justify-start">
                      {pageUtilities}
                    </div>
                    {layout.overflow.length > 0 && <div className="h-[1px] w-full bg-panvas-border-subtle my-1" />}
                  </div>
                )}
                {isConfigurableDrawingTool(activeTool) && !toolState.handwritingToTextEnabled && !showInlineWritingPresets && currentSettings && (
                  <>
                     <WritingPresetStrip
                       tool={activeTool}
                       settings={currentSettings}
                       recentColors={recentToolColors[activeTool]}
                       onColor={value => updateSetting('color', value)}
                       onThickness={value => updateSetting('thickness', value)}
                       onPalette={() => { setShowOverflow(false); setShowPopup(true); }}
                     />
                    {layout.overflow.length > 0 && <div className="h-[1px] w-full bg-panvas-border-subtle my-1" />}
                  </>
                )}
                {layout.overflow.map((groupId, index) => (
                  <React.Fragment key={groupId}>
                    {/* Tool buttons close the menu themselves at the end of
                        handleToolClick; the format group opens its own submenu
                        instead and stays put. */}
                    {groupId === 'gestures' ? (
                      <button
                        type="button"
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => {
                          setShowGesturePopup(true);
                          setShowPopup(false);
                          setShowOverflow(false);
                        }}
                        className="flex h-10 w-full min-w-48 items-center gap-3 rounded-xl px-3 text-left text-sm text-panvas-text-primary transition-colors hover:bg-panvas-bg-hover focus-ring"
                        title="Ink Gestures"
                        aria-label="Ink Gestures"
                        aria-haspopup="dialog"
                      >
                        <Spline size={18} strokeWidth={1.8} className="text-panvas-text-secondary" aria-hidden="true" />
                        <span className="flex-1 font-medium">Ink gestures</span>
                        <ChevronRight size={15} className="text-panvas-text-tertiary" aria-hidden="true" />
                      </button>
                    ) : (
                      <div>
                      {isPhone && <div className="px-2 pb-1 text-xs font-medium text-panvas-text-secondary">{({ history: 'History', handwriting: 'Handwriting to text', primary: 'Writing tools', select: 'Selection', hand: 'Move around the page', image: 'Insert image or sticky note', shapes: 'Shapes', ruler: 'Ruler', laser: 'Presentation pointer', format: 'Formatting' } as Record<string, string>)[groupId]}</div>}
                      <div className="flex items-center justify-center gap-1 max-[599px]:flex-wrap max-[599px]:justify-start">
                        {groupById.get(groupId)?.items}
                      </div>
                      </div>
                    )}
                    {index < layout.overflow.length - 1 && <div className="h-[1px] w-full bg-panvas-border-subtle my-1" />}
                  </React.Fragment>
                ))}
              </div>
            </OverlayManager>
          </>
        )}

        {!compactTools && !hideCollapseButton && <><Divider />
          <button type="button" onClick={() => setToolbarCollapsed(true)} className="panvas-icon-control focus-ring" title="Hide Toolbar" aria-label="Hide toolbar">
            <ChevronLeft size={16} />
          </button></>}
      </div>

      {showInlineWritingPresets && currentSettings && isConfigurableDrawingTool(activeTool) && (
        <div className="panvas-writing-preset-host pointer-events-auto absolute left-1/2 top-full mt-2 -translate-x-1/2 max-[599px]:mt-1.5">
          <WritingPresetStrip
            tool={activeTool}
            settings={currentSettings}
            recentColors={recentToolColors[activeTool]}
            onColor={value => updateSetting('color', value)}
            onThickness={value => updateSetting('thickness', value)}
            onPalette={() => setShowPopup(true)}
          />
        </div>
      )}

      {showHandwritingSettings && (
        <div className="panvas-writing-preset-host pointer-events-auto absolute left-1/2 top-full mt-2 -translate-x-1/2 max-[599px]:mt-1.5">
          <HandwritingSettingsStrip
            settings={handwritingSettings}
            onChange={updateHandwritingSettings}
            onPalette={() => setShowHandwritingPalette(true)}
          />
        </div>
      )}

      {selectedLine && <FloatingLineControls engine={engine} shape={selectedLine} />}
      {selectedImage && <FloatingImageControls key={selectedImage.id} image={selectedImage} engine={engine} />}

      {showSelectionGuide && (
        <div
          className="panvas-writing-preset-host pointer-events-auto absolute left-1/2 top-full mt-2 -translate-x-1/2 max-[599px]:mt-1.5 flex items-center gap-2 whitespace-nowrap px-3 py-2 text-xs text-panvas-text-secondary"
          aria-label="Select tool options"
        >
          <span className="flex items-center gap-1.5 font-medium text-panvas-text-primary">
            <LassoSelect size={14} className="text-panvas-accent-blue" aria-hidden="true" />
            Lasso Select
          </span>
          <span>Click an object, or drag a freeform boundary</span>
        </div>
      )}

      {/* Contextual rich-text surface belongs exclusively to Text mode. A selected
          text object may remain selected when switching tools, but its formatter must
          yield to the active pen/pencil presets instead of stacking over them. */}
      <TextFormattingStrip editor={editor} engine={engine} enabled={activeTool === 'text'} />

      {hasSelectedStrokes && onConvertHandwriting && (
        <button
          type="button"
          onClick={onConvertHandwriting}
          className={`panvas-floating-surface pointer-events-auto absolute left-1/2 top-full flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-xs font-medium text-panvas-text-primary hover:bg-panvas-bg-hover focus-ring max-[599px]:py-1.5 max-[599px]:text-2xs ${showInlineWritingPresets || showHandwritingSettings || showSelectionGuide ? 'mt-14 max-[599px]:mt-12' : 'mt-2'}`}
          title="Convert selected handwriting to text"
        >
          <Languages size={14} className="text-panvas-accent-blue" aria-hidden="true" />
          Convert to Text
        </button>
      )}
    </div>
  );
};

function FormatMenuTrigger({ editor, engine }: { editor: Editor | null, engine: NotebookEngine }) {
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const sessionEditorRef = useRef<Editor | null>(null);
  const sessionSelectionRef = useRef<FormattingSelection | null>(null);

  const resolvedEditor = resolveFormattingEditor(editor, engine);
  const commandEditor = showSlashMenu && isUsableFormattingEditor(sessionEditorRef.current)
    ? sessionEditorRef.current
    : resolvedEditor;

  const beginFormattingSession = () => {
    const targetEditor = resolveFormattingEditor(editor, engine);
    sessionEditorRef.current = targetEditor;
    sessionSelectionRef.current = targetEditor
      ? captureFormattingSelection(targetEditor)
      : null;
  };

  const closeFormattingMenu = () => {
    setShowSlashMenu(false);
    sessionEditorRef.current = null;
    sessionSelectionRef.current = null;
  };

  const applyTextCommand = (commandFn: (chain: any) => any) => {
    let targetEditor = sessionEditorRef.current;
    if (!isUsableFormattingEditor(targetEditor)) {
      targetEditor = resolveFormattingEditor(editor, engine);
      sessionEditorRef.current = targetEditor;
      sessionSelectionRef.current = targetEditor
        ? captureFormattingSelection(targetEditor)
        : null;
    }
    if (!targetEditor) return;

    sessionSelectionRef.current = runFormattingCommand(
      targetEditor,
      sessionSelectionRef.current,
      commandFn,
    );
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (showSlashMenu) {
            closeFormattingMenu();
          } else {
            beginFormattingSession();
            setShowSlashMenu(true);
          }
        }}
        className={`flex h-10 items-center justify-center p-1.5 rounded-lg transition-colors ${
          showSlashMenu ? 'bg-panvas-bg-hover text-panvas-text-primary' : 'text-panvas-text-secondary hover:text-panvas-text-primary hover:bg-panvas-bg-hover'
        }`}
        title="Text Formatting"
      >
        <span className="text-xs font-semibold px-1">Aa</span>
      </button>

      <OverlayManager isOpen={showSlashMenu} onClose={closeFormattingMenu} anchorRef={anchorRef} placement="bottom-start">
        <div
          className="w-[260px] rounded-xl bg-panvas-bg-primary border border-panvas-border-strong shadow-2xl overflow-y-auto max-h-[60vh] py-2 max-[599px]:w-[min(17rem,calc(100vw-1.5rem))]"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <TextFormatMenuContent engine={engine} commandEditor={commandEditor} applyTextCommand={applyTextCommand} />
        </div>
      </OverlayManager>
    </>
  );
}

/**
 * The one full text-formatting surface, shared by the toolbar's Aa trigger
 * and the contextual text-formatting strip. Every control runs through the
 * session command runner, so formatting applies to the live caret or the
 * retained selected range — never the whole object.
 */
function TextFormatMenuContent({ engine, commandEditor, applyTextCommand }: {
  engine: NotebookEngine;
  commandEditor: Editor | null;
  applyTextCommand: (command: FormattingCommand) => void;
}) {
  return (
    <>
      <div className="px-3 pb-1 mb-1 border-b border-panvas-border-subtle text-2xs font-semibold text-panvas-text-tertiary uppercase tracking-wider">Style</div>
      <div className="flex justify-center gap-1 px-2 mb-2">
        <ToolButton icon={<Bold size={16} />} active={commandEditor?.isActive('bold') ?? false} onClick={() => applyTextCommand(c => c.toggleBold())} tooltip="Bold (Ctrl+B)" />
        <ToolButton icon={<Italic size={16} />} active={commandEditor?.isActive('italic') ?? false} onClick={() => applyTextCommand(c => c.toggleItalic())} tooltip="Italic (Ctrl+I)" />
        <ToolButton icon={<Underline size={16} />} active={commandEditor?.isActive('underline') ?? false} onClick={() => applyTextCommand(c => c.toggleUnderline())} tooltip="Underline (Ctrl+U)" />
        <ToolButton icon={<Strikethrough size={16} />} active={commandEditor?.isActive('strike') ?? false} onClick={() => applyTextCommand(c => c.toggleStrike())} tooltip="Strikethrough" />
      </div>

      <div className="px-3 pb-1 mb-1 mt-2 border-b border-panvas-border-subtle text-2xs font-semibold text-panvas-text-tertiary uppercase tracking-wider">Typography</div>
      <div className="px-2 mb-2 space-y-2">
        <div className="flex gap-2">
          <TextFontPicker
            value={commandEditor?.getAttributes('textStyle').fontFamily || engine.texts.getDefaultFontFamily()}
            onChange={font => {
              if (commandEditor?.isFocused && !commandEditor.state.selection.empty) {
                engine.texts.setDefaultFontFamily(font);
                applyTextCommand(c => c.setFontFamily(font || 'Inter, sans-serif'));
              } else applyNotebookTextFont(engine, font, commandEditor);
            }}
          />
          <select
            className="w-20 rounded-md border border-panvas-border-default bg-panvas-bg-primary px-2 py-1 text-xs text-panvas-text-primary"
            value={commandEditor?.getAttributes('textStyle').fontSize || ''}
            onChange={e => e.target.value ? applyTextCommand(c => c.setFontSize(e.target.value)) : applyTextCommand(c => c.unsetFontSize())}
          >
            <option value="">Size</option>
            <option value="12px">12px</option>
            <option value="14px">14px</option>
            <option value="16px">16px</option>
            <option value="20px">20px</option>
            <option value="24px">24px</option>
            <option value="32px">32px</option>
          </select>
        </div>
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <Palette size={14} className="text-panvas-text-secondary" />
            <span className="text-xs text-panvas-text-secondary">Text</span>
          </div>

          <input
            type="color"
            value={commandEditor?.getAttributes('textStyle').color || '#000000'}
            onMouseDown={(e) => e.preventDefault()}
            onChange={e => applyTextCommand(c => c.setColor(e.target.value))}
            className="w-6 h-6 p-0 border border-panvas-border-default rounded cursor-pointer"
          />
        </div>
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <PaintBucket size={14} className="text-panvas-text-secondary" />
            <span className="text-xs text-panvas-text-secondary">Highlight</span>
          </div>
          <input
            type="color"
            value={commandEditor?.getAttributes('highlight').color || '#ffffff'}
            onMouseDown={(e) => e.preventDefault()}
            onChange={e => applyTextCommand(c => c.setHighlight({ color: e.target.value }))}
            className="w-6 h-6 p-0 border border-panvas-border-default rounded cursor-pointer"
          />
        </div>
      </div>

      <div className="px-3 pb-1 mb-1 mt-2 border-b border-panvas-border-subtle text-2xs font-semibold text-panvas-text-tertiary uppercase tracking-wider">Alignment</div>
      <div className="flex justify-center gap-1 px-2 mb-2">
        <ToolButton icon={<AlignLeft size={16} />} active={commandEditor?.isActive({ textAlign: 'left' }) ?? false} onClick={() => applyTextCommand(c => c.setTextAlign('left'))} tooltip="Align Left" />
        <ToolButton icon={<AlignCenter size={16} />} active={commandEditor?.isActive({ textAlign: 'center' }) ?? false} onClick={() => applyTextCommand(c => c.setTextAlign('center'))} tooltip="Align Center" />
        <ToolButton icon={<AlignRight size={16} />} active={commandEditor?.isActive({ textAlign: 'right' }) ?? false} onClick={() => applyTextCommand(c => c.setTextAlign('right'))} tooltip="Align Right" />
        <ToolButton icon={<AlignJustify size={16} />} active={commandEditor?.isActive({ textAlign: 'justify' }) ?? false} onClick={() => applyTextCommand(c => c.setTextAlign('justify'))} tooltip="Justify" />
      </div>

      <div className="px-3 pb-1 mb-1 mt-2 border-b border-panvas-border-subtle text-2xs font-semibold text-panvas-text-tertiary uppercase tracking-wider">Headings</div>
      <div className="flex justify-center gap-1 px-2 mb-2">
        <ToolButton icon={<span className="font-bold">H1</span>} active={commandEditor?.isActive('heading', { level: 1 }) ?? false} onClick={() => applyTextCommand(c => c.toggleHeading({ level: 1 }))} tooltip="Heading 1" />
        <ToolButton icon={<span className="font-bold">H2</span>} active={commandEditor?.isActive('heading', { level: 2 }) ?? false} onClick={() => applyTextCommand(c => c.toggleHeading({ level: 2 }))} tooltip="Heading 2" />
        <ToolButton icon={<span className="font-bold">H3</span>} active={commandEditor?.isActive('heading', { level: 3 }) ?? false} onClick={() => applyTextCommand(c => c.toggleHeading({ level: 3 }))} tooltip="Heading 3" />
      </div>

      <div className="px-3 pb-1 mb-1 mt-2 border-b border-panvas-border-subtle text-2xs font-semibold text-panvas-text-tertiary uppercase tracking-wider">Blocks</div>
      <div className="flex justify-center gap-1 px-2 mb-2">
        <ToolButton icon={<List size={16} />} active={commandEditor?.isActive('bulletList') ?? false} onClick={() => applyTextCommand(c => c.toggleBulletList())} tooltip="Bullet List" />
        <ToolButton icon={<ListOrdered size={16} />} active={commandEditor?.isActive('orderedList') ?? false} onClick={() => applyTextCommand(c => c.toggleOrderedList())} tooltip="Numbered List" />
        <ToolButton icon={<ListChecks size={16} />} active={commandEditor?.isActive('taskList') ?? false} onClick={() => applyTextCommand(c => c.toggleTaskList())} tooltip="Checklist" />
        <ToolButton icon={<Quote size={16} />} active={commandEditor?.isActive('blockquote') ?? false} onClick={() => applyTextCommand(c => c.toggleBlockquote())} tooltip="Quote" />
        <ToolButton icon={<Code2 size={16} />} active={commandEditor?.isActive('codeBlock') ?? false} onClick={() => applyTextCommand(c => c.toggleCodeBlock())} tooltip="Code Block" />
      </div>
    </>
  );
}

/**
 * Contextual formatting strip for active text editing. It renders only while
 * a usable text editor exists (focused editor or a selected text object) and
 * keeps the primary inline controls — bold, italic, underline, text/highlight
 * color — one tap away; strikethrough and every paragraph control stay in the
 * shared full menu behind the Aa trigger. Buttons hold the pointer with
 * preventDefault so the editor never blurs and no ink is created underneath.
 */
function TextFormattingStrip({ editor, engine, enabled }: {
  editor: Editor | null;
  engine: NotebookEngine;
  enabled: boolean;
}) {
  const isMobileViewport = useIsMobileViewport();
  const resolvedEditor = resolveFormattingEditor(editor, engine);
  const [showFullMenu, setShowFullMenu] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const [, refreshOnTransaction] = useState(0);

  // Marks and caret state change without a React render; follow the editor's
  // own transactions so the toggle states stay truthful while typing.
  useEffect(() => {
    if (!resolvedEditor) return undefined;
    const update = () => refreshOnTransaction(count => count + 1);
    resolvedEditor.on('transaction', update);
    return () => {
      resolvedEditor.off('transaction', update);
    };
  }, [resolvedEditor]);

  useEffect(() => {
    if (!enabled) setShowFullMenu(false);
  }, [enabled]);

  if (!enabled || !resolvedEditor) return null;

  const apply = (command: FormattingCommand) => {
    runFormattingCommand(resolvedEditor, null, command);
  };

  return (
    <div
      className="panvas-floating-surface pointer-events-auto absolute left-1/2 top-full mt-2 -translate-x-1/2 flex h-9 max-w-[calc(100vw-1rem)] items-center gap-0.5 px-1.5 max-[599px]:mt-1.5"
      aria-label="Text formatting"
    >
      <ToolButton icon={<Bold size={15} />} active={resolvedEditor.isActive('bold')} onClick={() => apply(c => c.toggleBold())} tooltip="Bold (Ctrl+B)" />
      <ToolButton icon={<Italic size={15} />} active={resolvedEditor.isActive('italic')} onClick={() => apply(c => c.toggleItalic())} tooltip="Italic (Ctrl+I)" />
      <ToolButton icon={<Underline size={15} />} active={resolvedEditor.isActive('underline')} onClick={() => apply(c => c.toggleUnderline())} tooltip="Underline (Ctrl+U)" />
      {!isMobileViewport && (
        <ToolButton icon={<Strikethrough size={15} />} active={resolvedEditor.isActive('strike')} onClick={() => apply(c => c.toggleStrike())} tooltip="Strikethrough" />
      )}
      <Divider />
      <input
        type="color"
        aria-label="Text color"
        title="Text color"
        value={resolvedEditor.getAttributes('textStyle').color || '#000000'}
        onMouseDown={(e) => e.preventDefault()}
        onChange={e => apply(c => c.setColor(e.target.value))}
        className="h-6 w-6 shrink-0 cursor-pointer rounded border border-panvas-border-default p-0"
      />
      <input
        type="color"
        aria-label="Highlight color"
        title="Highlight color"
        value={resolvedEditor.getAttributes('highlight').color || '#ffffff'}
        onMouseDown={(e) => e.preventDefault()}
        onChange={e => apply(c => c.setHighlight({ color: e.target.value }))}
        className="h-6 w-6 shrink-0 cursor-pointer rounded border border-panvas-border-default p-0"
      />
      <Divider />
      <button
        ref={menuAnchorRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShowFullMenu(open => !open)}
        aria-expanded={showFullMenu}
        aria-haspopup="dialog"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold transition-colors focus-ring ${showFullMenu ? 'bg-panvas-bg-hover text-panvas-text-primary' : 'text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary'}`}
        title="More text formatting"
        aria-label="More text formatting"
      >
        Aa
      </button>
      <OverlayManager isOpen={showFullMenu} onClose={() => setShowFullMenu(false)} anchorRef={menuAnchorRef} placement="bottom-start">
        <div
          role="dialog"
          aria-label="Text formatting options"
          className="w-[260px] rounded-xl bg-panvas-bg-primary border border-panvas-border-strong shadow-2xl overflow-y-auto max-h-[60vh] py-2 max-[599px]:w-[min(17rem,calc(100vw-1.5rem))]"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <TextFormatMenuContent engine={engine} commandEditor={resolvedEditor} applyTextCommand={apply} />
        </div>
      </OverlayManager>
    </div>
  );
}

// ─── Drawing Tool Settings Popup ───────────────────────────────────────────────

function DrawingToolPopup({ toolName, settings, onUpdate, onClose, onOpenGestures }: {
  toolName: string;
  settings: ToolSettings;
  onUpdate: <K extends keyof ToolSettings>(key: K, value: ToolSettings[K]) => void;
  onClose: () => void;
  onOpenGestures: () => void;
}) {
  const toolLabel = toolName.charAt(0).toUpperCase() + toolName.slice(1);

  return (
    <section role="dialog" aria-label={`${toolLabel} settings`} className="w-[min(26.25rem,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border border-panvas-border-strong bg-panvas-bg-primary text-panvas-text-primary shadow-2xl max-[599px]:max-h-[60vh]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-panvas-border-subtle bg-panvas-bg-secondary/50">
        <span className="text-sm font-semibold text-panvas-text-primary">{toolLabel} Settings</span>
        <button type="button" onClick={onClose} className="text-panvas-text-secondary hover:text-panvas-text-primary transition-colors" aria-label={`Close ${toolLabel} settings`} title={`Close ${toolLabel} settings`}>
          <X size={14} />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-0 sm:grid-cols-2">
        {/* Left: Stroke Settings */}
        <div className="space-y-4 border-b border-panvas-border-subtle p-4 sm:border-b-0 sm:border-r">
          <div className="text-2xs font-semibold uppercase tracking-widest text-panvas-text-secondary">Stroke Style</div>

          {toolName === 'pen' && <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Pen nib">
            {([undefined, ...INK_FAMILIES] as const).map(family => <button key={family ?? 'legacy'} type="button" aria-pressed={settings.inkFamily === family} onClick={() => onUpdate('inkFamily', family)} className={`rounded-lg border px-2 py-1 text-left focus-ring ${settings.inkFamily === family ? 'border-panvas-accent-blue bg-panvas-bg-active' : 'border-panvas-border-subtle hover:bg-panvas-bg-hover'}`}>
              <NibPreview family={family} color={settings.color} />
              <span className="text-2xs capitalize">{family ?? 'Classic pen'}</span>
            </button>)}
          </div>}
          {/* Thickness */}
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-panvas-text-secondary">Thickness</span>
              <span className="text-panvas-text-tertiary">{settings.thickness.toFixed(1)} mm</span>
            </div>
            <input
              type="range" min="0.5" max="20" step="0.1"
              value={settings.thickness}
              onChange={e => onUpdate('thickness', parseFloat(e.target.value))}
              className="w-full h-1.5 rounded-full bg-panvas-border-default appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          {/* Opacity */}
          <div>
            <div className="mb-1.5 text-xs text-panvas-text-secondary">Stroke pattern</div>
            <div className="grid grid-cols-3 gap-1" role="group" aria-label="Stroke pattern">
              {(['solid', 'dashed', 'dotted'] as const).map(pattern => (
                <button
                  key={pattern}
                  type="button"
                  aria-pressed={settings.strokePattern === pattern}
                  onClick={() => onUpdate('strokePattern', pattern)}
                  className={`rounded-md border px-2 py-1.5 text-2xs capitalize transition-colors ${settings.strokePattern === pattern ? 'border-blue-500/50 bg-blue-500/10 text-blue-500' : 'border-panvas-border-subtle bg-panvas-bg-secondary text-panvas-text-secondary hover:bg-panvas-bg-hover'}`}
                >{pattern}</button>
              ))}
            </div>
          </div>

          {/* Opacity */}
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-panvas-text-secondary">Opacity</span>
              <span className="text-panvas-text-tertiary">{settings.opacity}%</span>
            </div>
            <input
              type="range" min="5" max="100" step="1"
              value={settings.opacity}
              onChange={e => onUpdate('opacity', parseInt(e.target.value))}
              className="w-full h-1.5 rounded-full bg-panvas-border-default appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          {/* Stabilization */}
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-panvas-text-secondary">Stabilization</span>
              <span className="text-panvas-text-tertiary">{settings.stabilization}%</span>
            </div>
            <input
              type="range" min="0" max="100" step="1"
              value={settings.stabilization}
              onChange={e => onUpdate('stabilization', parseInt(e.target.value))}
              className="w-full h-1.5 rounded-full bg-panvas-border-default appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          {/* Brush Preview */}
          <div className="rounded-lg bg-panvas-bg-secondary p-2.5 border border-panvas-border-subtle">
            <div className="text-2xs text-panvas-text-tertiary mb-1">Preview</div>
            {toolName === 'pen' && settings.inkFamily ? <NibPreview family={settings.inkFamily} color={settings.color} thickness={Math.min(settings.thickness, 10)} pattern={settings.strokePattern} opacity={settings.opacity / 100} pressure={settings.pressureSensitivity} /> : <svg className="w-full h-8" viewBox="0 0 200 32" fill="none">
              <path
                d="M4 24C30 4 55 28 90 14S140 6 196 20"
                stroke={settings.color}
                strokeWidth={Math.min(settings.thickness, 6)}
                strokeLinecap="round"
                strokeDasharray={settings.strokePattern === 'dashed' ? '12 8' : settings.strokePattern === 'dotted' ? '0.1 8' : undefined}
                opacity={settings.opacity / 100}
              />
            </svg>}
          </div>
        </div>

        {/* Right: Color & Pressure */}
        <div className="p-4 space-y-4">
          <ColorPaletteControl
            label={toolLabel}
            color={settings.color}
            onColor={color => onUpdate('color', color)}
          />

          {/* Pressure Sensitivity */}
          <div className="mt-3">
            <div className="text-2xs font-semibold uppercase tracking-widest text-panvas-text-secondary mb-2">Pressure Sensitivity</div>
            <button
              type="button"
              onClick={() => onUpdate('pressureSensitivity', !settings.pressureSensitivity)}
              className={`w-full flex items-center justify-between rounded-lg px-3 py-2 text-xs transition-colors border ${
                settings.pressureSensitivity
                  ? 'bg-blue-500/10 text-blue-500 border-blue-500/30'
                  : 'bg-panvas-bg-secondary text-panvas-text-secondary border-panvas-border-subtle'
              }`}
            >
              <span>{settings.pressureSensitivity ? 'Enabled' : 'Disabled'}</span>
              <div className={`w-8 h-4 rounded-full transition-colors ${settings.pressureSensitivity ? 'bg-blue-500' : 'bg-panvas-border-strong'}`}>
                <div className={`h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform mt-[1px] ${settings.pressureSensitivity ? 'translate-x-[17px]' : 'translate-x-[1px]'}`} />
              </div>
            </button>
          </div>

          {/* Pressure Curve Preview */}
          <div className="rounded-lg bg-panvas-bg-secondary p-2.5 border border-panvas-border-subtle">
            <div className="text-2xs text-panvas-text-tertiary mb-1">Test Area</div>
            <svg className="w-full h-10" viewBox="0 0 180 40" fill="none">
              <path
                d="M8 32C40 28 60 8 90 12S140 30 172 10"
                stroke={settings.color}
                strokeWidth={settings.pressureSensitivity ? '2' : String(Math.min(settings.thickness, 4))}
                strokeLinecap="round"
                opacity={settings.opacity / 100}
              />
            </svg>
          </div>

          {(toolName === 'pen' || toolName === 'pencil') && (
            <button
              type="button"
              onClick={onOpenGestures}
              className="flex w-full items-center justify-between rounded-lg border border-panvas-border-strong bg-panvas-bg-secondary px-3 py-2.5 text-left text-xs text-panvas-text-primary transition-colors hover:bg-panvas-bg-hover focus-ring"
              aria-label="Open ink gesture settings"
            >
              <span className="flex items-center gap-2 font-medium"><Spline size={16} strokeWidth={1.8} className="text-panvas-text-secondary" aria-hidden="true" />Ink gestures</span>
              <span className="text-2xs text-panvas-text-tertiary">Scribble, select &amp; shapes</span>
            </button>
          )}

          {/* Legacy duplicated in-panel gesture controls were replaced by the shared GestureSettingsPopup. */}
          {/* <details className="group rounded-lg border border-panvas-border-subtle bg-panvas-bg-secondary/45">
            <summary className="cursor-pointer list-none px-3 py-2 text-2xs font-semibold uppercase tracking-widest text-panvas-text-secondary marker:hidden focus-ring">
              <span className="flex items-center justify-between">Ink gestures <span className="text-panvas-text-tertiary transition-transform group-open:rotate-45">+</span></span>
            </summary>
            <div className="border-t border-panvas-border-subtle p-2.5">
            {(toolName === 'pen' || toolName === 'pencil') && (
              <>
                <button
                  type="button"
                  aria-pressed={scribbleToErase}
                  onClick={() => onScribbleToEraseChange(!scribbleToErase)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    scribbleToErase
                      ? 'border-blue-500/30 bg-blue-500/10 text-blue-500'
                      : 'border-panvas-border-subtle bg-panvas-bg-secondary text-panvas-text-secondary'
                  }`}
                >
                  <span className="flex items-center justify-between text-xs font-medium">
                    Scribble to erase
                    <span>{scribbleToErase ? 'On' : 'Off'}</span>
                  </span>
                  <span className="mt-1 block text-2xs leading-4 text-panvas-text-tertiary">
                    Scratch repeatedly across existing ink to remove it.
                  </span>
                </button>
                <button
                  type="button"
                  aria-pressed={circleToSelect}
                  onClick={() => onCircleToSelectChange(!circleToSelect)}
                  className={`mt-2 w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    circleToSelect
                      ? 'border-blue-500/30 bg-blue-500/10 text-blue-500'
                      : 'border-panvas-border-subtle bg-panvas-bg-secondary text-panvas-text-secondary'
                  }`}
                >
                  <span className="flex items-center justify-between text-xs font-medium">
                    Circle to select
                    <span>{circleToSelect ? 'On' : 'Off'}</span>
                  </span>
                  <span className="mt-1 block text-2xs leading-4 text-panvas-text-tertiary">
                    Draw a closed loop around objects, then move or resize them.
                  </span>
                </button>
              </>
            )}
            <button
                type="button"
                aria-pressed={straightLineRecognition}
                onClick={() => onStraightLineRecognitionChange(!straightLineRecognition)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                  toolName === 'pen' || toolName === 'pencil' ? 'mt-2 ' : ''
                }${
                  straightLineRecognition
                    ? 'border-blue-500/30 bg-blue-500/10 text-blue-500'
                    : 'border-panvas-border-subtle bg-panvas-bg-secondary text-panvas-text-secondary'
                }`}
              >
                <span className="flex items-center justify-between text-xs font-medium">
                  Straight-line recognition
                  <span>{straightLineRecognition ? 'On' : 'Off'}</span>
                </span>
                <span className="mt-1 block text-2xs leading-4 text-panvas-text-tertiary">
                  Cleans up only long, genuinely straight strokes.
                </span>
              </button>
            {straightLineRecognition && (
              <button
                  type="button"
                  aria-pressed={snapRecognizedLines}
                  onClick={() => onSnapRecognizedLinesChange(!snapRecognizedLines)}
                  className={`mt-2 w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    snapRecognizedLines
                      ? 'border-blue-500/30 bg-blue-500/10 text-blue-500'
                      : 'border-panvas-border-subtle bg-panvas-bg-secondary text-panvas-text-secondary'
                  }`}
                >
                  <span className="flex items-center justify-between text-xs font-medium">
                    Snap angles
                    <span>{snapRecognizedLines ? 'On' : 'Off'}</span>
                  </span>
                  <span className="mt-1 block text-2xs leading-4 text-panvas-text-tertiary">
                    Snaps near-horizontal, vertical, and 45° lines within 4°.
                  </span>
              </button>
            )}
            {(toolName === 'pen' || toolName === 'pencil') && (
              <>
                <button
                  type="button"
                  aria-pressed={roughShapeRecognition}
                  onClick={() => onRoughShapeRecognitionChange(!roughShapeRecognition)}
                  className={`mt-2 w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    roughShapeRecognition
                      ? 'border-blue-500/30 bg-blue-500/10 text-blue-500'
                      : 'border-panvas-border-subtle bg-panvas-bg-secondary text-panvas-text-secondary'
                  }`}
                >
                  <span className="flex items-center justify-between text-xs font-medium">
                    Shape recognition
                    <span>{roughShapeRecognition ? 'On' : 'Off'}</span>
                  </span>
                  <span className="mt-1 block text-2xs leading-4 text-panvas-text-tertiary">
                    Converts only deliberate closed circles, ellipses, and rectangles.
                  </span>
                </button>
                {roughShapeRecognition && (
                  <button
                    type="button"
                    aria-pressed={snapRecognizedShapes}
                    onClick={() => onSnapRecognizedShapesChange(!snapRecognizedShapes)}
                    className={`mt-2 w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      snapRecognizedShapes
                        ? 'border-blue-500/30 bg-blue-500/10 text-blue-500'
                        : 'border-panvas-border-subtle bg-panvas-bg-secondary text-panvas-text-secondary'
                    }`}
                  >
                    <span className="flex items-center justify-between text-xs font-medium">
                      Snap circles &amp; squares
                      <span>{snapRecognizedShapes ? 'On' : 'Off'}</span>
                    </span>
                    <span className="mt-1 block text-2xs leading-4 text-panvas-text-tertiary">
                      Equalizes near-square shapes while preserving clear ellipses and rectangles.
                    </span>
                  </button>
                )}
              </>
            )}
            </div>
          </details> */}
        </div>
      </div>
    </section>
  );
}

function ColorPaletteControl({ label, color, onColor }: {
  label: string;
  color: string;
  onColor: (color: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-2xs font-semibold uppercase tracking-widest text-panvas-text-secondary">Colors</div>
        <input
          aria-label={`${label} custom color`}
          type="color"
          value={color}
          onChange={event => onColor(event.target.value)}
          className="h-6 w-6 cursor-pointer rounded border-0 p-0"
        />
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {DEFAULT_COLORS.map(preset => (
          <button
            key={preset}
            type="button"
            onClick={() => onColor(preset)}
            className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 focus-ring ${
              color.toLowerCase() === preset.toLowerCase()
                ? 'scale-110 border-blue-500 ring-2 ring-blue-500/30'
                : 'border-panvas-border-strong hover:border-panvas-text-primary'
            }`}
            style={{ backgroundColor: preset }}
            title={`${label} color ${preset}`}
            aria-label={`${label} color ${preset}`}
          />
        ))}
      </div>
    </div>
  );
}

function ColorPaletteDialog({ label, color, onColor, onClose }: {
  label: string;
  color: string;
  onColor: (color: string) => void;
  onClose: () => void;
}) {
  return (
    <section role="dialog" aria-label={`${label} palette`} className="w-52 rounded-2xl border border-panvas-border-strong bg-panvas-bg-primary text-panvas-text-primary shadow-2xl">
      <div className="flex items-center justify-between border-b border-panvas-border-subtle px-4 py-3">
        <span className="text-sm font-semibold">{label} colors</span>
        <button type="button" onClick={onClose} className="text-panvas-text-secondary transition-colors hover:text-panvas-text-primary focus-ring" aria-label={`Close ${label} palette`}>
          <X size={14} />
        </button>
      </div>
      <div className="p-4">
        <ColorPaletteControl label={label} color={color} onColor={onColor} />
      </div>
    </section>
  );
}

function GestureSettingsPopup({
  scribbleToErase,
  circleToSelect,
  straightLineRecognition,
  snapRecognizedLines,
  roughShapeRecognition,
  snapRecognizedShapes,
  onScribbleToEraseChange,
  onCircleToSelectChange,
  onStraightLineRecognitionChange,
  onSnapRecognizedLinesChange,
  onRoughShapeRecognitionChange,
  onSnapRecognizedShapesChange,
  onClose,
}: {
  scribbleToErase: boolean;
  circleToSelect: boolean;
  straightLineRecognition: boolean;
  snapRecognizedLines: boolean;
  roughShapeRecognition: boolean;
  snapRecognizedShapes: boolean;
  onScribbleToEraseChange: (enabled: boolean) => void;
  onCircleToSelectChange: (enabled: boolean) => void;
  onStraightLineRecognitionChange: (enabled: boolean) => void;
  onSnapRecognizedLinesChange: (enabled: boolean) => void;
  onRoughShapeRecognitionChange: (enabled: boolean) => void;
  onSnapRecognizedShapesChange: (enabled: boolean) => void;
  onClose: () => void;
}) {
  return (
    <section role="dialog" aria-label="Ink Gestures" className="w-[min(20rem,calc(100vw-1.5rem))] max-h-[min(30rem,calc(100vh-1.5rem))] overflow-y-auto rounded-2xl border border-panvas-border-strong bg-panvas-bg-primary text-panvas-text-primary shadow-2xl">
      <div className="flex items-center justify-between border-b border-panvas-border-subtle bg-panvas-bg-secondary/50 px-4 py-3">
        <div className="flex items-center gap-2.5"><span className="grid h-8 w-8 place-items-center rounded-lg border border-panvas-border-subtle bg-panvas-bg-primary"><Spline size={17} strokeWidth={1.8} aria-hidden="true" /></span><div><h2 className="text-sm font-semibold">Ink Gestures</h2><p className="mt-0.5 text-2xs text-panvas-text-tertiary">Optional recognition and ink shortcuts</p></div></div>
        <button type="button" onClick={onClose} className="panvas-icon-control focus-ring" aria-label="Close Ink Gestures"><X size={14} /></button>
      </div>
      <div className="space-y-2 p-3">
        <GestureToggle icon={<Eraser size={15} />} label="Scribble to erase" enabled={scribbleToErase} onChange={onScribbleToEraseChange} />
        <GestureToggle icon={<LassoSelect size={15} />} label="Circle to select" enabled={circleToSelect} onChange={onCircleToSelectChange} />
        <GestureToggle icon={<Minus size={16} />} label="Straight-line recognition" enabled={straightLineRecognition} onChange={onStraightLineRecognitionChange} />
        <GestureToggle icon={<ScanLine size={15} />} label="Snap line angles" enabled={snapRecognizedLines} onChange={onSnapRecognizedLinesChange} disabled={!straightLineRecognition} />
        <GestureToggle icon={<Shapes size={15} />} label="Draw to shape" enabled={roughShapeRecognition} onChange={onRoughShapeRecognitionChange} />
        <GestureToggle icon={<CircleDot size={15} />} label="Snap circles and squares" enabled={snapRecognizedShapes} onChange={onSnapRecognizedShapesChange} disabled={!roughShapeRecognition} />
      </div>
    </section>
  );
}

function GestureToggle({ icon, label, enabled, disabled = false, onChange }: { icon: React.ReactNode; label: string; enabled: boolean; disabled?: boolean; onChange: (enabled: boolean) => void }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={enabled} disabled={disabled} onClick={() => onChange(!enabled)} className="flex w-full items-center justify-between rounded-xl border border-panvas-border-subtle bg-panvas-bg-secondary px-3 py-2.5 text-left text-xs text-panvas-text-primary transition-colors hover:bg-panvas-bg-hover disabled:cursor-not-allowed disabled:opacity-50 focus-ring"><span className="flex items-center gap-2.5 font-medium"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-panvas-border-subtle bg-panvas-bg-primary text-panvas-text-secondary">{icon}</span>{label}</span><span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${enabled ? 'bg-panvas-accent-blue' : 'bg-panvas-border-default'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} /></span></button>;
}

function EraserPopup({ settings, onUpdate, onClose }: {
  settings: EraserSettings;
  onUpdate: (key: keyof EraserSettings | 'mode', value: any) => void;
  onClose: () => void;
}) {
  return (
    <div className="w-[260px] rounded-2xl bg-panvas-bg-primary border border-panvas-border-strong shadow-2xl backdrop-blur-xl overflow-hidden text-panvas-text-primary">
      <div className="flex items-center justify-between px-4 py-3 border-b border-panvas-border-subtle bg-panvas-bg-secondary/50">
        <span className="text-sm font-semibold">Eraser Settings</span>
        <button type="button" onClick={onClose} className="text-panvas-text-secondary hover:text-panvas-text-primary transition-colors" aria-label="Close Eraser settings" title="Close Eraser settings">
          <X size={14} />
        </button>
      </div>
      <div className="p-4 space-y-4">
        {/* Erase Mode */}
        <div>
          <div className="text-xs mb-1.5 text-panvas-text-secondary">Mode</div>
          <div className="grid grid-cols-3 rounded-md border border-panvas-border-subtle bg-panvas-bg-secondary p-1">
            <button
              type="button"
              onClick={() => onUpdate('mode', 'pixel')}
              aria-pressed={settings.mode === 'pixel'}
              className={`rounded px-1 py-1 text-2xs transition-colors ${settings.mode === 'pixel' ? 'bg-panvas-bg-primary shadow text-panvas-text-primary font-medium' : 'text-panvas-text-secondary'}`}
            >
              Pixel
            </button>
            <button
              type="button"
              onClick={() => onUpdate('mode', 'stroke')}
              aria-pressed={settings.mode === 'stroke'}
              className={`rounded px-1 py-1 text-2xs transition-colors ${settings.mode === 'stroke' ? 'bg-panvas-bg-primary shadow text-panvas-text-primary font-medium' : 'text-panvas-text-secondary'}`}
            >
              Stroke
            </button>
            <button
              type="button"
              onClick={() => onUpdate('mode', 'highlighter')}
              aria-pressed={settings.mode === 'highlighter'}
              className={`rounded px-1 py-1 text-2xs transition-colors ${settings.mode === 'highlighter' ? 'bg-panvas-bg-primary shadow text-panvas-text-primary font-medium' : 'text-panvas-text-secondary'}`}
              title="Erase highlighter strokes without affecting ink or shapes"
            >
              Highlighter
            </button>
          </div>
          {settings.mode === 'highlighter' && (
            <p className="mt-2 text-2xs leading-4 text-panvas-text-tertiary">
              Removes only highlighter strokes beneath the eraser.
            </p>
          )}
        </div>

        <div>
          <div className="flex justify-between text-xs mb-1.5">
            <span className="text-panvas-text-secondary">Size</span>
            <span className="text-panvas-text-tertiary">{settings.thickness.toFixed(1)} mm</span>
          </div>
          <input
            type="range" min="2" max="50" step="0.5"
            value={settings.thickness}
            onChange={e => onUpdate('thickness', parseFloat(e.target.value))}
            className="w-full h-1.5 rounded-full bg-panvas-border-default appearance-none cursor-pointer accent-blue-500"
          />
        </div>
        <div className="rounded-lg bg-panvas-bg-secondary border border-panvas-border-subtle p-3 flex items-center justify-center">
          <div 
            className="rounded-full border-2 border-panvas-border-strong bg-panvas-bg-primary"
            style={{ width: Math.min(settings.thickness * 3, 80), height: Math.min(settings.thickness * 3, 80) }}
          />
        </div>
      </div>
    </div>
  );
}

function ShapePopup({ lineStyle, onLineStyle, activeShape, color, thickness, opacity, fillEnabled, onShape, onColor, onThickness, onOpacity, onFill, onRotate, onClose }: {
  lineStyle: LineStyle;
  onLineStyle: (style: LineStyle) => void;
  activeShape: ShapeType;
  color: string;
  thickness: number;
  opacity: number;
  fillEnabled: boolean;
  onShape: (shape: ShapeType) => void;
  onColor: (value: string) => void;
  onThickness: (value: number) => void;
  onOpacity: (value: number) => void;
  onFill: (enabled: boolean) => void;
  onRotate: (degrees: number) => void;
  onClose: () => void;
}) {
  const shapes: Array<{ id: ShapeType; label: string }> = [
    { id: 'rectangle', label: 'Rectangle' }, { id: 'rounded-rectangle', label: 'Rounded' },
    { id: 'ellipse', label: 'Ellipse' }, { id: 'triangle', label: 'Triangle' },
    { id: 'diamond', label: 'Diamond' }, { id: 'line', label: 'Line' }, { id: 'arrow', label: 'Arrow' },
  ];
  return (
    <div className="w-[300px] rounded-2xl border border-panvas-border-strong bg-panvas-bg-primary text-panvas-text-primary shadow-2xl">
      <div className="flex items-center justify-between border-b border-panvas-border-subtle px-4 py-3">
        <span className="text-sm font-semibold">Shape settings</span>
        <button type="button" onClick={onClose} className="text-panvas-text-secondary hover:text-panvas-text-primary" aria-label="Close shape settings" title="Close shape settings"><X size={14} /></button>
      </div>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-4 gap-1">
          {shapes.map(shape => <button key={shape.id} type="button" onClick={() => onShape(shape.id)} className={`rounded-md px-2 py-1.5 text-2xs focus-ring ${activeShape === shape.id ? 'bg-panvas-accent-blue/15 text-panvas-accent-blue ring-1 ring-panvas-accent-blue/40' : 'bg-panvas-bg-secondary text-panvas-text-secondary hover:bg-panvas-bg-hover'}`}>{shape.label}</button>)}
        </div>
        {(activeShape === 'line' || activeShape === 'arrow') && <div className="grid grid-cols-3 gap-1" role="group" aria-label="Line style">
          {LINE_STYLES.map(style => <button key={style} type="button" aria-pressed={lineStyle === style} onClick={() => onLineStyle(style)} className={`rounded-md border p-1.5 text-2xs capitalize focus-ring ${lineStyle === style ? 'border-panvas-accent-blue bg-panvas-bg-active' : 'border-panvas-border-subtle hover:bg-panvas-bg-hover'}`}>
            <svg viewBox="0 0 80 24" className="h-6 w-full" aria-hidden="true">{(() => { const g = buildLineStyleGeometry({ id: 'preview', type: 'shape', createdAt: 0, shapeType: 'line', x: 5, y: 12, width: 70, height: 0, rotation: 0, strokeWidth: 1.5, color, fill: null, lineStyle: style }); return <g stroke="currentColor" strokeWidth="1.5" fill="none">{g.paths.map((path, i) => <polyline key={i} points={path.map(p => `${p.x},${p.y}`).join(' ')} />)}{g.dots.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={g.radius} fill="currentColor" />)}</g>; })()}</svg>{style}
          </button>)}
        </div>}
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-3 text-xs">
          <span className="text-panvas-text-secondary">Stroke</span>
          <div className="flex items-center gap-2"><input type="color" value={color} onChange={event => onColor(event.target.value)} className="h-7 w-9 rounded border-0 bg-transparent" /><input aria-label="Shape stroke width" type="range" min="1" max="16" step="1" value={thickness} onChange={event => onThickness(Number(event.target.value))} className="min-w-0 flex-1 accent-blue-500" /></div>
          <span className="text-panvas-text-secondary">Opacity</span>
          <input aria-label="Shape opacity" type="range" min="10" max="100" step="5" value={Math.round(opacity * 100)} onChange={event => onOpacity(Number(event.target.value) / 100)} className="w-full accent-blue-500" />
          <span className="text-panvas-text-secondary">Fill</span>
          <button type="button" onClick={() => onFill(!fillEnabled)} className={`rounded-md px-2 py-1.5 text-xs focus-ring ${fillEnabled ? 'bg-panvas-accent-blue/15 text-panvas-accent-blue' : 'bg-panvas-bg-secondary text-panvas-text-secondary'}`}>{fillEnabled ? 'Filled' : 'Outline'}</button>
          <span className="text-panvas-text-secondary">Rotate</span>
          <div className="flex gap-2"><button type="button" onClick={() => onRotate(-15)} className="flex-1 rounded-md bg-panvas-bg-secondary px-2 py-1.5 hover:bg-panvas-bg-hover">−15°</button><button type="button" onClick={() => onRotate(15)} className="flex-1 rounded-md bg-panvas-bg-secondary px-2 py-1.5 hover:bg-panvas-bg-hover">+15°</button></div>
        </div>
        <p className="text-2xs text-panvas-text-tertiary">Hold Shift while drawing to constrain proportions or snap lines to 15°.</p>
      </div>
    </div>
  );
}

const HANDWRITING_LANGUAGES = SUPPORTED_HANDWRITING_RECOGNITION_LANGUAGES;

function HandwritingSettingsStrip({ settings, onChange, onPalette }: {
  settings: HandwritingToolPreferences;
  onChange: (updates: Partial<HandwritingToolPreferences>) => void;
  onPalette: () => void;
}) {
  const isMobileViewport = useIsMobileViewport();
  const [isTextSettingsOpen, setIsTextSettingsOpen] = useState(false);
  const textSettingsAnchorRef = useRef<HTMLButtonElement>(null);

  const presetControls = (
    <WritingPresetControls
      label="Handwriting"
      settings={settings}
      recentColors={settings.recentColors}
      thicknesses={HANDWRITING_THICKNESS_PRESETS}
      onColor={color => onChange({ color })}
      onThickness={thickness => onChange({ thickness })}
      onPalette={onPalette}
    />
  );

  const fontSelect = <TextFontPicker
    ariaLabel="Output font"
    value={settings.fontFamily}
    onChange={font => onChange({ fontFamily: (font || 'Inter, sans-serif') as HandwritingToolPreferences['fontFamily'] })}
    className={isMobileViewport ? 'w-full' : 'w-40'}
  />;

  const sizeSelect = (
    <select
      aria-label="Output text size"
      title="Output text size"
      value={String(settings.fontSize)}
      onChange={event => onChange({ fontSize: event.target.value === 'auto' ? 'auto' : Number(event.target.value) })}
      className={`h-7 rounded-md border border-panvas-border-default bg-panvas-bg-primary px-1.5 text-2xs text-panvas-text-primary focus-ring ${isMobileViewport ? 'w-full' : 'w-20'}`}
    >
      <option value="auto">Size: Auto</option>
      {[12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map(size => <option key={size} value={size}>{size}px</option>)}
    </select>
  );

  const languageSelect = (
    <select
      aria-label="Recognition language"
      title="Recognition language"
      value={settings.language || HANDWRITING_LANGUAGES[0].value}
      onChange={event => onChange({ language: event.target.value })}
      className={`h-7 rounded-md border border-panvas-border-default bg-panvas-bg-primary px-1.5 text-2xs text-panvas-text-primary focus-ring ${isMobileViewport ? 'w-full' : 'max-w-36'}`}
    >
      {HANDWRITING_LANGUAGES.map(language => <option key={language.value || 'system'} value={language.value}>{language.label}</option>)}
    </select>
  );

  // On phones the font/size/language controls cannot share the strip with
  // the color and thickness controls without scrolling the important ones
  // off-screen. Colors, palette, and thickness lead; text output settings
  // collapse into a compact anchored popover.
  if (isMobileViewport) {
    return (
      <div className="panvas-floating-surface flex h-9 max-w-[calc(100vw-1rem)] items-center gap-0.5 px-1.5" aria-label="Handwriting to Text settings">
        {presetControls}
        <Divider />
        <button
          ref={textSettingsAnchorRef}
          type="button"
          onMouseDown={event => event.preventDefault()}
          onClick={() => setIsTextSettingsOpen(open => !open)}
          aria-expanded={isTextSettingsOpen}
          aria-haspopup="dialog"
          className={`flex h-7 w-7 items-center justify-center rounded-md focus-ring ${isTextSettingsOpen ? 'bg-panvas-bg-hover text-panvas-text-primary' : 'text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary'}`}
          title="Text output settings"
        >
          <Type size={15} />
        </button>
        <OverlayManager isOpen={isTextSettingsOpen} onClose={() => setIsTextSettingsOpen(false)} anchorRef={textSettingsAnchorRef} placement="bottom-end">
          <div
            role="dialog"
            aria-label="Text output settings"
            className="flex max-h-[60vh] w-[min(16rem,calc(100vw-1.5rem))] flex-col gap-2 overflow-y-auto rounded-xl border border-panvas-border-strong bg-panvas-bg-primary p-2 text-panvas-text-primary shadow-2xl"
          >
            {fontSelect}
            {sizeSelect}
            {languageSelect}
          </div>
        </OverlayManager>
      </div>
    );
  }

  return (
    <div className="panvas-floating-surface flex h-10 max-w-[calc(100vw-1rem)] items-center gap-1 overflow-x-auto px-2" aria-label="Handwriting to Text settings">
      {fontSelect}
      <Divider />
      {sizeSelect}
      <Divider />
      {presetControls}
      <Divider />
      {languageSelect}
    </div>
  );
}

function WritingPresetStrip({
  tool,
  settings,
  recentColors,
  onColor,
  onThickness,
  onPalette,
}: {
  tool: DrawingTool;
  settings: ToolSettings;
  recentColors: readonly string[];
  onColor: (value: string) => void;
  onThickness: (value: number) => void;
  onPalette: () => void;
}) {
  return (
    <div
      className="panvas-floating-surface flex h-10 shrink-0 items-center gap-1 px-2 max-[599px]:h-9 max-[599px]:gap-0.5 max-[599px]:px-1.5"
      aria-label={`${ACTIVE_TOOL_LABELS[tool]} quick presets`}
    >
      <WritingPresetControls
        label={ACTIVE_TOOL_LABELS[tool]}
        settings={settings}
        recentColors={recentColors}
        thicknesses={QUICK_THICKNESS_PRESETS[tool]}
        onColor={onColor}
        onThickness={onThickness}
        onPalette={onPalette}
      />
    </div>
  );
}

function WritingPresetControls({
  label,
  settings,
  recentColors,
  thicknesses,
  onColor,
  onThickness,
  onPalette,
}: {
  label: string;
  settings: Pick<ToolSettings, 'color' | 'thickness'>;
  recentColors: readonly string[];
  thicknesses: readonly number[];
  onColor: (value: string) => void;
  onThickness: (value: number) => void;
  onPalette: () => void;
}) {
  return (
    <>
      <div className="flex shrink-0 items-center gap-1" role="group" aria-label={`${label} colors`}>
        {recentColors.slice(0, 5).map(color => (
          <button
            key={color}
            type="button"
            onMouseDown={event => event.preventDefault()}
            onClick={() => onColor(color)}
            className={`h-4 w-4 rounded-full border border-panvas-border-strong transition-transform hover:scale-110 focus-ring ${settings.color.toLowerCase() === color.toLowerCase() ? 'ring-2 ring-panvas-accent-blue ring-offset-1 ring-offset-panvas-bg-primary' : ''}`}
            style={{ backgroundColor: color }}
            title={`${label} color ${color}`}
            aria-label={`${label} color ${color}`}
          />
        ))}
        <button
          type="button"
          onMouseDown={event => event.preventDefault()}
          onClick={onPalette}
          className="flex h-7 w-7 items-center justify-center rounded-md text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary focus-ring"
          title={`Open ${label} palette`}
          aria-label={`Open ${label} palette`}
        >
          <Palette size={15} />
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={`${label} thickness`}>
        {thicknesses.map(thickness => (
          <button
            key={thickness}
            type="button"
            onMouseDown={event => event.preventDefault()}
            onClick={() => onThickness(thickness)}
            className={`flex h-7 w-6 items-center justify-center rounded-md text-panvas-text-secondary transition-colors hover:bg-panvas-bg-hover focus-ring ${Math.abs(settings.thickness - thickness) < 0.01 ? 'bg-panvas-bg-hover text-panvas-text-primary' : ''}`}
            title={`${label} thickness ${thickness}`}
            aria-label={`${label} thickness ${thickness}`}
          >
            <span className="rounded-full bg-current" style={{ width: Math.min(14, Math.max(3, thickness * 2)), height: Math.min(8, Math.max(2, thickness)) }} />
          </button>
        ))}
      </div>
    </>
  );
}

function ToolButton({ icon, active, onClick, tooltip, hasPopup }: { icon: React.ReactNode; active: boolean; onClick: () => void; tooltip: string; hasPopup?: boolean }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      aria-pressed={active}
      className={`relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl p-2 transition-all duration-150 focus-ring max-[599px]:h-9 max-[599px]:w-9 max-[599px]:rounded-lg max-[599px]:p-1.5 ${
        active 
          ? 'bg-panvas-accent-blue/10 text-panvas-accent-blue font-bold shadow-sm ring-1 ring-panvas-accent-blue/50'
          : 'text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary active:scale-95'
      }`}
    >
      <div className="pointer-events-none flex items-center justify-center w-full h-full">
        {icon}
      </div>
      {hasPopup && active && (
        <span className="absolute -bottom-0.5 left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full bg-panvas-accent-blue" />
      )}
    </button>
  );
}

function Divider() {
  return <div className="w-[1px] h-5 bg-panvas-border-subtle mx-1 flex-shrink-0 max-[599px]:h-4 max-[599px]:mx-0.5" />;
}

function NibPreview({ family, color, thickness = 3, pattern = 'solid', opacity = 1, pressure = true }: { family?: InkFamily; color: string; thickness?: number; pattern?: StrokePattern; opacity?: number; pressure?: boolean }) {
  const points = Array.from({ length: 65 }, (_, i) => ({ x: 5 + i * 190 / 64, y: 20 - 10 * Math.sin(i / 64 * Math.PI * 3), pressure: pressure ? 0.2 + 0.65 * Math.sin(i / 64 * Math.PI) : 0.5, t: i }));
  return <svg className="h-8 w-full" viewBox="0 0 200 40" aria-hidden="true">
    {family ? <path d={inkPolygonsPath(buildInkFamilyGeometry({ id: 'preview', type: 'stroke', createdAt: 0, tool: 'pen', points, color, thickness, opacity, inkFamily: family, pattern }))} fill={color} opacity={opacity} /> : <path d="M5 20Q35 0 65 20T130 20T195 20" fill="none" stroke={color} strokeWidth={thickness} strokeLinecap="round" />}
  </svg>;
}
