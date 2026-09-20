import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TextManager } from '../src/components/notebook/engine/TextManager.ts';
import { AudioNoteManager } from '../src/components/notebook/engine/AudioNoteManager.ts';
import { HistoryManager } from '../src/components/notebook/engine/HistoryManager.ts';
import { applyNotebookTextFont, textObjectStyle, withTextFont } from '../src/components/notebook/textTypography.ts';
import { createVoiceNoteObject, voiceNoteStyle, clampVoiceNoteRect } from '../src/services/audio/voiceNoteObjects.ts';
import { captureVoiceState, changeVoiceNote, changeVoiceObject } from '../src/services/audio/voiceNoteCommands.ts';
import { PageAudioPersistenceCoordinator } from '../src/services/audio/pageAudioPersistence.ts';
import { createEmptyDrawingData } from '../src/components/notebook/engine/drawingTypes.ts';

const note = { id: 'note', fileId: 'durable-asset', fileName: 'recording.webm', title: 'Lecture', createdAt: 1, mimeType: 'audio/webm' };
function engineFixture() {
  const texts = new TextManager(); const audio = new AudioNoteManager(); const history = new HistoryManager();
  let selected: any[] = []; let changes = 0;
  return { texts, audio, history, selection: { getSelectedElements: () => selected, clearSelection: () => { selected = []; }, selectElement: (id: string, type: string) => { selected = [{ id, type }]; } }, input: { notifyChange: () => { changes++; } }, changes: () => changes };
}
test('selected text font reaches persisted marks and editing painter with independent size and undo/redo', () => {
  const engine = engineFixture();
  const object = { id: 'text', type: 'text' as const, createdAt: 1, x: 0, y: 0, width: 300,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'the', marks: [{ type: 'textStyle', attrs: { fontSize: '32px', color: '#123456' } }] }] }] } };
  engine.texts.addText(object); engine.selection.selectElement('text', 'text');
  let painted: any;
  engine.texts.registerEditor('text', { isDestroyed: false, commands: { setContent: (content: any) => { painted = content; }, blur: () => {} } });
  for (const family of ['Inter, sans-serif', "'Comic Sans MS', cursive", "'Times New Roman', serif", "'JetBrains Mono', monospace", "'Kalam', cursive", "'Dancing Script', cursive"]) {
    applyNotebookTextFont(engine as any, family);
    const saved = JSON.parse(JSON.stringify(engine.texts.getTexts()[0]));
    assert.equal(textObjectStyle(saved).fontFamily, family);
    const attrs = painted.content[0].content[0].marks[0].attrs;
    assert.equal(attrs.fontFamily, family); assert.equal(attrs.fontSize, '32px'); assert.equal(attrs.color, '#123456');
  }
  engine.history.undo(); assert.equal(textObjectStyle(engine.texts.getTexts()[0]).fontFamily, "'Kalam', cursive");
  engine.history.redo(); assert.equal(textObjectStyle(engine.texts.getTexts()[0]).fontFamily, "'Dancing Script', cursive");
  assert.ok(engine.changes() >= 8);
});
test('font default does not rewrite unrelated objects and all notebook painters consume the shared font', async () => {
  const engine = engineFixture(); engine.texts.addText({ id: 'other', type: 'text', createdAt: 1, x: 0, y: 0, width: 100, content: { type: 'doc' } });
  applyNotebookTextFont(engine as any, "'Kalam', cursive");
  assert.equal(engine.texts.getDefaultFontFamily(), "'Kalam', cursive"); assert.equal(engine.texts.getTexts()[0].fontFamily, undefined);
  for (const file of ['FloatingTextEditor.tsx', 'StaticTextPreview.tsx', 'InactivePagePreview.tsx']) {
    const source = await readFile(`src/components/notebook/${file}`, 'utf8'); assert.match(source, /\.\.\.textObjectStyle\(object\)/);
  }
  assert.match(await readFile('src/components/notebook/engine/InputManager.ts', 'utf8'), /fontFamily: this.textManager.getDefaultFontFamily\(\)/);
  assert.equal(textObjectStyle(engine.texts.getTexts()[0]).fontFamily, 'Inter, sans-serif');
});
test('voice color opacity and source offset are document styles and state changes do not alter geometry', () => {
  const object = createVoiceNoteObject(note); object.metadata.voiceColor = '#292a2e'; object.metadata.voiceOpacity = .5;
  const before = structuredClone(object); const style = voiceNoteStyle(object, { x: 140, y: 280 });
  assert.equal(style.left, object.x + 140); assert.equal(style.top, object.y + 280); assert.equal(style.opacity, .5); assert.equal(style.color, '#fafafa');
  assert.deepEqual(object, before); assert.equal(voiceNoteStyle(createVoiceNoteObject(note)).opacity, 1);
  assert.deepEqual(clampVoiceNoteRect({ x: -999, y: 9999, width: 20, height: 20 }, { x: -140, y: -140, width: 800, height: 1000 }), { x: -140, y: 776, width: 156, height: 84 });
});
test('canonical voice rename/style/delete commands preserve geometry and restore complete entities on undo', () => {
  const engine = engineFixture(); const object = createVoiceNoteObject(note); engine.texts.addText(object); engine.audio.add(note);
  let persisted: any; const persist = (state: any) => { persisted = state; };
  changeVoiceNote(engine as any, note.id, { title: 'Research thought' }, persist);
  assert.equal(persisted.notes[0].title, 'Research thought'); assert.equal(persisted.objects[0].x, object.x);
  changeVoiceObject(engine as any, object.id, { metadata: { ...object.metadata, voiceColor: '#dcecff', voiceOpacity: .3 } });
  assert.equal(voiceNoteStyle(engine.texts.getTexts()[0]).opacity, .3);
  changeVoiceNote(engine as any, note.id, { delete: true }, persist);
  assert.equal(engine.texts.getTexts().length, 0); assert.equal(engine.audio.getAll().length, 0); assert.equal(persisted.objects.length, 0);
  engine.history.undo(); assert.equal(captureVoiceState(engine as any).notes[0].fileId, 'durable-asset'); assert.equal(voiceNoteStyle(engine.texts.getTexts()[0]).opacity, .3);
  engine.history.redo(); assert.equal(engine.texts.getTexts().length, 0);
});
test('stale drawing saves cannot resurrect a deleted voice card and undo restores its durable reference', async () => {
  let disk = createEmptyDrawingData();
  const persistence = new PageAudioPersistenceCoordinator({ loadDrawingData: async () => structuredClone(disk), saveDrawingData: async (_w, _n, _p, data) => { disk = structuredClone(data); } });
  const owner = { workspaceId: 'w', notebookId: 'n', pageId: 'a' }; const object = createVoiceNoteObject(note);
  await persistence.appendVoiceNote(owner, note, object); const stale = structuredClone(disk);
  await persistence.removeVoiceNote(owner, note.id); await persistence.saveDrawing(owner, stale);
  assert.equal(disk.objects.length, 0); assert.equal(disk.audioNotes?.length, 0);
  await persistence.replaceVoiceState(owner, [note], [object]);
  assert.equal(disk.audioNotes?.[0].fileId, 'durable-asset'); assert.equal(disk.objects[0].id, object.id);
});
test('final inactive voice card emits saved color opacity coordinates and no missing-note zombie', async t => {
  const previousStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  t.after(() => { if (previousStorage) Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage }); else delete (globalThis as any).localStorage; });
  const [{ createServer }, React, { renderToStaticMarkup }, path] = await Promise.all([import('vite'), import('react'), import('react-dom/server'), import('node:path')]);
  const server = await createServer({ configFile: false, root: process.cwd(), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, resolve: { alias: { '@': path.resolve('src') } } });
  t.after(() => server.close());
  const { StaticVoiceNote } = await server.ssrLoadModule('/src/components/notebook/NotebookVoiceNote.tsx');
  const object = createVoiceNoteObject(note); object.metadata.voiceOpacity = .5; object.metadata.voiceColor = '#dcecff';
  const html = renderToStaticMarkup(React.createElement(StaticVoiceNote, { object, note, offset: { x: 140, y: 280 } }));
  assert.match(html, /opacity:0.5/); assert.match(html, /background-color:#dcecff/); assert.match(html, /left:212px/); assert.match(html, /Lecture/);
  assert.equal(renderToStaticMarkup(React.createElement(StaticVoiceNote, { object })), '');
});
