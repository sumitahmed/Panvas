import React from 'react';
import { createRoot } from 'react-dom/client';
import * as pdfjs from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { AppShell } from '../../src/components/layout/AppShell';
import { NotebookRenderer } from '../../src/components/notebook/NotebookRenderer';
import type { NotebookEngine } from '../../src/components/notebook/engine/NotebookEngine';
import { createEmptyDrawingData } from '../../src/components/notebook/engine/drawingTypes';
import { AppearanceSection } from '../../src/components/settings/sections/AppearanceSection';
import { notebookRepository } from '../../src/repositories/NotebookRepository';
import { useWorkspaceStore } from '../../src/stores/workspaceStore';
import { useUIStore } from '../../src/stores/uiStore';
import { exportNotebookPdf } from '../../src/services/pdf/notebookPdfExport';
import { presentationImage } from '../../src/lib/themePresentation';
import '../../src/styles/index.css';
import '../../src/styles/editor-fonts.css';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

async function mount() {
  const store = useWorkspaceStore.getState;
  const workspace = await store().createWorkspace('Theme review');
  await store().setActiveWorkspace(workspace.id);
  const notebook = await store().createNotebook(null, 'Writing tablet');
  const page = store().notebookPages.find(item => item.notebookId === notebook.id)!;
  const drawing = createEmptyDrawingData();
  Object.assign(drawing.properties, { template: 'Blank', paperColor: '#FFF9C4', ruleLineColor: '#55718e', margins: 'No Margin' });
  drawing.objects = [
    { id: 'red', type: 'shape', shapeType: 'rectangle', x: 180, y: 260, width: 140, height: 100, color: '#ff0000', fill: '#ff0000', strokeWidth: 1, rotation: 0, createdAt: 0 },
    { id: 'text', type: 'text', x: 180, y: 400, width: 400, createdAt: 0,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Paper stays yours.',
        marks: [{ type: 'textStyle', attrs: { color: '#0066cc', fontSize: '30px' } }] }] }] } },
  ];
  await notebookRepository.saveDrawingData(workspace.id, notebook.id, page.id, drawing);
  await notebookRepository.setPagePropertyOverrides(workspace.id, page.id, drawing.properties);
  await store().loadWorkspaceContents(workspace.id);
  store().setActivePage(page.id);
  useUIStore.setState({ isPropertiesPanelOpen: false });
  let engine: NotebookEngine;
  Object.assign(window, {
    themeFixture: {
      id: page.id,
      engine: () => engine,
      data: () => engine.getDrawingData(),
      theme: (theme: 'light' | 'ink' | 'dark') => useUIStore.getState().setTheme(theme),
      async exportPixels() {
        const data = engine.getDrawingData();
        const result = await exportNotebookPdf({ pages: [{ id: page.id, title: page.title, drawing: data, properties: data.properties }] });
        if (!result.bytes || !result.success) throw new Error(result.error || 'Export failed');
        const document = await pdfjs.getDocument({ data: result.bytes }).promise;
        try {
          const pdfPage = await document.getPage(1);
          const viewport = pdfPage.getViewport({ scale: 794 / pdfPage.view[2] });
          const canvas = window.document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext('2d')!;
          await pdfPage.render({ canvasContext: context, viewport }).promise;
          const pixel = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data);
          return { red: pixel(240, 310), paper: pixel(30, 285), warnings: result.warnings, width: canvas.width, height: canvas.height };
        } finally { await document.destroy(); }
      },
      async imagePixels() {
        const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 2;
        const context = canvas.getContext('2d')!; context.fillStyle = '#ff0000'; context.fillRect(0, 0, 4, 2);
        const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
        const original = new Uint8Array(await blob.arrayBuffer()); const before = Array.from(original);
        const output = await presentationImage({ mimeType: 'image/png', data: original }, 'ink');
        const bitmap = await createImageBitmap(new Blob([output.data as ArrayBuffer], { type: output.mimeType }));
        context.clearRect(0, 0, 4, 2); context.drawImage(bitmap, 0, 0);
        const result = { pixel: Array.from(context.getImageData(1, 1, 1, 1).data), width: bitmap.width, height: bitmap.height, unchanged: JSON.stringify(before) === JSON.stringify(Array.from(original)) };
        bitmap.close(); return result;
      },
    },
  });
  createRoot(document.getElementById('root')!).render(
    <AppShell>{new URLSearchParams(location.search).has('appearance')
      ? <div className="mx-auto max-w-3xl p-8"><AppearanceSection /></div>
      : <NotebookRenderer onEngineReady={value => { engine = value; }} />}
    </AppShell>,
  );
}
void mount();
