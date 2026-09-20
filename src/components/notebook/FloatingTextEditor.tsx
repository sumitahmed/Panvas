import { StaticTextPreview } from './StaticTextPreview';
import { stickyPaperStyle } from './stickyNotes';
import { textObjectStyle } from './textTypography';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { GripHorizontal, Palette, RotateCw, Shapes, X } from 'lucide-react';
import { SlashMenuExtension } from './SlashMenuExtension';
import slashSuggestion from './slashSuggestion';
import { notebookTipTapExtensions } from './tiptapExtensions';
import type { TextObject } from './engine/drawingTypes';
import type { NotebookEngine } from './engine/NotebookEngine';
import type { PdfPageRotation } from '@/types/notebook';
import { sourceRectToVisual, visualDeltaToSource, type PdfPageDimensions } from './engine/pdfCoordinates.ts';
import {
  getStickyNoteColor,
  getStickyNoteOpacity,
  getStickyNoteShape,
  getShapeBorderRadius,
  hexToRgba,
  isStickyNote,
  isLegacyStickyPlaceholderContent,
  STICKY_NOTE_COLORS,
  STICKY_NOTE_SHAPES,
  STICKY_NOTE_MIN_HEIGHT,
  type StickyNoteShape,
} from './stickyNotes';
import { gate0Profiler } from '@/dev/gate0Profiler';

interface FloatingTextEditorProps {
  object: TextObject;
  engine: NotebookEngine;
  scale: number;
  toolMode: string;
  onFocus: (editor: Editor) => void;
  onBlur: () => void;
  zIndex?: number;
  pageOffset?: { x: number; y: number };
  /** Optional PDF placement contract. Text coordinates remain source-page coordinates. */
  pdfPlacement?: {
    rotation: PdfPageRotation;
    sourceDimensions: PdfPageDimensions;
    sourceOffset?: { x: number; y: number };
  };
}

function textHistoryVisualSignature(object: TextObject, fallbackHeight: number): string {
  return [
    object.x, object.y, object.width, object.height || fallbackHeight, object.rotation ?? 0,
    getStickyNoteColor(object), getStickyNoteOpacity(object), getStickyNoteShape(object),
  ].join('|');
}

const FloatingTextEditorComponent: React.FC<FloatingTextEditorProps> = ({
  object,
  engine,
  scale,
  toolMode,
  onFocus,
  onBlur,
  pdfPlacement,
  zIndex,
  pageOffset,
}) => {
  gate0Profiler.resource('reactRenders.FloatingTextEditor', 1);
  useEffect(() => {
    gate0Profiler.resource('tipTapEditors', 1);
    return () => gate0Profiler.resource('tipTapEditors', -1);
  }, []);
  const isSelected = engine.selection.getSelectedElements().some(el => el.id === object.id);
  const stickyNote = isStickyNote(object);
  const [stickyStylePanel, setStickyStylePanel] = useState<'color' | 'shape' | null>(null);
  const textWidth = Math.max(stickyNote ? 140 : 160, object.width ?? 0);
  const textMinHeight = stickyNote ? 100 : 72;
  const containerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gestureCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => gestureCleanup.current?.(), []);

  const [pos, setPos] = useState<{ x: number; y: number }>({ x: object.x, y: object.y });
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: textWidth,
    height: object.height || textMinHeight,
  });

  // Sync state if object props change externally
  useEffect(() => {
    setPos({ x: object.x, y: object.y });
  }, [object.x, object.y]);

  useEffect(() => {
    setSize({
      width: Math.max(stickyNote ? 140 : 160, object.width ?? 0),
      height: object.height || textMinHeight,
    });
  }, [object.width, object.height, stickyNote, textMinHeight]);

  const editor = useEditor({
    extensions: [
      ...notebookTipTapExtensions,
      Placeholder.configure({
        placeholder: stickyNote ? 'Take a note...' : 'Type something...',
        emptyEditorClass: 'is-editor-empty',
        showOnlyWhenEditable: false,
      }),
      SlashMenuExtension.configure({ suggestion: slashSuggestion }),
    ],
    content: stickyNote && isLegacyStickyPlaceholderContent(object.content)
      ? { type: 'doc', content: [{ type: 'paragraph', content: [] }] }
      : object.content,
    onUpdate: ({ editor }) => {
      const json = editor.getJSON();
      object.content = json;
      engine.texts.updateTextContent(object.id, editor.getJSON());
      engine.input.notifyChange();
    },
    onFocus: ({ editor: currentEditor }) => {
      engine.texts.setActiveTextId(object.id);
      onFocus(currentEditor);
    },
    onSelectionUpdate: ({ editor: currentEditor }) => {
      engine.texts.setActiveTextId(object.id);
      onFocus(currentEditor);
    },
    onBlur: ({ editor: currentEditor }) => {
      onBlur();
      // Remove empty text boxes automatically to prevent ghost placeholders (only non-sticky notes)
      if (!stickyNote && currentEditor.getText().trim() === '') {
        setTimeout(() => {
          engine.history.push({
            description: 'Remove empty text box',
            execute: () => {
              engine.texts.removeText(object.id);
              engine.selection.clearSelection();
              engine.input.notifyChange();
            },
            undo: () => {},
          });
        }, 0);
      }
    },
  });

  useEffect(() => {
    if (editor) {
      engine.texts.registerEditor(object.id, editor);
      return () => {
        engine.texts.unregisterEditor(object.id);
      };
    }
  }, [editor, engine, object.id]);

  // Listen for the custom event to focus this editor
  useEffect(() => {
    const handleFocus = (e: CustomEvent<{ id?: string }>) => {
      if (e.detail?.id === object.id && editor) {
        editor.commands.focus('end');
      }
    };
    document.addEventListener('panvas:focus-text' as any, handleFocus as any);
    return () => document.removeEventListener('panvas:focus-text' as any, handleFocus as any);
  }, [object.id, editor]);

  // Sync actual content height back to the engine so selection engine draws correct bounds
  useEffect(() => {
    const el = containerRef.current;
    // Sticky bounds belong to the resize gesture, not the paragraph's intrinsic height.
    if (!el || stickyNote) return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) {
        const measuredHeight = Math.ceil(entries[0].contentRect.height);
        // Keep a stable editing floor so the first keystroke cannot collapse a
        // newly-created box to a tiny line and then jump as TipTap lays out.
        const nextHeight = Math.max(textMinHeight, measuredHeight);
        if (Math.abs((object.height ?? 0) - nextHeight) < 1) return;
        // The current DOM content is the source of truth. Keep only a stable
        // usable editor floor; never retain a previous, larger object height.
        object.height = nextHeight;
        engine.texts.updateTextBounds(object.id, size.width, nextHeight);
        engine.drawing.redraw();
        setSize(prev => ({ ...prev, height: nextHeight }));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [engine, object.height, object.id, textMinHeight, size.width, stickyNote]);

  const isHandTool = toolMode === 'hand';
  const isTextTool = toolMode === 'text';

  // Editing is owned by Text mode. Blur synchronously with the rendered tool state so a
  // TipTap editor cannot keep consuming input after Select, Hand, or another tool is chosen.
  // This MUST stay above the `if (!editor) return null` guard further down. It previously
  // sat below it, making it a conditional hook: any render where `editor` was null changed
  // the hook count and React threw "Rendered fewer hooks than during the previous render",
  // tearing down the page subtree. StrictMode and HMR both re-init the editor and arm it.
  // Blur when not in text mode
  useEffect(() => {
    editor?.setEditable(isTextTool && engine.texts.isEditable(object));
    if (!isTextTool && editor && editor.isFocused) {
      editor.commands.blur();
    }
  }, [isTextTool, editor, engine, object]);

  // A newly-created editor is mounted after InputManager's pointer event has completed, so a
  // one-shot document event dispatched during creation can be missed. Selection plus Text
  // mode is durable state; focus from that state after the editor exists.
  useEffect(() => {
    if (!editor || !isTextTool || !isSelected || editor.isFocused) return;
    const frame = requestAnimationFrame(() => {
      if (!editor.isDestroyed) {
        editor.commands.focus('end');
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, isTextTool, isSelected]);

  // Drag & Move Handler
  const handleDragStart = (e: React.PointerEvent) => {
    if (e.button !== 0 || !engine.texts.isEditable(object) || isHandTool) return;
    e.stopPropagation();
    e.preventDefault();

    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    engine.selection.select(object.id, 'text');

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startX = object.x;
    const startY = object.y;
    const gestureScale = (surfaceRef.current?.getBoundingClientRect().width ?? size.width * scale) / (pdfPlacement ? sourceRectToVisual({ x: 0, y: 0, width: size.width, height: size.height }, pdfPlacement.sourceDimensions, pdfPlacement.rotation).width : size.width);

    const onPointerMove = (moveEv: PointerEvent) => {
      const visualDelta = {
        x: (moveEv.clientX - startClientX) / gestureScale,
        y: (moveEv.clientY - startClientY) / gestureScale,
      };
      const { x: dx, y: dy } = pdfPlacement
        ? visualDeltaToSource(visualDelta, pdfPlacement.rotation)
        : visualDelta;

      const newX = startX + dx;
      const newY = startY + dy;

      object.x = newX;
      object.y = newY;
      engine.texts.updateTextPositionAndBounds(object.id, newX, newY, object.width ?? size.width, object.height ?? size.height);
      engine.drawing.redraw();
      setPos({ x: newX, y: newY });
    };

    const onPointerUp = () => {
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        // capture already released
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      const finalX = object.x;
      const finalY = object.y;

      if (Math.abs(finalX - startX) > 1 || Math.abs(finalY - startY) > 1) {
        engine.history.pushExecuted({
          description: stickyNote ? 'Move sticky note' : 'Move text box',
          execute: () => {
            object.x = finalX;
            object.y = finalY;
            engine.texts.updateTextPositionAndBounds(object.id, finalX, finalY, object.width ?? size.width, object.height ?? size.height);
            engine.drawing.redraw();
            setPos({ x: finalX, y: finalY });
          },
          undo: () => {
            object.x = startX;
            object.y = startY;
            engine.texts.updateTextPositionAndBounds(object.id, startX, startY, object.width ?? size.width, object.height ?? size.height);
            engine.drawing.redraw();
            setPos({ x: startX, y: startY });
          },
        });
        engine.input.notifyChange();
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    gestureCleanup.current = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  };

  // 8-Handle DOM Resize Handler
  const handleResizeStart = (handle: 'tl' | 'tc' | 'tr' | 'ml' | 'mr' | 'bl' | 'bc' | 'br', e: React.PointerEvent) => {
    if (e.button !== 0 || !engine.texts.isEditable(object) || isHandTool) return;
    e.stopPropagation();
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startX = object.x;
    const startY = object.y;
    const startW = size.width;
    const startH = size.height;
    const gestureScale = (surfaceRef.current?.getBoundingClientRect().width ?? size.width * scale) / (pdfPlacement ? sourceRectToVisual({ x: 0, y: 0, width: size.width, height: size.height }, pdfPlacement.sourceDimensions, pdfPlacement.rotation).width : size.width);
    const minW = stickyNote ? 140 : 100;
    const minH = textMinHeight;

    const onPointerMove = (moveEv: PointerEvent) => {
      const visualDelta = {
        x: (moveEv.clientX - startClientX) / gestureScale,
        y: (moveEv.clientY - startClientY) / gestureScale,
      };
      const sourceDelta = pdfPlacement
        ? visualDeltaToSource(visualDelta, pdfPlacement.rotation)
        : visualDelta;
      const objectAngle = -((object.rotation ?? 0) * Math.PI / 180);
      const dx = sourceDelta.x * Math.cos(objectAngle) - sourceDelta.y * Math.sin(objectAngle);
      const dy = sourceDelta.x * Math.sin(objectAngle) + sourceDelta.y * Math.cos(objectAngle);

      let newW = startW;
      let newH = startH;
      let newX = startX;
      let newY = startY;

      switch (handle) {
        case 'mr':
          newW = Math.max(minW, startW + dx);
          break;
        case 'ml':
          newW = Math.max(minW, startW - dx);
          newX = startX + (startW - newW);
          break;
        case 'bc':
          newH = Math.max(minH, startH + dy);
          break;
        case 'tc':
          newH = Math.max(minH, startH - dy);
          newY = startY + (startH - newH);
          break;
        case 'br':
          newW = Math.max(minW, startW + dx);
          newH = Math.max(minH, startH + dy);
          break;
        case 'bl':
          newW = Math.max(minW, startW - dx);
          newH = Math.max(minH, startH + dy);
          newX = startX + (startW - newW);
          break;
        case 'tr':
          newW = Math.max(minW, startW + dx);
          newH = Math.max(minH, startH - dy);
          newY = startY + (startH - newH);
          break;
        case 'tl':
          newW = Math.max(minW, startW - dx);
          newH = Math.max(minH, startH - dy);
          newX = startX + (startW - newW);
          newY = startY + (startH - newH);
          break;
      }

      object.x = newX;
      object.y = newY;
      object.width = newW;
      object.height = newH;

      engine.texts.updateTextPositionAndBounds(object.id, newX, newY, newW, newH);
      engine.drawing.redraw();
      setPos({ x: newX, y: newY });
      setSize({ width: newW, height: newH });
    };

    const onPointerUp = () => {
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        // capture already released
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);

      const finalX = object.x;
      const finalY = object.y;
      const finalW = object.width;
      const finalH = object.height || minH;

      if (Math.abs(finalW - startW) > 1 || Math.abs(finalH - startH) > 1 || Math.abs(finalX - startX) > 1 || Math.abs(finalY - startY) > 1) {
        engine.history.pushExecuted({
          description: 'Resize text box',
          execute: () => {
            object.x = finalX;
            object.y = finalY;
            object.width = finalW;
            object.height = finalH;
            engine.texts.updateTextPositionAndBounds(object.id, finalX, finalY, finalW, finalH);
            engine.drawing.redraw();
            setPos({ x: finalX, y: finalY });
            setSize({ width: finalW, height: finalH });
          },
          undo: () => {
            object.x = startX;
            object.y = startY;
            object.width = startW;
            object.height = startH;
            engine.texts.updateTextPositionAndBounds(object.id, startX, startY, startW, startH);
            engine.drawing.redraw();
            setPos({ x: startX, y: startY });
            setSize({ width: startW, height: startH });
          },
        });
        engine.input.notifyChange();
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    gestureCleanup.current = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  };

  const handleRotateStart = (e: React.PointerEvent) => {
    if (e.button !== 0 || !engine.texts.isEditable(object) || isHandTool) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    engine.selection.select(object.id, 'text');
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const initialRotation = object.rotation ?? 0;
    const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = (Math.atan2(moveEvent.clientY - centerY, moveEvent.clientX - centerX) - startAngle) * 180 / Math.PI;
      object.rotation = ((initialRotation + delta + 360) % 360);
      engine.drawing.redraw();
      setStickyRevision(revision => revision + 1);
    };
    const onPointerUp = () => {
      try { target.releasePointerCapture(e.pointerId); } catch { /* capture already released */ }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      const finalRotation = object.rotation ?? 0;
      if (Math.abs(finalRotation - initialRotation) > 0.1) {
        engine.history.pushExecuted({
          description: stickyNote ? 'Rotate sticky note' : 'Rotate text box',
          execute: () => { object.rotation = finalRotation; engine.drawing.redraw(); setStickyRevision(revision => revision + 1); },
          undo: () => { object.rotation = initialRotation; engine.drawing.redraw(); setStickyRevision(revision => revision + 1); },
        });
        engine.input.notifyChange();
      }
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    gestureCleanup.current = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  };

  const isInteractive = editor?.isFocused ?? false;
  const showHandles = !isHandTool && engine.texts.isEditable(object) && (isSelected || isInteractive);
  const containsLink = JSON.stringify(object.content).includes('"type":"link"');
  const pastePresentation = object.metadata?.pastePresentation;
  const pastePresentationClass = !stickyNote && pastePresentation === 'sticky-note'
    ? 'panvas-pasted-note'
    : pastePresentation === 'mixed-paste'
      ? 'panvas-mixed-paste'
      : '';
  const [, setStickyRevision] = useState(0);
  const styleGesture = useRef<{ undo?: () => void; execute?: () => void } | null>(null);
  useEffect(() => {
    const handleStickyChanged = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id === object.id) {
        setStickyRevision(r => r + 1);
      }
    };
    document.addEventListener('panvas:sticky-note-changed', handleStickyChanged);
    return () => document.removeEventListener('panvas:sticky-note-changed', handleStickyChanged);
  }, [object.id]);

  useEffect(() => engine.selection.subscribe(() => setStickyRevision(r => r + 1)), [engine]);
  const historyVisualSignatureRef = useRef(textHistoryVisualSignature(object, textMinHeight));
  useEffect(() => engine.history.subscribe(() => {
    const current = engine.texts.getTexts().find(text => text.id === object.id);
    if (!current) return;
    const nextHeight = current.height || textMinHeight;
    const signature = textHistoryVisualSignature(current, textMinHeight);
    if (signature === historyVisualSignatureRef.current) return;
    historyVisualSignatureRef.current = signature;
    setPos(previous => previous.x === current.x && previous.y === current.y ? previous : { x: current.x, y: current.y });
    setSize(previous => previous.width === current.width && previous.height === nextHeight ? previous : { width: current.width, height: nextHeight });
    setStickyRevision(r => r + 1);
  }), [engine, object.id, textMinHeight]);

  if (!editor) return <StaticTextPreview object={object} scale={scale} zIndex={zIndex} offset={pageOffset} />;

  const stickyColor = getStickyNoteColor(object);
  const stickyOpacity = getStickyNoteOpacity(object);
  const stickyShape = getStickyNoteShape(object);
  const bgRgba = stickyNote ? hexToRgba(stickyColor, stickyOpacity) : undefined;
  const sourceHeight = Math.max(textMinHeight, object.height ?? 0);
  const currentWidth = size.width;
  const currentHeight = size.height;

  const pdfVisualRect = pdfPlacement
    ? sourceRectToVisual(
      { x: pos.x + (pdfPlacement.sourceOffset?.x ?? 0), y: pos.y + (pdfPlacement.sourceOffset?.y ?? 0), width: currentWidth, height: currentHeight },
      pdfPlacement.sourceDimensions,
      pdfPlacement.rotation,
    )
    : null;

  const pdfContentTransform = pdfPlacement
    ? pdfPlacement.rotation === 90
      ? `translateX(${currentHeight}px) rotate(90deg)`
      : pdfPlacement.rotation === 180
        ? `translate(${currentWidth}px, ${currentHeight}px) rotate(180deg)`
        : pdfPlacement.rotation === 270
          ? `translateY(${currentWidth}px) rotate(-90deg)`
          : undefined
    : undefined;

  const handleStickyUpdate = (updates: { color?: string; opacity?: number; shape?: StickyNoteShape }) => {
    if (!stickyNote || !engine.texts.isEditable(object)) return;
    const previousColor = getStickyNoteColor(object);
    const previousOpacity = getStickyNoteOpacity(object);
    const previousShape = getStickyNoteShape(object);
    const previousBounds = { width: object.width, height: object.height || textMinHeight };
    let nextBounds = previousBounds;
    if (updates.shape && updates.shape !== previousShape) {
      const edge = Math.max(previousBounds.width, previousBounds.height);
      nextBounds = ['square', 'circle', 'star'].includes(updates.shape)
        ? { width: edge, height: edge }
        : ['rectangle', 'oval'].includes(updates.shape)
          ? { width: edge, height: Math.max(100, edge * 2 / 3) }
          : previousBounds;
    }

    const nextColor = updates.color ?? previousColor;
    const nextOpacity = updates.opacity !== undefined ? Math.max(0, Math.min(1, updates.opacity)) : previousOpacity;
    const nextShape = updates.shape ?? previousShape;

    if (nextColor === previousColor && nextOpacity === previousOpacity && nextShape === previousShape) return;

    const apply = (color: string, opacity: number, shape: StickyNoteShape, bounds: typeof previousBounds) => {
      object.metadata = {
        ...(object.metadata ?? {}),
        isStickyNote: true,
        color,
        opacity,
        shape,
      };
      engine.texts.updateTextMetadata(object.id, { isStickyNote: true, color, opacity, shape });
      engine.texts.updateTextBounds(object.id, bounds.width, bounds.height);
      setSize(bounds);
      engine.drawing.redraw();
      engine.input.notifyChange();
      setStickyRevision(r => r + 1);
      document.dispatchEvent(new CustomEvent('panvas:sticky-note-changed', { detail: { id: object.id } }));
    };

    const command = {
      description: 'Update sticky note styling',
      execute: () => apply(nextColor, nextOpacity, nextShape, nextBounds),
      undo: () => apply(previousColor, previousOpacity, previousShape, previousBounds),
    };
    command.execute();
    if (styleGesture.current) {
      styleGesture.current.undo ??= command.undo;
      styleGesture.current.execute = command.execute;
    } else engine.history.pushExecuted(command);
  };

  return (
    <div
      ref={surfaceRef}
      data-text-object-id={object.id}
      className={`absolute ${pastePresentationClass} ${isSelected ? 'ring-1.5 ring-panvas-accent-blue rounded-sm' : ''} ${
        isHandTool ? 'pointer-events-none z-0' : 'pointer-events-auto z-20'
      }`}
      style={{
        touchAction: isTextTool ? 'auto' : 'none',
        isolation: 'isolate',
        zIndex,
        ...textObjectStyle(object),
        left: `${(pdfVisualRect?.x ?? pos.x + (pageOffset?.x ?? 0)) * scale}px`,
        top: `${(pdfVisualRect?.y ?? pos.y + (pageOffset?.y ?? 0)) * scale}px`,
        width: `${pdfVisualRect?.width ?? currentWidth}px`,
        minHeight: `${pdfVisualRect?.height ?? textMinHeight}px`,
        ...(pdfVisualRect ? { height: `${pdfVisualRect.height}px` } : currentHeight ? { height: `${Math.max(textMinHeight, currentHeight)}px` } : {}),
        transform: `scale(${scale}) rotate(${object.rotation ?? 0}deg)`,
        transformOrigin: 'center',
        ...(/^#[0-9a-f]{6}$/i.test(String(object.metadata?.elementBackground ?? '')) && !stickyNote
          ? { backgroundColor: String(object.metadata?.elementBackground) }
          : {}),
      }}
      onPointerDown={(e) => {
        if (!pdfPlacement && !isTextTool && !isHandTool) {
          const rect = surfaceRef.current!.getBoundingClientRect();
          const point = { x: object.x + (e.clientX - rect.left) * size.width / rect.width, y: object.y + (e.clientY - rect.top) * size.height / rect.height };
          const hit = engine.selection.hitTest(point.x, point.y);
          if (toolMode !== 'select' || (hit && hit.id !== object.id)) {
            e.preventDefault();
            e.stopPropagation();
            engine.input.routeOverlayPointerDown(e.nativeEvent);
            return;
          }
        }
        if (!isTextTool) {
          handleDragStart(e);
        }
      }}
      onDoubleClick={(e) => {
        if (!isTextTool) {
          e.stopPropagation();
          engine.tools.setMode('text');
          editor.commands.focus('end');
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          editor.commands.blur();
          engine.tools.setMode('select');
        }
      }}
    >
      {/* Sticky note background shape & opacity container */}
      {stickyNote && (
        <div className="absolute inset-0 -z-10 overflow-visible pointer-events-none">
          {stickyShape === 'star' ? (
            <svg className="w-full h-full drop-shadow-md" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polygon points="50,0 63,38 100,38 69,59 82,100 50,75 18,100 31,59 0,38 37,38" fill={bgRgba} />
            </svg>
          ) : (
            <div
              className="w-full h-full shadow-md transition-colors"
              style={{
                backgroundColor: bgRgba,
                ...stickyPaperStyle(object),
                borderRadius: getShapeBorderRadius(stickyShape),
              }}
            />
          )}
        </div>
      )}

      {/* Top drag grip handle */}
      {showHandles && (
        <div
          className="absolute -top-7 left-1/2 -translate-x-1/2 z-30 flex h-5 w-9 items-center justify-center rounded-full bg-panvas-bg-elevated/90 hover:bg-panvas-bg-elevated shadow-xs border border-panvas-border-subtle cursor-grab active:cursor-grabbing pointer-events-auto transition-opacity select-none touch-none"
          title="Drag to move"
          aria-label="Drag to move"
          onPointerDown={handleDragStart}
        >
          <GripHorizontal size={12} className="text-panvas-text-tertiary" />
        </div>
      )}

      {showHandles && (
        <button
          type="button"
          className="pointer-events-auto absolute -right-8 top-1/2 z-30 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-panvas-accent-blue bg-panvas-bg-elevated text-panvas-accent-blue shadow-sm cursor-grab active:cursor-grabbing focus-ring"
          aria-label={stickyNote ? 'Rotate sticky note' : 'Rotate text box'}
          title="Rotate"
          onPointerDown={handleRotateStart}
        >
          <RotateCw size={12} />
        </button>
      )}

      {stickyNote && showHandles && (
        <div className="absolute -top-7 left-[calc(50%+26px)] z-30 flex gap-1">
          <button type="button" className="flex h-5 w-5 items-center justify-center rounded-full border border-panvas-border-subtle bg-panvas-bg-elevated/90 text-panvas-text-secondary shadow-xs hover:text-panvas-text-primary focus-ring" title="Sticky note color" aria-label="Sticky note color" aria-expanded={stickyStylePanel === 'color'} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); setStickyStylePanel(panel => panel === 'color' ? null : 'color'); }}><Palette size={11} /></button>
          <button type="button" className="flex h-5 w-5 items-center justify-center rounded-full border border-panvas-border-subtle bg-panvas-bg-elevated/90 text-panvas-text-secondary shadow-xs hover:text-panvas-text-primary focus-ring" title="Sticky note shape" aria-label="Sticky note shape" aria-expanded={stickyStylePanel === 'shape'} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); setStickyStylePanel(panel => panel === 'shape' ? null : 'shape'); }}><Shapes size={11} /></button>
        </div>
      )}

      {/* Sticky Note Controls Toolbar */}
      {stickyNote && showHandles && stickyStylePanel && (
        <div
          className={`panvas-overlay panvas-floating-surface pointer-events-auto absolute bottom-[calc(100%+38px)] left-0 z-40 flex items-center gap-1.5 rounded-lg px-2.5 py-2 shadow-lg border border-panvas-border-subtle bg-panvas-bg-elevated text-panvas-text-primary text-xs max-w-[calc(100vw-32px)] ${stickyStylePanel === 'color' ? 'w-[360px] flex-wrap' : 'w-auto min-w-[190px]'}`}
          role="toolbar"
          aria-label="Sticky note controls"
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
        >
          {stickyStylePanel === 'shape' && <div className="relative flex items-center">
            <select
              aria-label="Sticky note shape"
              value={stickyShape}
              onChange={(e) => handleStickyUpdate({ shape: e.target.value as StickyNoteShape })}
              className="bg-transparent text-2xs font-medium text-panvas-text-primary outline-none cursor-pointer pr-1 py-0.5"
            >
              {STICKY_NOTE_SHAPES.map(s => (
                <option key={s.id} value={s.id} className="bg-panvas-bg-elevated text-panvas-text-primary">
                  {s.label}
                </option>
              ))}
            </select>
          </div>}

          {/* Color Palette (7 preset colors) */}
          {stickyStylePanel === 'color' && <div className="flex shrink-0 items-center gap-1">
            {STICKY_NOTE_COLORS.map(({ name, value }) => (
              <button
                key={`${name}-${value}`}
                type="button"
                aria-label={`${name} sticky note`}
                title={name}
                className={`h-[18px] w-[18px] shrink-0 rounded-full border border-black/15 transition-transform hover:scale-110 cursor-pointer ${stickyColor.toLowerCase() === value.toLowerCase() ? 'ring-2 ring-panvas-accent-blue ring-offset-1 ring-offset-panvas-bg-primary' : ''}`}
                style={{ backgroundColor: value }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={() => handleStickyUpdate({ color: value })}
              />
            ))}

            {/* Custom Hex Color Picker */}
            <label
              title="Custom color"
              className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-black/15 cursor-pointer hover:scale-110 transition-transform overflow-hidden"
              style={{ background: 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)' }}
            >
              <input
                type="color"
                aria-label="Custom color picker"
                value={stickyColor.startsWith('#') && stickyColor.length === 7 ? stickyColor : '#fff1a8'}
                onChange={(e) => handleStickyUpdate({ color: e.target.value })}
                className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
                onPointerDown={(e) => e.stopPropagation()}
              />
            </label>
          </div>}

          {stickyStylePanel === 'color' && <div className="h-3.5 w-px bg-panvas-border-subtle" />}

          {/* Opacity Slider */}
          {stickyStylePanel === 'color' && <div className="flex items-center gap-1 pl-0.5">
            <input
              type="range"
              min="10"
              max="100"
              aria-label="Sticky note opacity"
              title={`Opacity: ${Math.round(stickyOpacity * 100)}%`}
              value={Math.round(stickyOpacity * 100)}
              onChange={(e) => handleStickyUpdate({ opacity: Number(e.target.value) / 100 })}
              onPointerDown={(e) => {
                e.stopPropagation();
                styleGesture.current = {};
                const finish = () => {
                  const command = styleGesture.current;
                  styleGesture.current = null;
                  if (command?.undo && command.execute) engine.history.pushExecuted({ description: 'Change sticky opacity', undo: command.undo, execute: command.execute });
                  window.removeEventListener('pointerup', finish);
                  window.removeEventListener('pointercancel', finish);
                };
                window.addEventListener('pointerup', finish);
                window.addEventListener('pointercancel', finish);
              }}
              className="w-14 h-1 accent-panvas-accent-blue cursor-pointer"
            />
            <span className="text-2xs text-panvas-text-tertiary tabular-nums w-6 text-right select-none">
              {Math.round(stickyOpacity * 100)}%
            </span>
          </div>}
          <button
            type="button"
            className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-panvas-text-tertiary hover:bg-panvas-bg-hover hover:text-panvas-text-primary focus-ring"
            aria-label="Close sticky note style"
            title="Close"
            onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}
            onClick={() => setStickyStylePanel(null)}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Editor Content */}
      <div
        ref={containerRef}
        className="relative min-w-0"
        style={pdfPlacement ? {
          position: 'absolute',
          left: 0,
          top: 0,
          width: `${currentWidth}px`,
          minHeight: `${currentHeight}px`,
          ...(currentHeight ? { height: `${currentHeight}px` } : {}),
          transformOrigin: 'top left',
          ...(pdfContentTransform ? { transform: pdfContentTransform } : {}),
        } : { width: '100%', height: stickyNote ? '100%' : undefined, minHeight: stickyNote ? 0 : `${textMinHeight}px` }}
      >
        <EditorContent
          editor={editor}
          className={`outline-none prose prose-neutral max-w-none prose-sm ${stickyNote ? 'p-0' : 'p-1'}`}
          style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', ...(stickyNote ? { height: '100%', overflow: 'auto', padding: stickyShape === 'star' ? '34% 24% 20%' : ['circle', 'oval'].includes(stickyShape) ? '20% 18%' : '14px 16px' } : {}) }}
        />

        {/* 8-Handle DOM Overlay for direct intuitive resizing */}
        {showHandles && (
          <>
            {/* Corner Handles */}
            <div
              className="pointer-events-auto absolute -top-1.5 -left-1.5 h-3 w-3 rounded-xs border-1.5 border-panvas-accent-blue bg-panvas-bg-elevated shadow-sm transition-transform hover:scale-125 z-30 cursor-nwse-resize"
              onPointerDown={(e) => handleResizeStart('tl', e)}
            />
            <div
              className="pointer-events-auto absolute -top-1.5 -right-1.5 h-3 w-3 rounded-xs border-1.5 border-panvas-accent-blue bg-panvas-bg-elevated shadow-sm transition-transform hover:scale-125 z-30 cursor-nesw-resize"
              onPointerDown={(e) => handleResizeStart('tr', e)}
            />
            <div
              className="pointer-events-auto absolute -bottom-1.5 -left-1.5 h-3 w-3 rounded-xs border-1.5 border-panvas-accent-blue bg-panvas-bg-elevated shadow-sm transition-transform hover:scale-125 z-30 cursor-nesw-resize"
              onPointerDown={(e) => handleResizeStart('bl', e)}
            />
            <div
              className="pointer-events-auto absolute -bottom-1.5 -right-1.5 h-3 w-3 rounded-xs border-1.5 border-panvas-accent-blue bg-panvas-bg-elevated shadow-sm transition-transform hover:scale-125 z-30 cursor-nwse-resize"
              onPointerDown={(e) => handleResizeStart('br', e)}
            />

            {/* Edge Handles */}
            <div
              className="pointer-events-auto absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rounded-xs border-1.5 border-panvas-accent-blue bg-panvas-bg-elevated shadow-sm transition-transform hover:scale-125 z-30 cursor-ns-resize"
              onPointerDown={(e) => handleResizeStart('tc', e)}
            />
            <div
              className="pointer-events-auto absolute -bottom-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rounded-xs border-1.5 border-panvas-accent-blue bg-panvas-bg-elevated shadow-sm transition-transform hover:scale-125 z-30 cursor-ns-resize"
              onPointerDown={(e) => handleResizeStart('bc', e)}
            />
            <div
              className="pointer-events-auto absolute top-1/2 -left-1.5 h-3 w-3 -translate-y-1/2 rounded-xs border-1.5 border-panvas-accent-blue bg-panvas-bg-elevated shadow-sm transition-transform hover:scale-125 z-30 cursor-ew-resize"
              onPointerDown={(e) => handleResizeStart('ml', e)}
            />
            <div
              className="pointer-events-auto absolute top-1/2 -right-1.5 h-3 w-3 -translate-y-1/2 rounded-xs border-1.5 border-panvas-accent-blue bg-panvas-bg-elevated shadow-sm transition-transform hover:scale-125 z-30 cursor-ew-resize"
              onPointerDown={(e) => handleResizeStart('mr', e)}
            />
          </>
        )}
      </div>
    </div>
  );
};

export const FloatingTextEditor = React.memo(FloatingTextEditorComponent);
FloatingTextEditor.displayName = 'FloatingTextEditor';
