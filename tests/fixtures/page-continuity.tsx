import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { NotebookPageView } from '../../src/components/notebook/NotebookPageView';
import { NotebookEngine } from '../../src/components/notebook/engine/NotebookEngine';
import { createEmptyDrawingData } from '../../src/components/notebook/engine/drawingTypes';
import { residentPageIds } from '../../src/components/notebook/pageVisualWindow';
import { canvasRepository } from '../../src/repositories/CanvasRepository';
import '../../src/styles/index.css';
const engine = new NotebookEngine();
const asset = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>');
let loads = 0;
const pageImages = new Map();
const registerImages = (id: string, images: any) => images ? pageImages.set(id, images) : pageImages.delete(id);
canvasRepository.getImage = async () => { loads++; return { data: asset.buffer, mimeType: 'image/svg+xml' } as any; };
const data = Array.from({ length: 50 }, (_, i) => {
  const d = createEmptyDrawingData();
  d.objects = [
    { id: `ink-${i}`, type: 'stroke', tool: 'pen', color: '#0000ff', thickness: 5, opacity: 1, createdAt: 1, points: Array.from({ length: 300 }, (_, n) => ({ x: 10 + n, y: 160 + Math.sin(n / 10) * 20, pressure: .5, t: n })) },
    { id: `text-${i}`, type: 'text', x: 30, y: 40, width: 200, height: 40, createdAt: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Page ${i}`, marks: [{ type: 'bold' }] }] }] } },
    { id: `image-${i}`, type: 'image', fileId: `asset-${i}`, x: 40, y: 220, width: 40, height: 40, rotation: 0, opacity: 1, createdAt: 1 },
  ] as any;
  return d;
});
function Fixture() {
  const [state, setState] = useState({ count: 5, top: 0, focus: 0 });
  const positions = data.slice(0, state.count).map((_, i) => ({ id: String(i), x: 0, y: i * 700, width: 500, height: 680 }));
  const resident = residentPageIds(positions, state.top, 900);
  Object.assign(window, {
    continuityMove(count: number, top: number, focus: number) {
      engine.unmount();
      const images = pageImages.get(String(focus));
      if (images) engine.images.adoptDecodedImages(images, [`asset-${focus}`]);
      engine.setDrawingData(data[focus], String(focus));
      flushSync(() => setState({ count, top, focus }));
    },
    continuityEdit() {
      data[state.focus] = { ...data[state.focus], objects: [...data[state.focus].objects!.filter(object => object.id !== 'extra').map(object => object.type === 'text' ? { ...object, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Page ${state.focus} edited` }] }] } } : object), { id: 'extra', type: 'shape', shapeType: 'rectangle', x: 200, y: 250, width: 40, height: 40, color: '#00ff00', strokeWidth: 3, fill: '#00ff00', rotation: 0, opacity: 1, createdAt: 1 } as any] };
      engine.setDrawingData(data[state.focus], String(state.focus));
      flushSync(() => setState({ ...state }));
    },
    continuityStats: () => ({ loads, activeCache: (engine.images as any).imageCache.size, residentManagers: pageImages.size, decodedReferences: [...pageImages.values()].reduce((sum, images) => sum + images.imageCache.size, 0) + (engine.images as any).imageCache.size }),
  });
  return <>{positions.filter(p => resident.has(p.id) || p.id === String(state.focus)).map(p => <NotebookPageView
    key={p.id} onImageManagerReady={registerImages} page={{ id: p.id, notebookId: 'test', sectionId: 'test', title: p.id, type: 'default', createdAt: 1, updatedAt: 1, order: +p.id, userId: null }}
    data={data[+p.id]} properties={data[+p.id].properties} width={p.width} height={p.height} renderScale={1} pageNumberText={p.id}
    isFocused={p.id === String(state.focus)} toolState={engine.tools.getState()} notebookEngine={engine} sceneOwnerPageId={engine.getDrawingOwnership().pageId ?? ''}
    activeEditor={null} setActiveEditor={() => {}} onActivatePage={() => {}}
  />)}</>;
}
engine.setDrawingData(data[0], '0');
createRoot(document.getElementById('root')!).render(<Fixture />);
