import React, { useEffect, useRef, useState } from 'react';
import { CalendarClock, Check, Mic, Pause, Pencil, Play, RotateCcw, Square, Trash2, Upload, X } from 'lucide-react';
import type { NotebookEngine } from './engine/NotebookEngine';
import type { AudioNote, DrawingData } from './engine/drawingTypes';
import { canvasRepository } from '@/repositories/CanvasRepository';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';
import { generateId } from '@/lib/utils/id';
import { OverlayManager } from '@/components/ui/OverlayManager';
import {
  AudioPlaybackController,
  audioNoteTitle,
  createPlaybackBlob,
  PageAudioRecordingSession,
  audioFileExtension,
  createSupportedMediaRecorder,
  formatAudioTime,
  negotiateRecordingMimeType,
  recordingErrorMessage,
  samePageAudioOwner,
  type AudioPlaybackState,
  type CompletedRecording,
  type PageAudioOwner,
} from '@/services/audio/audioLifecycle';
import { pageAudioPersistence } from '@/services/audio/pageAudioPersistenceInstance';
import { createVoiceNoteObject, clampVoiceNoteRect } from '@/services/audio/voiceNoteObjects';
import { resolvePageSurfaceGeometry } from '@/lib/pageProperties';
import { changeVoiceNote } from '@/services/audio/voiceNoteCommands';

interface NotebookAudioControlProps {
  engine: NotebookEngine;
  owner?: PageAudioOwner;
  canRecord?: boolean;
  onPageDataPersisted?: (pageId: string, data: DrawingData) => void;
  onDelete?: (note: AudioNote) => void;
  onRename?: (note: AudioNote, title: string) => void;
}

const initialPlayback: AudioPlaybackState = { activeNoteId: null, status: 'idle', elapsedMs: 0, durationMs: 0 };

export function NotebookAudioControl({ engine, owner, canRecord = true, onPageDataPersisted, onDelete, onRename }: NotebookAudioControlProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'finalizing'>('idle');
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const [playback, setPlayback] = useState<AudioPlaybackState>(initialPlayback);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [, setRevision] = useState(0);
  const sessionRef = useRef<PageAudioRecordingSession | null>(null);
  const playerRef = useRef<AudioPlaybackController | null>(null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const mountedRef = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const userId = useAuthStore(state => state.user?.id ?? null);
  const showToast = useUIStore(state => state.showToast);

  useEffect(() => engine.audio.subscribe(() => setRevision(value => value + 1)), [engine]);

  useEffect(() => {
    mountedRef.current = true;
    const player = new AudioPlaybackController(new Audio(), URL);
    playerRef.current = player;
    const unsubscribe = player.subscribe(setPlayback);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      player.destroy();
      playerRef.current = null;
      void sessionRef.current?.stop().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    playerRef.current?.clear();
    const session = sessionRef.current;
    if (session && !samePageAudioOwner(session.owner as PageAudioOwner, owner)) void stopRecording();
  }, [owner?.notebookId, owner?.pageId, owner?.workspaceId]);

  useEffect(() => {
    if (!canRecord && sessionRef.current) void stopRecording();
  }, [canRecord]);

  useEffect(() => {
    if (recordingState !== 'recording') return;
    const update = () => {
      const session = sessionRef.current;
      if (session) setRecordingElapsedMs(Math.max(0, Date.now() - session.startedAt));
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [recordingState]);

  const applyPersistedData = (target: PageAudioOwner, data: DrawingData) => {
    if (!mountedRef.current) return;
    onPageDataPersisted?.(target.pageId, data);
    if (samePageAudioOwner(ownerRef.current, target)) engine.audio.setAll(data.audioNotes);
  };

  const persistBlob = async (target: PageAudioOwner, blob: Blob, fileName: string, durationMs?: number) => {
    if (!/^audio\//i.test(blob.type)) throw new Error('Unsupported audio format.');
    const stored = await canvasRepository.storeAudio(userId, target.pageId, fileName, blob.type, await blob.arrayBuffer());
    const note: AudioNote = { id: generateId('audio'), fileId: stored.id, fileName, title: 'Voice note', mimeType: blob.type, durationMs, createdAt: Date.now() };
    try {
      const object = createVoiceNoteObject(note, engine.audio.getAll().length);
      if (samePageAudioOwner(ownerRef.current, target)) {
        const canvas = engine.drawing.getCanvasElement();
        const geometry = resolvePageSurfaceGeometry(engine.getProperties());
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const viewport = canvas.closest('.notebook-viewport')?.getBoundingClientRect();
          const left = Math.max(rect.left, viewport?.left ?? 0);
          const top = Math.max(rect.top, (viewport?.top ?? 0) + 120);
          const right = Math.min(rect.right, viewport?.right ?? window.innerWidth);
          const bottom = Math.min(rect.bottom, viewport?.bottom ?? window.innerHeight);
          const point = engine.viewport.canvasToPage(((left + right) / 2 - rect.left) * canvas.clientWidth / rect.width, ((top + bottom) / 2 - rect.top) * canvas.clientHeight / rect.height);
          Object.assign(object, clampVoiceNoteRect({ x: point.x - object.width / 2, y: point.y - (object.height ?? 132) / 2, width: object.width, height: object.height ?? 132 }, { x: -geometry.source.left, y: -geometry.source.top, width: geometry.width, height: geometry.height }));
        }
      }
      const data = await pageAudioPersistence.appendVoiceNote(target, note, object);
      applyPersistedData(target, data);
      if (samePageAudioOwner(ownerRef.current, target)) engine.selection.selectElement(object.id, 'text');
    } catch (error) {
      await canvasRepository.deleteAudio(stored.id).catch(() => undefined);
      throw error;
    }
  };

  const completeRecording = async (recording: CompletedRecording) => {
    const timestamp = new Date(recording.startedAt).toISOString().replace(/[:.]/g, '-');
    await persistBlob(recording.owner, recording.blob, `voice-note-${timestamp}.${audioFileExtension(recording.mimeType)}`, recording.durationMs);
    showToast('Voice note saved locally.', 'success');
  };

  const startRecording = async () => {
    if (!owner) { showToast('Open a page before recording audio.', 'error'); return; }
    if (!canRecord) { showToast('Switch to Edit mode to record audio.', 'info'); return; }
    if (sessionRef.current) return;
    const targetOwner = { ...owner };
    let pendingStream: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new DOMException('Audio recording is unavailable.', 'NotSupportedError');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      pendingStream = stream;
      if (!samePageAudioOwner(ownerRef.current, targetOwner)) {
        stream.getTracks().forEach(track => track.stop());
        pendingStream = null;
        throw new DOMException('Recording was interrupted by page navigation.', 'RecordingInterruptedError');
      }
      const recorder = createSupportedMediaRecorder(stream);
      const selectedMimeType = recorder.mimeType || negotiateRecordingMimeType(type => MediaRecorder.isTypeSupported?.(type) ?? false);
      const session = new PageAudioRecordingSession({
        owner: targetOwner, recorder, stream, selectedMimeType, onComplete: completeRecording,
        onError: error => showToast(recordingErrorMessage(error), 'error'),
      });
      pendingStream = null;
      sessionRef.current = session;
      setRecordingElapsedMs(0);
      setRecordingState('recording');
      session.start();
      void session.completion.catch(() => undefined).finally(() => {
        if (sessionRef.current === session) sessionRef.current = null;
        if (mountedRef.current) setRecordingState('idle');
      });
    } catch (error) {
      pendingStream?.getTracks().forEach(track => track.stop());
      showToast(recordingErrorMessage(error), 'error');
    }
  };

  const stopRecording = (): Promise<void> => {
    const session = sessionRef.current;
    if (!session) return Promise.resolve();
    if (mountedRef.current) setRecordingState('finalizing');
    return session.stop().catch(() => undefined);
  };

  const importAudio = async (file: File) => {
    if (!owner) throw new Error('Open a page before adding audio.');
    await persistBlob({ ...owner }, file, file.name);
    showToast('Audio note imported.', 'success');
  };

  const playNote = async (note: AudioNote) => {
    const player = playerRef.current;
    if (!player) return;
    if (playback.activeNoteId === note.id) {
      if (playback.status === 'playing') { player.pause(); return; }
      if (playback.status === 'ended') player.seek(0);
      await player.resume().catch(error => showToast(recordingErrorMessage(error), 'error'));
      return;
    }
    try {
      const asset = await canvasRepository.getAudio(note.fileId);
      if (!asset) throw new Error('The local audio file is missing.');
      await player.play(note.id, createPlaybackBlob(asset.data, asset.mimeType, note.mimeType), note.durationMs ?? 0);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'This recording could not be played.', 'error');
    }
  };

  const mutateVoice = (note: AudioNote, change: { delete: true } | { title: string }) => {
    if (!owner) return;
    const target = { ...owner };
    changeVoiceNote(engine, note.id, change, state => {
      void pageAudioPersistence.replaceVoiceState(target, state.notes, state.objects).catch(() => showToast('Voice note changes could not be saved.', 'error'));
    });
  };
  const remove = async (note: AudioNote) => {
    playerRef.current?.clear();
    if (onDelete) onDelete(note); else mutateVoice(note, { delete: true });
  };
  const rename = async (note: AudioNote) => {
    if (onRename) onRename(note, titleDraft); else mutateVoice(note, { title: titleDraft });
    setRenamingId(null);
  };

  const notes = engine.audio.getAll();
  const isRecording = recordingState === 'recording';
  const isFinalizing = recordingState === 'finalizing';

  return (
    <div ref={controlRef} className="relative pointer-events-auto">
      <button type="button" onClick={() => setIsOpen(value => !value)} className={`panvas-icon-control focus-ring ${isOpen || recordingState !== 'idle' ? 'bg-panvas-accent-rose/15 text-panvas-accent-rose' : ''}`} title="Voice notes" aria-label="Voice notes" aria-expanded={isOpen}><Mic size={16} /></button>
      <input ref={fileRef} type="file" accept="audio/*" className="hidden" disabled={!canRecord} onChange={event => { const file = event.target.files?.[0]; if (file) void importAudio(file).catch(error => showToast(error instanceof Error ? error.message : 'Audio import failed.', 'error')); event.target.value = ''; }} />
      <OverlayManager isOpen={isOpen} onClose={() => setIsOpen(false)} anchorRef={controlRef} placement="bottom-start">
      <div role="dialog" aria-label="Voice notes" className="panvas-utility-panel panvas-floating-surface w-80 p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div><div className="text-xs font-semibold text-panvas-text-primary">Voice notes</div><div className="text-2xs text-panvas-text-tertiary">Local recordings attached to this page</div></div>
          {canRecord && <div className="flex gap-1">
            <button type="button" onClick={() => fileRef.current?.click()} disabled={recordingState !== 'idle'} className="flex h-7 items-center gap-1 rounded-md px-2 text-2xs text-panvas-text-secondary hover:bg-panvas-bg-hover disabled:opacity-50"><Upload size={12} />Import</button>
            <button type="button" onClick={isRecording ? () => void stopRecording() : () => void startRecording()} disabled={isFinalizing} className={`flex h-7 items-center gap-1 rounded-md px-2 text-2xs focus-ring disabled:opacity-50 ${recordingState !== 'idle' ? 'bg-panvas-accent-rose text-white' : 'bg-panvas-bg-secondary text-panvas-text-secondary hover:bg-panvas-bg-hover'}`}>{isRecording ? <><Square size={11} fill="currentColor" />Stop</> : isFinalizing ? 'Saving…' : <><Mic size={12} />Record</>}</button>
          </div>}
        </div>
        {recordingState !== 'idle' && <div role="status" className="mb-3 flex items-center gap-2 rounded-lg border border-panvas-accent-rose/30 bg-panvas-accent-rose/10 px-3 py-2 text-xs text-panvas-accent-rose"><span className={`h-2 w-2 rounded-full bg-panvas-accent-rose ${isRecording ? 'animate-pulse' : ''}`} />{isRecording ? `Recording ${formatAudioTime(recordingElapsedMs)}` : 'Finishing recording…'}</div>}
        {!canRecord && <div className="mb-3 rounded-lg bg-panvas-bg-secondary px-3 py-2 text-2xs text-panvas-text-tertiary">Playback is available in Read mode. Switch to Edit mode to record or import audio.</div>}
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {notes.length === 0 && <div className="panvas-empty-state p-5 text-center text-xs">No audio is attached to this page.</div>}
          {notes.map(note => {
            const active = playback.activeNoteId === note.id;
            const durationMs = active && playback.durationMs > 0 ? playback.durationMs : note.durationMs ?? 0;
            const elapsedMs = active ? playback.elapsedMs : 0;
            const title = note.title || 'Voice note';
            return <div key={note.id} className="rounded-lg border border-panvas-border-subtle bg-panvas-bg-primary p-2.5">
              <div className="mb-2 flex items-start justify-between gap-2"><div className="min-w-0 flex-1">{renamingId === note.id ? <div className="flex gap-1"><input autoFocus value={titleDraft} onChange={event => setTitleDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void rename(note); if (event.key === 'Escape') setRenamingId(null); }} className="min-w-0 flex-1 rounded border border-panvas-border-strong bg-panvas-bg-elevated px-1.5 text-xs text-panvas-text-primary" aria-label="Voice note name"/><button type="button" onClick={() => void rename(note)} className="focus-ring text-panvas-text-secondary hover:text-panvas-text-primary" aria-label="Save voice note name"><Check size={13}/></button><button type="button" onClick={() => setRenamingId(null)} className="focus-ring text-panvas-text-secondary hover:text-panvas-text-primary" aria-label="Cancel rename"><X size={13}/></button></div> : <div className="truncate text-xs font-medium text-panvas-text-primary" title={title}>{title}</div>}<div className="mt-0.5 flex items-center gap-1 text-2xs text-panvas-text-tertiary"><CalendarClock size={10} />{new Date(note.createdAt).toLocaleString()} · {formatAudioTime(durationMs)}</div></div>{canRecord && <div className="flex shrink-0 gap-1"><button type="button" onClick={() => { setTitleDraft(note.title ?? ''); setRenamingId(note.id); }} className="text-panvas-text-tertiary hover:text-panvas-text-primary focus-ring" title="Rename voice note" aria-label={`Rename ${title}`}><Pencil size={13}/></button><button type="button" onClick={() => void remove(note)} className="text-panvas-text-tertiary hover:text-panvas-text-error focus-ring" title="Delete voice note" aria-label={`Delete ${title}`}><Trash2 size={13} /></button></div>}</div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void playNote(note)} className="panvas-icon-control h-8 w-8 shrink-0 focus-ring" aria-label={active && playback.status === 'playing' ? `Pause ${title}` : `Play ${title}`}>{active && playback.status === 'playing' ? <Pause size={14} fill="currentColor" /> : playback.status === 'ended' && active ? <RotateCcw size={14} /> : <Play size={14} fill="currentColor" />}</button>
                <div className="min-w-0 flex-1">
                  <input type="range" min={0} max={Math.max(1, durationMs)} step={100} value={Math.min(elapsedMs, Math.max(1, durationMs))} disabled={!active || durationMs <= 0} onChange={event => playerRef.current?.seek(Number(event.target.value))} className="h-1.5 w-full accent-panvas-accent-blue disabled:opacity-40" aria-label={`Playback position for ${title}`} />
                  <div className="mt-1 flex justify-between text-[10px] tabular-nums text-panvas-text-tertiary"><span>{formatAudioTime(elapsedMs)}</span><span>{formatAudioTime(durationMs)}</span></div>
                </div>
              </div>
              {active && playback.status === 'error' && <div className="mt-1 text-2xs text-panvas-text-error">{playback.error}</div>}
            </div>;
          })}
        </div>
      </div>
      </OverlayManager>
    </div>
  );
}
