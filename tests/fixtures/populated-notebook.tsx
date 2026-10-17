import React from 'react';
import { createRoot } from 'react-dom/client';
import { NotebookRenderer } from '../../src/components/notebook/NotebookRenderer';
import { NotebookEngine } from '../../src/components/notebook/engine/NotebookEngine';
import { DrawingEngine } from '../../src/components/notebook/engine/DrawingEngine';
import { ImageManager } from '../../src/components/notebook/engine/ImageManager';
import { PenGeometry, penGeometrySvg } from '../../src/components/notebook/engine/penGeometry';
import { createEmptyDrawingData } from '../../src/components/notebook/engine/drawingTypes';
import { notebookRepository } from '../../src/repositories/NotebookRepository';
import { canvasRepository } from '../../src/repositories/CanvasRepository';
import { useWorkspaceStore } from '../../src/stores/workspaceStore';
import { db } from '../../src/database/schema';
import { AppShell } from '../../src/components/layout/AppShell';
import '../../src/styles/index.css';

const timings: Record<string, number[]> = {};
for (const [prototype, methods] of [[NotebookEngine.prototype, ['setDrawingData', 'getDrawingData', 'mount', 'resize']],
  [DrawingEngine.prototype, ['redraw', 'renderStroke']], [ImageManager.prototype, ['setImages']]] as const) {
  for (const method of methods) {
    const original = (prototype as any)[method];
    (prototype as any)[method] = function (...args: any[]) {
      const start = performance.now();
      try { return original.apply(this, args); }
      finally { (timings[method] ??= []).push(performance.now() - start); }
    };
  }
}
async function mount() {
  const store = useWorkspaceStore.getState;
  const workspace = await store().createWorkspace('Disposable populated workload');
  await store().setActiveWorkspace(workspace.id);
  const notebook = await store().createNotebook(null, 'Populated notebook');
  const section = store().notebookSections.find(s => s.notebookId === notebook.id)!;
  const pages = [store().notebookPages.find(p => p.sectionId === section.id)!];
  for (let i = 1; i < 8; i++) pages.push(await notebookRepository.createPage(null, workspace.id, notebook.id, section.id, `Populated ${i + 1}`));
  const picture = document.createElement('canvas'); picture.width = 960; picture.height = 640;
  const context = picture.getContext('2d')!; context.fillStyle = '#fff9b0'; context.fillRect(0, 0, 960, 640);
  for (let i = 0; i < 60; i++) { context.fillStyle = i % 2 ? '#1e3a8a' : '#047857'; context.fillRect(i * 16, 30 + (i % 7) * 30, 12, 320); }
  const blob = await new Promise<Blob>(resolve => picture.toBlob(b => resolve(b!), 'image/png'));
  const originals: Record<string, unknown> = {};
  for (const [index, page] of pages.entries()) {
    const data = createEmptyDrawingData();
    data.objects = Array.from({ length: 1200 }, (_, i) => ({ id: `${page.id}-ink-${i}`, type: 'stroke' as const,
      tool: i % 19 ? 'pen' as const : 'highlighter' as const, centerline: 'polyline' as const,
      color: ['#b91c1c','#047857','#1d4ed8','#111827'][i % 4], thickness: 1 + i % 4,
      opacity: i % 19 ? 1 : .3, createdAt: i,
      points: Array.from({ length: 96 }, (_, j) => ({ x: 35 + (i % 8) * 84 + j * .62,
        y: 40 + Math.floor(i / 8) * 6.5 + Math.sin(j * .31 + i) * 3, pressure: .3 + (j % 20) / 40, t: j * 4 })) }));
    for (let i = 0; i < 3; i++) {
      const asset = await canvasRepository.storeImage(null, page.id, `fixture-${i}.png`, 'image/png', await blob.arrayBuffer());
      data.objects.push({ id: `${page.id}-image-${i}`, type: 'image', fileId: asset.id, x: 75 + i * 160, y: 80 + i * 230,
        width: 210, height: 140, rotation: 0, createdAt: 2000 + i });
    }
    data.objects.push({ id: `${page.id}-text`, type: 'text', x: 85, y: 650, width: 540, height: 210, createdAt: 3000,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Page ${index + 1}: positioned rich text with existing ink and images.`, marks: [{ type: 'bold' }] }] },
        { type: 'codeBlock', attrs: { language: 'typescript' }, content: [{ type: 'text', text: 'const sample = (n: number) => n * n;\nconsole.log(sample(42));' }] },
        { type: 'table', content: [{ type: 'tableRow', content: [1, 2].map(n => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Cell ${n}` }] }] })) }] }] } });
    await notebookRepository.saveDrawingData(workspace.id, notebook.id, page.id, data);
    originals[page.id] = data;
  }
  await store().loadWorkspaceContents(workspace.id); store().setActivePage(pages[0].id);
  let engine: NotebookEngine;
  Object.assign(window, { populated: { pages: pages.map(p => p.id), originals, engine: () => engine,
    transportChecks: async () => {
      const id = engine.getDrawingOwnership().pageId!, before = await notebookRepository.loadDrawingData(workspace.id, notebook.id, id);
      let foreignRejected = false;
      try { await notebookRepository.saveDrawingData(workspace.id, notebook.id, 'absent-page', before); } catch { foreignRejected = true; }
      let rolledBack = false;
      if (!window.panvas) {
        try {
          await db.transaction('rw', [db.notebooks, db.notebookSections, db.notebookPages, db.notebookPageDrawings], async () => {
            await notebookRepository.saveDrawingData(workspace.id, notebook.id, id, { ...before, properties: { ...before.properties, paperColor: '#ff0000' } });
            throw new Error('intentional-rollback');
          });
        } catch (error) { if ((error as Error).message !== 'intentional-rollback') throw error; rolledBack = true; }
      }
      const after = await notebookRepository.loadDrawingData(workspace.id, notebook.id, id);
      return { foreignRejected, rolledBack, unchanged: JSON.stringify(before) === JSON.stringify(after) };
    },
    geometryProbe: () => {
      const strokes = engine.drawing.getStrokes().filter(s => s.tool === 'pen').slice(0, 200);
      const first = document.createElement('canvas'), second = document.createElement('canvas'), third = document.createElement('canvas');
      first.width = second.width = third.width = 794; first.height = second.height = third.height = 1123;
      const a = first.getContext('2d')!, b = second.getContext('2d')!, c = third.getContext('2d')!;
      let directMs = 0, svgMs = 0, openMs = 0;
      for (const stroke of strokes) {
        let start = performance.now(); const path = new Path2D(), geometry = new PenGeometry(); geometry.update(stroke.points); geometry.trace(path, stroke); directMs += performance.now() - start;
        start = performance.now(); const svg = new Path2D(penGeometrySvg(stroke)); svgMs += performance.now() - start;
        start = performance.now(); const open = new Path2D(); geometry.trace(open,stroke,0,stroke.points.length,false); openMs += performance.now() - start;
        c.fill(open);
        a.fill(path); b.fill(svg);
      }
      const ap = a.getImageData(0, 0, 794, 1123).data, bp = b.getImageData(0, 0, 794, 1123).data, cp = c.getImageData(0, 0, 794, 1123).data;
      let channels = 0, total = 0, max = 0, openChannels = 0;
      for (let i = 0; i < ap.length; i++) { const delta = Math.abs(ap[i] - bp[i]); if(delta)channels++; total += delta; max = Math.max(max, delta); }
      for(let i=0;i<ap.length;i++)if(ap[i]!==cp[i])openChannels++;
      return { directMs, svgMs, openMs, openChannels, channels, total, max };
    },
    saved: (id: string) => notebookRepository.loadDrawingData(workspace.id, notebook.id, id),
    reset: () => { for (const key of Object.keys(timings)) delete timings[key]; (window as any).__PANVAS_GATE0_PROFILER__?.reset(); },
    report: () => structuredClone(timings) } });
  createRoot(document.getElementById('root')!).render(<AppShell><NotebookRenderer onEngineReady={next => { engine = next; }} /></AppShell>);
}
void mount();
