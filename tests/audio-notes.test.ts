import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AudioPlaybackController,
  PageAudioRecordingSession,
  audioNoteTitle,
  audioFileExtension,
  createPlaybackBlob,
  createSupportedMediaRecorder,
  negotiateRecordingMimeType,
  recordingErrorMessage,
  resolvePlaybackMimeType,
  samePageAudioOwner,
} from '../src/services/audio/audioLifecycle.ts';
import { PageAudioPersistenceCoordinator } from '../src/services/audio/pageAudioPersistence.ts';
import { drawingSnapshotJson, rememberDrawingSnapshotJson } from '../src/services/storage/drawingSnapshotJson.ts';
import {
  VOICE_NOTE_MIN_HEIGHT,
  VOICE_NOTE_MIN_WIDTH,
  clampVoiceNoteSize,
  createCanvasVoiceNoteBlock,
  createVoiceNoteObject,
  getCanvasVoiceNoteViewportPosition,
  isActiveCanvasAudioOwner,
  isVoiceNoteObject,
} from '../src/services/audio/voiceNoteObjects.ts';
import { createEmptyDrawingData, type AudioNote, type DrawingData } from '../src/components/notebook/engine/drawingTypes.ts';

const ownerA = { workspaceId: 'workspace-real', notebookId: 'notebook-real', pageId: 'page-a' };
const ownerB = { workspaceId: 'workspace-real', notebookId: 'notebook-real', pageId: 'page-b' };

test('encoded immutable drawing snapshots cannot override a newer queued audio edit', async () => {
  const repository = new MemoryDrawingRepository(), persistence = new PageAudioPersistenceCoordinator(repository);
  const snapshot = createEmptyDrawingData(), json = JSON.stringify(snapshot);
  rememberDrawingSnapshotJson(snapshot, json);
  const first = await persistence.saveDrawing(ownerA, snapshot);
  assert.equal(first, snapshot);
  assert.equal(drawingSnapshotJson(first), json);
  await persistence.append(ownerA, note('new-audio'));
  const merged = await persistence.saveDrawing(ownerA, snapshot);
  assert.notEqual(merged, snapshot);
  assert.deepEqual(JSON.parse(drawingSnapshotJson(merged)).audioNotes.map((item: AudioNote) => item.id), ['new-audio']);
  const mutable = createEmptyDrawingData();
  assert.equal(JSON.parse(drawingSnapshotJson(mutable)).properties.paperColor, mutable.properties.paperColor);
  mutable.properties.paperColor = '#abc123';
  assert.equal(JSON.parse(drawingSnapshotJson(mutable)).properties.paperColor, '#abc123', 'unmarked mutable callers are encoded afresh');
});

class MemoryDrawingRepository {
  readonly pages = new Map<string, DrawingData>();
  readonly saves: string[] = [];
  private key(workspaceId: string, notebookId: string, pageId: string) { return `${workspaceId}/${notebookId}/${pageId}`; }
  async loadDrawingData(workspaceId: string, notebookId: string, pageId: string) {
    return structuredClone(this.pages.get(this.key(workspaceId, notebookId, pageId)) ?? createEmptyDrawingData());
  }
  async saveDrawingData(workspaceId: string, notebookId: string, pageId: string, data: DrawingData) {
    const key = this.key(workspaceId, notebookId, pageId);
    this.pages.set(key, structuredClone(data));
    this.saves.push(key);
  }
  get(owner: typeof ownerA) { return this.pages.get(this.key(owner.workspaceId, owner.notebookId, owner.pageId)); }
}

class FakeRecorder {
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  stopCalls = 0;
  start() { this.state = 'recording'; }
  stop() {
    this.stopCalls += 1;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function note(id: string): AudioNote {
  return { id, fileId: `asset-${id}`, fileName: `${id}.webm`, mimeType: 'audio/webm', durationMs: 1000, createdAt: 1 };
}

test('a Page A recording finalized after navigation persists only to immutable Page A ownership', async () => {
  const repository = new MemoryDrawingRepository();
  const persistence = new PageAudioPersistenceCoordinator(repository);
  const recorder = new FakeRecorder();
  const tracks = [{ stops: 0, stop() { this.stops += 1; } }, { stops: 0, stop() { this.stops += 1; } }];
  let currentOwner = ownerA;
  let mutableEngineNotes: AudioNote[] = [];
  const session = new PageAudioRecordingSession({
    owner: ownerA,
    recorder: recorder as any,
    stream: { getTracks: () => tracks },
    now: (() => { let value = 100; return () => (value += 100); })(),
    onComplete: async recording => {
      const data = await persistence.append(recording.owner, note('recording-a'));
      if (samePageAudioOwner(currentOwner, recording.owner)) mutableEngineNotes = data.audioNotes ?? [];
    },
  });
  session.start();
  currentOwner = ownerB;
  const firstStop = session.stop();
  const secondStop = session.stop();
  assert.equal(firstStop, secondStop);
  await firstStop;
  assert.deepEqual(repository.get(ownerA)?.audioNotes?.map(item => item.id), ['recording-a']);
  assert.deepEqual(repository.get(ownerB)?.audioNotes ?? [], []);
  assert.deepEqual(mutableEngineNotes, []);
  assert.equal(recorder.stopCalls, 1);
  assert.deepEqual(tracks.map(track => track.stops), [1, 1]);
  assert.equal(recorder.onstop, null);
  assert.equal(recorder.ondataavailable, null);
});

test('page audio persistence supports multiple recordings, reopen, metadata-first deletion, and stale drawing saves', async () => {
  const repository = new MemoryDrawingRepository();
  const persistence = new PageAudioPersistenceCoordinator(repository);
  await persistence.append(ownerA, note('one'));
  await persistence.append(ownerA, note('two'));
  const reopened = await repository.loadDrawingData(ownerA.workspaceId, ownerA.notebookId, ownerA.pageId);
  assert.deepEqual(reopened.audioNotes?.map(item => item.id), ['one', 'two']);

  const stale = createEmptyDrawingData();
  stale.audioNotes = [];
  await persistence.saveDrawing(ownerA, stale);
  assert.deepEqual(repository.get(ownerA)?.audioNotes?.map(item => item.id), ['one', 'two']);

  await persistence.remove(ownerA, 'one');
  assert.deepEqual(repository.get(ownerA)?.audioNotes?.map(item => item.id), ['two']);
});

test('voice-note custom title persists through canonical page storage with filename fallback', async () => {
  const repository = new MemoryDrawingRepository();
  const persistence = new PageAudioPersistenceCoordinator(repository);
  const recording = note('lecture');
  await persistence.appendVoiceNote(ownerA, recording, createVoiceNoteObject(recording));
  await persistence.rename(ownerA, recording.id, 'Week 4 review');
  const reopened = await repository.loadDrawingData(ownerA.workspaceId, ownerA.notebookId, ownerA.pageId);
  assert.equal(reopened.audioNotes?.[0]?.title, 'Week 4 review');
  assert.equal(audioNoteTitle(reopened.audioNotes![0]), 'Week 4 review');
  await persistence.rename(ownerA, recording.id, '   ');
  const fallback = await repository.loadDrawingData(ownerA.workspaceId, ownerA.notebookId, ownerA.pageId);
  assert.equal(audioNoteTitle(fallback.audioNotes![0]), recording.fileName);
});

test('stored audio bytes and authoritative MIME survive playback blob reconstruction unchanged', async () => {
  const stored = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]).buffer;
  const blob = createPlaybackBlob(stored, 'audio/webm;codecs=opus', 'audio/ogg');
  assert.equal(blob.type, 'audio/webm;codecs=opus');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(stored));
  assert.throws(() => createPlaybackBlob(new ArrayBuffer(0), 'audio/webm'), /empty/i);
});

test('voice-note resize bounds support a compact but usable card', () => {
  assert.deepEqual(clampVoiceNoteSize(20, 30), { width: VOICE_NOTE_MIN_WIDTH, height: VOICE_NOTE_MIN_HEIGHT });
  assert.ok(VOICE_NOTE_MIN_WIDTH < 220);
  assert.ok(VOICE_NOTE_MIN_HEIGHT < 112);
  assert.deepEqual(clampVoiceNoteSize(240, 140), { width: 240, height: 140 });
});

test('recording MIME negotiation, extension derivation, and device errors are deterministic', () => {
  assert.equal(negotiateRecordingMimeType(type => type === 'audio/ogg;codecs=opus'), 'audio/ogg;codecs=opus');
  assert.equal(negotiateRecordingMimeType(() => false), undefined);
  assert.equal(audioFileExtension('audio/webm;codecs=opus'), 'webm');
  assert.equal(audioFileExtension('audio/mp4'), 'm4a');
  assert.match(recordingErrorMessage(new DOMException('', 'NotAllowedError')), /permission was denied/i);
  assert.match(recordingErrorMessage(new DOMException('', 'NotFoundError')), /No microphone/i);
  assert.match(recordingErrorMessage(new DOMException('', 'NotReadableError')), /busy/i);
  assert.match(recordingErrorMessage(new DOMException('', 'NotSupportedError')), /not supported/i);
  assert.match(recordingErrorMessage({ error: new DOMException('', 'NotAllowedError') }), /permission was denied/i);
  assert.match(recordingErrorMessage(new DOMException('', 'RecordingInterruptedError')), /interrupted/i);
});

test('recorder creation falls back to the browser default when MIME probing is unavailable or inaccurate', () => {
  class FallbackRecorder extends FakeRecorder {
    static isTypeSupported = () => false;
    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      super();
      if (options) throw new Error('MIME option rejected');
    }
  }
  const recorder = createSupportedMediaRecorder({} as MediaStream, FallbackRecorder as any);
  assert.ok(recorder instanceof FallbackRecorder);
  assert.equal(resolvePlaybackMimeType(' audio/ogg; codecs=opus ', 'audio/webm'), 'audio/ogg; codecs=opus');
  assert.equal(resolvePlaybackMimeType('application/octet-stream', 'audio/webm'), 'audio/webm');
  assert.equal(resolvePlaybackMimeType('text/plain', 'application/octet-stream'), undefined);
});

test('voice-note object geometry and metadata survive page persistence and movement', async () => {
  const repository = new MemoryDrawingRepository();
  const persistence = new PageAudioPersistenceCoordinator(repository);
  const recording = note('voice-one');
  const object = createVoiceNoteObject(recording);
  const initial = await persistence.appendVoiceNote(ownerA, recording, object);
  assert.ok(initial.objects?.some(item => isVoiceNoteObject(item) && item.metadata.audioNoteId === recording.id));
  const moved = {
    ...initial,
    objects: initial.objects?.map(item => isVoiceNoteObject(item)
      ? { ...item, x: item.x + 42, y: item.y + 18, width: 360, height: 180 }
      : item),
  };
  await persistence.saveDrawing(ownerA, moved);
  const reopened = await repository.loadDrawingData(ownerA.workspaceId, ownerA.notebookId, ownerA.pageId);
  const restored = reopened.objects?.find(item => isVoiceNoteObject(item));
  assert.ok(restored && isVoiceNoteObject(restored));
  assert.deepEqual({ x: restored.x, y: restored.y, width: restored.width, height: restored.height }, { x: object.x + 42, y: object.y + 18, width: 360, height: 180 });
  assert.equal(reopened.audioNotes?.[0]?.fileId, recording.fileId);
});

test('multiple persisted voice-note objects can be removed independently', async () => {
  const repository = new MemoryDrawingRepository();
  const persistence = new PageAudioPersistenceCoordinator(repository);
  const first = note('voice-first');
  const second = note('voice-second');
  await persistence.appendVoiceNote(ownerA, first, createVoiceNoteObject(first, 0));
  await persistence.appendVoiceNote(ownerA, second, createVoiceNoteObject(second, 1));
  const before = await repository.loadDrawingData(ownerA.workspaceId, ownerA.notebookId, ownerA.pageId);
  assert.equal(before.objects?.filter(item => isVoiceNoteObject(item)).length, 2);
  await persistence.removeVoiceNote(ownerA, first.id);
  const after = await repository.loadDrawingData(ownerA.workspaceId, ownerA.notebookId, ownerA.pageId);
  assert.deepEqual(after.audioNotes?.map(item => item.id), [second.id]);
  assert.deepEqual(after.objects?.filter(item => isVoiceNoteObject(item)).map(item => item.metadata.audioNoteId), [second.id]);
});

test('canvas voice-note blocks retain the canvas captured at recording start', () => {
  const block = createCanvasVoiceNoteBlock('canvas-a', 'asset-a', 'audio-a', 'canvas-a.webm', 'audio/webm;codecs=opus', 1250);
  assert.equal(block.canvasFileId, 'canvas-a');
  assert.equal(block.type, 'audio');
  assert.equal(block.metadata?.audioFileId, 'asset-a');
  assert.equal(block.metadata?.audioNoteId, 'audio-a');
});

test('canvas voice note visibility uses active Canvas ownership even when canvas data is untouched', async () => {
  const canvasOwner = { workspaceId: 'workspace-real', notebookId: 'canvas-new', pageId: 'canvas-new' };
  assert.equal(isActiveCanvasAudioOwner('canvas-new', canvasOwner), true);
  assert.equal(isActiveCanvasAudioOwner('canvas-other', canvasOwner), false);

  const source = await readFile('src/components/canvas/CanvasAudioControl.tsx', 'utf8');
  assert.match(source, /isActiveCanvasAudioOwner\(useWorkspaceStore\.getState\(\)\.activeCanvasId, result\.owner\)/);
  assert.doesNotMatch(source, /currentData\?\.canvasFileId === result\.owner\.pageId/);
});

test('canvas voice-note recording reuses MIME fallback negotiation', async () => {
  const source = await readFile('src/components/canvas/CanvasAudioControl.tsx', 'utf8');
  assert.match(source, /recorder\.mimeType \|\| negotiateRecordingMimeType/);
  assert.match(source, /selectedMimeType,/);
});

test('canvas voice-note placement centers the card in the actual transformed viewport', () => {
  const position = getCanvasVoiceNoteViewportPosition(
    { width: 800, height: 600 },
    { scrollX: -100, scrollY: 50, zoom: { value: 2 } },
  );
  assert.deepEqual(position, { x: 150, y: 34 });

  const cardCenter = {
    x: (position.x - 100) * 2 + 300,
    y: (position.y + 50) * 2 + 132,
  };
  assert.deepEqual(cardCenter, { x: 400, y: 300 });
});

class FakeAudio {
  src = '';
  currentTime = 0;
  duration = 12;
  preload = '';
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pauses = 0;
  loads = 0;
  operations: string[] = [];
  async play() { this.operations.push('play'); this.onplay?.(); }
  pause() { this.operations.push('pause'); this.pauses += 1; this.onpause?.(); }
  load() { this.operations.push(`load:${this.src}`); this.loads += 1; }
}

test('controlled playback supports play, pause, resume, seek, end, and one active object URL', async () => {
  const audio = new FakeAudio();
  const created: string[] = [];
  const revoked: string[] = [];
  const player = new AudioPlaybackController(audio as any, {
    createObjectURL: () => { const url = `blob:${created.length + 1}`; created.push(url); return url; },
    revokeObjectURL: url => { assert.equal(audio.src, ''); revoked.push(url); },
  });
  await player.play('one', new Blob(['one'], { type: 'audio/webm' }), 5000);
  audio.onloadedmetadata?.();
  assert.equal(player.getState().status, 'playing');
  assert.equal(player.getState().durationMs, 12000);
  player.pause();
  assert.equal(player.getState().status, 'paused');
  await player.resume();
  player.seek(4250);
  assert.equal(audio.currentTime, 4.25);
  audio.onended?.();
  assert.equal(player.getState().status, 'ended');

  await player.play('two', new Blob(['two'], { type: 'audio/ogg' }));
  assert.deepEqual(created, ['blob:1', 'blob:2']);
  assert.deepEqual(revoked, ['blob:1']);
  assert.ok(audio.operations.includes('load:'));
  assert.ok(audio.operations.lastIndexOf('load:') < audio.operations.lastIndexOf('load:blob:2'));
  assert.equal(player.getState().activeNoteId, 'two');
  player.destroy();
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
  assert.equal(audio.src, '');
});

test('production page utilities keep audio reachable in compact and Read modes', async () => {
  const utilities = await readFile(new URL('../src/components/notebook/NotebookPageUtilities.tsx', import.meta.url), 'utf8');
  const notebook = await readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8');
  const audio = await readFile(new URL('../src/components/notebook/NotebookAudioControl.tsx', import.meta.url), 'utf8');
  assert.match(utilities, /<NotebookAudioControl/);
  assert.match(utilities, /canRecord=\{editable\}/);
  assert.match(utilities, /if \(!compact\)/);
  assert.doesNotMatch(notebook, /workspaceViewMode === 'edit' && <NotebookPageUtilities/);
  assert.match(audio, /Playback is available in Read mode/);
  assert.doesNotMatch(audio, /<audio\b/);
});

test('production CSP permits local blob audio and only the Google authorization frame origin', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /media-src 'self' blob:/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-src https:\/\/accounts\.google\.com\/gsi\//);
  assert.doesNotMatch(html, /frame-src[^;]*\*/);
});

test('voice-note rename controls use semantic foreground tokens in light and dark themes', async () => {
  const floating = await readFile(new URL('../src/components/notebook/NotebookVoiceNote.tsx', import.meta.url), 'utf8');
  const utilities = await readFile(new URL('../src/components/notebook/NotebookAudioControl.tsx', import.meta.url), 'utf8');
  for (const source of [floating, utilities]) {
    assert.match(source, /aria-label="Voice note name"[^>]*\/|text-panvas-text-primary[^>]*aria-label="Voice note name"/);
  }
  assert.doesNotMatch(floating, /aria-label="(?:Save|Cancel) voice note name"[^>]*className="[^"]*text-white/);
  assert.doesNotMatch(utilities, /aria-label="(?:Save|Cancel) voice note name"[^>]*className="[^"]*text-white/);
  // Card foreground follows persisted document color, not the application theme.
  assert.match(floating, /const style = voiceNoteStyle\(object, offset\)/);
  assert.match(floating, /style=\{\{ \.\.\.style/);
  assert.match(utilities, /text-panvas-text-secondary hover:text-panvas-text-primary/);
});

test('canvas voice-note controls mirror the Page voice-note theme-safe interaction contract', async () => {
  const canvas = await readFile('src/components/canvas/CanvasVoiceNote.tsx', 'utf8');
  for (const token of [
    'text-panvas-text-primary',
    'text-panvas-text-secondary hover:text-panvas-text-primary',
    'text-panvas-text-tertiary hover:text-panvas-text-error',
    'bg-panvas-bg-primary',
    'border-panvas-border-strong',
    'focus-ring',
    'accent-panvas-accent-blue',
    'tabular-nums',
  ]) assert.match(canvas, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const label of ['Rename voice note', 'Voice note name', 'Save voice note name', 'Cancel voice note name', 'Delete voice note', 'Resize voice note']) {
    assert.match(canvas, new RegExp(`aria-label="${label}"`));
  }
  assert.match(canvas, /min-w-0 flex-1 truncate text-xs font-semibold text-panvas-text-primary/);
  assert.doesNotMatch(canvas, /text-white/);
});

test('drawing persistence coordinator isolates different notebooks and pages under concurrent writes', async () => {
  const repository = new MemoryDrawingRepository();
  const persistence = new PageAudioPersistenceCoordinator(repository);

  const notebookAOwner = { workspaceId: 'ws-1', notebookId: 'nb-A', pageId: 'page-A1' };
  const notebookBOwner = { workspaceId: 'ws-1', notebookId: 'nb-B', pageId: 'page-B1' };

  const dataA = createEmptyDrawingData();
  dataA.elements = [{ id: 'elem-A1' } as any];
  const dataB = createEmptyDrawingData();
  dataB.elements = [{ id: 'elem-B1' } as any];

  // Concurrent saves to distinct notebooks
  await Promise.all([
    persistence.saveDrawing(notebookAOwner, dataA),
    persistence.saveDrawing(notebookBOwner, dataB),
  ]);

  const readA = await repository.loadDrawingData('ws-1', 'nb-A', 'page-A1');
  const readB = await repository.loadDrawingData('ws-1', 'nb-B', 'page-B1');

  assert.equal(readA.elements[0]?.id, 'elem-A1');
  assert.equal(readB.elements[0]?.id, 'elem-B1');
  assert.equal(repository.saves.includes('ws-1/nb-A/page-A1'), true);
  assert.equal(repository.saves.includes('ws-1/nb-B/page-B1'), true);
});
