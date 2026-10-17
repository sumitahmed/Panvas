// ============================================
// Panvas — Notebook Canvas Context Menu
// ============================================

import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { OverlayManager } from '@/components/ui/OverlayManager';
import type { Editor } from '@tiptap/core';
import { DocumentationControls } from './DocumentationControls';
import type { NotebookEngine } from './engine/NotebookEngine';
import { canUseDocumentLayoutHistory, runDocumentLayoutHistory } from './documentLayoutTransition';
import { 
  Undo2, 
  Redo2, 
  Scissors, 
  Copy, 
  ClipboardPaste, 
  CopyPlus, 
  Trash2, 
  CheckSquare,
  ChevronUp,
  ChevronDown,
  ChevronsUp,
  ChevronsDown,
  Languages,
} from 'lucide-react';

export interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  hasSelection: boolean;
  isTextEditing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canConvertHandwriting: boolean;
  editor?: Editor | null;
  blockId?: string;
}

export interface NotebookContextMenuProps {
  engine?: NotebookEngine;
  state: ContextMenuState;
  onClose: () => void;
  onCommand: (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'duplicate' | 'delete' | 'selectAll' | 'bringToFront' | 'bringForward' | 'sendBackward' | 'sendToBack' | 'convertHandwriting') => void;
}

export const NotebookContextMenu: React.FC<NotebookContextMenuProps> = ({
  engine,
  state,
  onClose,
  onCommand,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);

  // OverlayManager handles outside clicks and Escape; window changes dismiss.
  useEffect(() => {
    if (!state.isOpen) return;
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);

    return () => {
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [state.isOpen, onClose]);

  if (!state.isOpen) return null;

  // OverlayManager measures and collides the actual panel at the pointer.
  const editor = state.editor && !state.editor.isDestroyed ? state.editor : null;
  const menuWidth = editor ? 310 : 190;

  const handleAction = (cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'duplicate' | 'delete' | 'selectAll' | 'bringToFront' | 'bringForward' | 'sendBackward' | 'sendToBack' | 'convertHandwriting') => {
    onCommand(cmd);
    onClose();
  };

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const modKey = isMac ? '⌘' : 'Ctrl+';

  return (
    <><span ref={anchorRef} aria-hidden="true" className="pointer-events-none fixed" style={{ left: state.x, top: state.y }} />
    <OverlayManager isOpen anchorRef={anchorRef} placement="bottom-start" offset={{ x: 0, y: 0 }} exclusiveGroup="documentation" onClose={onClose} onEscape={() => { if (editor && !editor.isDestroyed) editor.view.focus(); }}>
    <AnimatePresence>
      <motion.div
        ref={menuRef}
        initial={{ opacity: 0, scale: 0.95, y: -4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.1, ease: 'easeOut' }}
        className="panvas-overlay min-w-0 rounded-lg border border-panvas-border-default bg-panvas-bg-elevated p-1 shadow-2xl backdrop-blur-md select-none text-xs"
        style={{ width: menuWidth, maxHeight: 'min(400px,var(--panvas-overlay-max-height,calc(100dvh - 24px)))', overflowY: 'auto' }}
        aria-label={editor ? 'Document block menu' : 'Canvas context menu'}
        onContextMenu={(e) => e.preventDefault()}
      >
        {editor ? <>
          <div className="flex gap-1 px-2 py-1">
            {(['undo', 'redo'] as const).map(direction => <button key={direction} type="button" className="rounded px-2 py-1 capitalize hover:bg-panvas-bg-hover" onMouseDown={event => event.preventDefault()} disabled={!editor.can()[direction]() && !(engine && canUseDocumentLayoutHistory(engine, direction, editor))} onClick={() => { if (!editor.chain().focus()[direction]().run() && engine) runDocumentLayoutHistory(engine, direction, editor); onClose(); }}>{direction}</button>)}
            {(['cut', 'copy', 'paste'] as const).map(command => <button key={command} type="button" className="rounded px-2 py-1 capitalize hover:bg-panvas-bg-hover" onMouseDown={event => event.preventDefault()} onClick={() => { editor.commands.focus(); handleAction(command); }}>{command}</button>)}
          </div>
          <DocumentationControls editor={editor} blockId={state.blockId} onDismiss={onClose} />
        </> : <>
        {/* Undo / Redo */}
        <button
          type="button"
          disabled={!state.canUndo}
          onClick={() => handleAction('undo')}
          className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-panvas-text-primary hover:bg-panvas-bg-hover disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <div className="flex items-center gap-2">
            <Undo2 size={13} className="text-panvas-text-secondary" />
            <span>Undo</span>
          </div>
          <span className="text-[10px] font-mono text-panvas-text-tertiary">{modKey}Z</span>
        </button>

        <button
          type="button"
          disabled={!state.canRedo}
          onClick={() => handleAction('redo')}
          className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-panvas-text-primary hover:bg-panvas-bg-hover disabled:opacity-40 disabled:pointer-events-none transition-colors"
        >
          <div className="flex items-center gap-2">
            <Redo2 size={13} className="text-panvas-text-secondary" />
            <span>Redo</span>
          </div>
          <span className="text-[10px] font-mono text-panvas-text-tertiary">{modKey}Y</span>
        </button>

        <div className="my-1 border-t border-panvas-border-subtle" />

        {/* Cut / Copy / Paste / Duplicate */}
        {(state.hasSelection || state.isTextEditing) && (
          <button
            type="button"
            onClick={() => handleAction('cut')}
            className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-panvas-text-primary hover:bg-panvas-bg-hover transition-colors"
          >
            <div className="flex items-center gap-2">
              <Scissors size={13} className="text-panvas-text-secondary" />
              <span>Cut</span>
            </div>
            <span className="text-[10px] font-mono text-panvas-text-tertiary">{modKey}X</span>
          </button>
        )}

        {(state.hasSelection || state.isTextEditing) && (
          <button
            type="button"
            onClick={() => handleAction('copy')}
            className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-panvas-text-primary hover:bg-panvas-bg-hover transition-colors"
          >
            <div className="flex items-center gap-2">
              <Copy size={13} className="text-panvas-text-secondary" />
              <span>Copy</span>
            </div>
            <span className="text-[10px] font-mono text-panvas-text-tertiary">{modKey}C</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => handleAction('paste')}
          className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-panvas-text-primary hover:bg-panvas-bg-hover transition-colors"
        >
          <div className="flex items-center gap-2">
            <ClipboardPaste size={13} className="text-panvas-text-secondary" />
            <span>Paste</span>
          </div>
          <span className="text-[10px] font-mono text-panvas-text-tertiary">{modKey}V</span>
        </button>

        {state.hasSelection && !state.isTextEditing && (
          <button
            type="button"
            onClick={() => handleAction('duplicate')}
            className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-panvas-text-primary hover:bg-panvas-bg-hover transition-colors"
          >
            <div className="flex items-center gap-2">
              <CopyPlus size={13} className="text-panvas-text-secondary" />
              <span>Duplicate</span>
            </div>
            <span className="text-[10px] font-mono text-panvas-text-tertiary">{modKey}D</span>
          </button>
        )}

        {state.canConvertHandwriting && !state.isTextEditing && (
          <button
            type="button"
            onClick={() => handleAction('convertHandwriting')}
            className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-panvas-text-primary hover:bg-panvas-bg-hover transition-colors"
          >
            <div className="flex items-center gap-2">
              <Languages size={13} className="text-blue-400" />
              <span>Convert to Text</span>
            </div>
          </button>
        )}

        {state.hasSelection && !state.isTextEditing && (
          <>
            <div className="my-1 border-t border-panvas-border-subtle" />
            <button
              type="button"
              onClick={() => handleAction('bringToFront')}
              className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-panvas-text-primary hover:bg-panvas-bg-hover transition-colors"
            >
              <div className="flex items-center gap-2"><ChevronsUp size={13} className="text-panvas-text-secondary" /><span>Bring to Front</span></div>
              <span className="text-[10px] font-mono text-panvas-text-tertiary">{modKey}Shift+]</span>
            </button>
            <button
              type="button"
              onClick={() => handleAction('bringForward')}
              className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-panvas-text-primary hover:bg-panvas-bg-hover transition-colors"
            >
              <div className="flex items-center gap-2"><ChevronUp size={13} className="text-panvas-text-secondary" /><span>Bring Forward</span></div>
              <span className="text-[10px] font-mono text-panvas-text-tertiary">{modKey}]</span>
            </button>
            <button
              type="button"
              onClick={() => handleAction('sendBackward')}
              className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-panvas-text-primary hover:bg-panvas-bg-hover transition-colors"
            >
              <div className="flex items-center gap-2"><ChevronDown size={13} className="text-panvas-text-secondary" /><span>Send Backward</span></div>
              <span className="text-[10px] font-mono text-panvas-text-tertiary">{modKey}[</span>
            </button>
            <button
              type="button"
              onClick={() => handleAction('sendToBack')}
              className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-panvas-text-primary hover:bg-panvas-bg-hover transition-colors"
            >
              <div className="flex items-center gap-2"><ChevronsDown size={13} className="text-panvas-text-secondary" /><span>Send to Back</span></div>
              <span className="text-[10px] font-mono text-panvas-text-tertiary">{modKey}Shift+[</span>
            </button>
          </>
        )}

        <div className="my-1 border-t border-panvas-border-subtle" />

        {/* Select All */}
        <button
          type="button"
          onClick={() => handleAction('selectAll')}
          className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-panvas-text-primary hover:bg-panvas-bg-hover transition-colors"
        >
          <div className="flex items-center gap-2">
            <CheckSquare size={13} className="text-panvas-text-secondary" />
            <span>Select All</span>
          </div>
          <span className="text-[10px] font-mono text-panvas-text-tertiary">{modKey}A</span>
        </button>

        {/* Delete */}
        {state.hasSelection && !state.isTextEditing && (
          <button
            type="button"
            onClick={() => handleAction('delete')}
            className="flex w-full items-center justify-between px-2.5 py-1.5 rounded-md text-red-500 hover:bg-red-500/10 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Trash2 size={13} className="text-red-500" />
              <span>Delete</span>
            </div>
            <span className="text-[10px] font-mono opacity-70">Del</span>
          </button>
        )}
        </>}
      </motion.div>
    </AnimatePresence></OverlayManager></>
  );
};
