import { workspaceRepository } from '../../src/repositories/WorkspaceRepository';
import { notebookRepository } from '../../src/repositories/NotebookRepository';
import { canvasRepository } from '../../src/repositories/CanvasRepository';
import { useWorkspaceStore } from '../../src/stores/workspaceStore';
import { useUIStore } from '../../src/stores/uiStore';
import { db } from '../../src/database/schema';
import { createDefaultDrawingData } from '../../src/components/notebook/engine/drawingTypes';
import { PDFDocument } from 'pdf-lib';

const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;
async function seed() {
  const step = (value: string) => { (window as any).backupSeedStep = value; console.log('backup-seed', value); }; step('workspace');
  const workspace = await workspaceRepository.create(null, 'Asset portability proof');
  const book = await notebookRepository.create(null, workspace.id, null, 'Portable research');
  const section = await notebookRepository.createSection(null, workspace.id, book.id, 'Mixed notes');
  const doc = await notebookRepository.createPage(null, workspace.id, book.id, section.id, 'Rich A4');
  const infinite = await notebookRepository.createPage(null, workspace.id, book.id, section.id, 'Infinite proof');
  const free = await notebookRepository.createPage(null, workspace.id, book.id, section.id, 'Ink and audio');
  const pdf = await PDFDocument.create(); pdf.addPage([400, 500]).drawText('Original PDF page one', { x: 40, y: 440, size: 18 }); pdf.addPage([400, 500]).drawText('Original PDF page two', { x: 40, y: 440, size: 18 });
  const pdfFile = await canvasRepository.storePdf(null, free.id, 'reference.pdf', buffer(await pdf.save()));
  const imported = await notebookRepository.createPage(null, workspace.id, book.id, section.id, 'Imported PDF', 'pdf', pdfFile.id);
  step('assets');
  const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#38a169'; ctx.fillRect(0, 0, 160, 100); ctx.fillStyle = '#fff'; ctx.font = '18px sans-serif'; ctx.fillText('Asset canary', 12, 55);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!)));
  const image = await canvasRepository.storeImage(null, doc.id, 'canary.png', 'image/png', await blob.arrayBuffer());
  const wav = new Uint8Array(1644), view = new DataView(wav.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) [...text].forEach((c, i) => wav[offset + i] = c.charCodeAt(0));
  view.setUint32(4, wav.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 1600, true);
  const audio = await canvasRepository.storeAudio(null, free.id, 'proof.wav', 'audio/wav', wav.buffer);
  const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const rich = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1, blockId: 'portable-heading' }, content: [{ type: 'text', text: 'Portable documentation' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Bold italic purple link', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'highlight', attrs: { color: '#b197fc' } }, { type: 'textStyle', attrs: { color: '#123456' } }, { type: 'link', attrs: { href: `https://example.com/app?panvasPage=${infinite.id}&panvasBlock=target-heading` } }] }] },
    { type: 'image', attrs: { fileId: image.id, alt: 'Asset canary', width: 160, height: 100 } },
    { type: 'codeBlock', attrs: { language: 'rust', wrap: true }, content: [{ type: 'text', text: 'fn main() { println!("portable"); }' }] },
    { type: 'blockMath', attrs: { latex: 'E=mc^2' } },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph('Ownership')] }, { type: 'tableHeader', content: [paragraph('Result')] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('Borrowing')] }, { type: 'tableCell', content: [paragraph('Preserved')] }] }] },
    { type: 'paragraph', content: [{ type: 'pageReference', attrs: { targetPageId: infinite.id, targetBlockId: 'target-heading', label: 'Infinite proof' } }] },
    ...Array.from({ length: 24 }, (_, i) => paragraph(`A4 continuation ${i + 1}: selectable text survives each printable sheet.`)),
  ] };
  for (const page of [doc, infinite, free, imported]) {
    step(page.title);
    const data = createDefaultDrawingData({ layoutMode: page === free || page === imported ? 'freeform' : 'document', pageSize: page === infinite ? 'Infinite' : 'A4', margins: 'Normal' } as any);
    if (page === doc || page === infinite) data.objects.push({ id: `${page.id}-body`, type: 'text', x: 64, y: 64, width: 666, height: 500, createdAt: 1,
      metadata: { documentRole: 'body', richTextSchemaVersion: 3 }, content: page === doc ? rich : { type: 'doc', content: [{ type: 'heading', attrs: { level: 2, blockId: 'target-heading' }, content: [{ type: 'text', text: 'Infinite target' }] }, ...Array.from({ length: 45 }, (_, i) => paragraph(`Infinite paragraph ${i + 1}: retained content.`))] } } as any);
    if (page === free) {
      data.objects.push({ id: 'positioned-image', type: 'image', x: 50, y: 80, width: 160, height: 100, rotation: 0, opacity: 1, fileId: image.id, createdAt: 1 } as any);
      data.objects.push({ id: 'ink-canary', type: 'stroke', tool: 'pen', color: '#e03131', thickness: 5, opacity: 1, createdAt: 1, points: [{ x: 30, y: 40, pressure: .3, t: 1 }, { x: 200, y: 90, pressure: .8, t: 2 }] } as any);
      data.audioNotes = [{ id: 'audio-proof', fileId: audio.id, fileName: 'proof.wav', mimeType: 'audio/wav', createdAt: 1 }];
    }
    await notebookRepository.saveDrawingData(workspace.id, book.id, page.id, data);
    if (page.type !== 'pdf') await notebookRepository.setPagePropertyOverrides(workspace.id, page.id, data.properties);
  }
  const annotation = createDefaultDrawingData(); annotation.objects.push({ id: 'pdf-ink', type: 'stroke', tool: 'pen', color: '#1971c2', thickness: 4, opacity: 1, createdAt: 1, points: [{ x: 50, y: 40, pressure: .5, t: 1 }, { x: 220, y: 90, pressure: .7, t: 2 }] } as any);
  await notebookRepository.saveDrawingData(workspace.id, book.id, `${imported.id}_pdf_2`, annotation);
  step('canvas');
  const board = await canvasRepository.create(null, workspace.id, null, null, null, 'Portable canvas');
  await canvasRepository.addBlock(null, { canvasFileId: board.id, type: 'pdf', x: 0, y: 0, width: 320, height: 400, content: pdfFile.id, metadata: { pdfDataId: pdfFile.id } } as any);
  await canvasRepository.saveData(null, { canvasFileId: board.id, elements: [], appState: {}, files: { 'inline-canary': { id: 'inline-canary', dataURL: canvas.toDataURL(), mimeType: 'image/png', created: 1 } }, customBlocks: await canvasRepository.loadBlocks(null, board.id) }, workspace.id);
  await useWorkspaceStore.getState().loadWorkspaces(); await useWorkspaceStore.getState().setActiveWorkspace(workspace.id);
  step('complete');
  return { workspaceId: workspace.id, pages: [doc, infinite, free, imported] };
}
async function preparePdfCases() {
  const state = useWorkspaceStore.getState(), workspaceId = state.activeWorkspaceId!, book = state.notebooks.find(item => item.workspaceId === workspaceId)!, section = state.notebookSections.find(item => item.notebookId === book.id)!;
  const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const originalPage = state.notebookPages.find(page => page.title === 'Rich A4')!;
  const original = await notebookRepository.loadDrawingData(workspaceId, book.id, originalPage.id);
  for (const paper of ['A3', 'A5', 'Letter'] as const) {
    const page = await notebookRepository.createPage(null, workspaceId, book.id, section.id, `Rich ${paper}`);
    const drawing = structuredClone(original); drawing.properties.pageSize = paper;
    const body = drawing.objects.find((object: any) => object.metadata?.documentRole === 'body'); body.id = `${page.id}-body`;
    body.content.content = [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: `${paper} fidelity proof` }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Underline and foreground', marks: [{ type: 'underline' }, { type: 'textStyle', attrs: { color: '#c92a2a' } }] }, { type: 'text', text: ' with inline equation ' }, { type: 'inlineMath', attrs: { latex: '\\frac{a}{b}+\\sqrt{x}' } }] },
      { type: 'blockMath', attrs: { latex: '\\sum_{n=1}^{\\infty}\\frac{1}{n^2}=\\frac{\\pi^2}{6}' } },
      { type: 'bulletList', content: [1, 2].map(n => ({ type: 'listItem', content: [paragraph(`Bullet item ${n}`)] })) },
      { type: 'orderedList', attrs: { start: 3 }, content: [3, 4].map(n => ({ type: 'listItem', content: [paragraph(`Ordered item ${n}`)] })) },
      { type: 'taskList', content: [true, false].map(checked => ({ type: 'taskItem', attrs: { checked }, content: [paragraph(checked ? 'Checked proof' : 'Unchecked proof')] })) },
      { type: 'callout', attrs: { tone: 'note', icon: 'i' }, content: [paragraph('Callout content remains visible.')] },
      { type: 'details', attrs: { open: false }, content: [{ type: 'detailsSummary', content: [{ type: 'text', text: 'Collapsed toggle summary' }] }, { type: 'detailsContent', content: [paragraph('Hidden toggle content is included in export.')] }] },
      { type: 'codeBlock', attrs: { language: 'typescript', wrap: false }, content: [{ type: 'text', text: 'const unicode = "Ω 漢";\n' + Array.from({ length: 14 }, (_, i) => `const line${i + 1} = "${'long_code_token_'.repeat(5)}end${i + 1}";`).join('\n') }] },
      { type: 'table', content: Array.from({ length: 15 }, (_, i) => ({ type: 'tableRow', content: [1, 2, 3].map(n => ({ type: i === 0 ? 'tableHeader' : 'tableCell', content: [paragraph(`Row ${i + 1} column ${n}: wrapped cell content remains complete.`)] })) })) },
      ...body.content.content.slice(0, 7), paragraph(`${paper} final sentinel`),
    ];
    await notebookRepository.saveDrawingData(workspaceId, book.id, page.id, drawing); await notebookRepository.setPagePropertyOverrides(workspaceId, page.id, drawing.properties);
  }
  const widePage = await notebookRepository.createPage(null, workspaceId, book.id, section.id, 'Infinite wide');
  const infinite = state.notebookPages.find(page => page.title === 'Infinite proof')!;
  const wide = await notebookRepository.loadDrawingData(workspaceId, book.id, infinite.id);
  wide.properties.infiniteWidth = 1123;
  wide.objects.push({ id: 'wide-edge-image', type: 'image', fileId: original.objects[0].content.content.find((node: any) => node.type === 'image').attrs.fileId,
    x: 900, y: 1300, width: 160, height: 100, rotation: 0, opacity: 1, createdAt: 1 });
  await notebookRepository.saveDrawingData(workspaceId, book.id, widePage.id, wide); await notebookRepository.setPagePropertyOverrides(workspaceId, widePage.id, wide.properties);
  await state.loadWorkspaceContents(workspaceId);
}
Object.assign(window, { backupProbe: { seed, state: () => ({ workspaceId: useWorkspaceStore.getState().activeWorkspaceId, toast: useUIStore.getState().toast }),
  preparePdfCases,
  workspaces: () => workspaceRepository.getAll(null),
  clearToast: () => useUIStore.getState().clearToast(),
  verifyAssets: async () => {
    const state = useWorkspaceStore.getState(), workspaceId = state.activeWorkspaceId!;
    const pages = state.notebookPages.filter(page => state.notebooks.some(book => book.id === page.notebookId && book.workspaceId === workspaceId));
    const rich = pages.find(page => page.title === 'Rich A4')!, free = pages.find(page => page.title === 'Ink and audio')!, imported = pages.find(page => page.type === 'pdf')!;
    const drawing = await notebookRepository.loadDrawingData(workspaceId, rich.notebookId, rich.id);
    const id = drawing.objects[0].content.content.find((node: any) => node.type === 'image').attrs.fileId;
    const image = await canvasRepository.getImage(id), bitmap = await createImageBitmap(new Blob([image!.data], { type: image!.mimeType }));
    const dimensions = [bitmap.width, bitmap.height]; bitmap.close();
    const freeDrawing = await notebookRepository.loadDrawingData(workspaceId, free.notebookId, free.id), audio = await canvasRepository.getAudio(freeDrawing.audioNotes[0].fileId);
    const context = new OfflineAudioContext(1, 800, 8000), sound = await context.decodeAudioData(audio!.data.slice(0));
    const pdf = await canvasRepository.getPdf(null, imported.pdfDataId!);
    const annotation = await notebookRepository.loadDrawingData(workspaceId, imported.notebookId, `${imported.id}_pdf_2`);
    return { image: dimensions, audioSamples: sound.length, pdfPages: (await PDFDocument.load(pdf!.data)).getPageCount(), annotationStrokes: annotation.objects.filter((object: any) => object.type === 'stroke').length };
  },
  browserRollback: async () => {
    const { collectBrowserWorkspaceBackup, restoreBrowserWorkspaceBackup } = await import('../../src/services/backup/backupBrowserStorage');
    const backup = await collectBrowserWorkspaceBackup(useWorkspaceStore.getState().activeWorkspaceId!, null), before = await db.workspaces.count();
    const fail = () => { throw new Error('Injected asset write failure'); }; db.imageFiles.hook('creating', fail);
    try { await restoreBrowserWorkspaceBackup(backup, null); throw new Error('Restore unexpectedly succeeded'); }
    catch (error) { if (!(error as Error).message.includes('Injected asset')) throw error; }
    finally { db.imageFiles.hook('creating').unsubscribe(fail); }
    return { before, after: await db.workspaces.count() };
  },
} });
if (!window.panvas) history.replaceState(null, '', '/app/library');
else localStorage.setItem('panvas.dexieMigration.canonicalDestinations.v1', 'true');
