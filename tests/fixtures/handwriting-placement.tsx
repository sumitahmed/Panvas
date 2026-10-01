import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FloatingTextEditor } from '../../src/components/notebook/FloatingTextEditor';
import { StaticTextPreview } from '../../src/components/notebook/StaticTextPreview';
import { NotebookEngine } from '../../src/components/notebook/engine/NotebookEngine';
import { createEmptyDrawingData, type Stroke, type TextObject } from '../../src/components/notebook/engine/drawingTypes';
import { getHandwritingBounds, sanitizeHandwritingToolPreferences } from '../../src/services/beautification/handwritingBeautification';
import { loadTextFont } from '../../src/components/notebook/textFonts';
import '../../src/styles/index.css';
import '../../src/styles/editor-fonts.css';

type Source = { text: string; x: number; y: number; width: number; height: number };
let recognizedText = '';
const engine = new NotebookEngine({ recognitionProvider: {
  id: 'geometry-fixture', isAvailable: async () => true,
  recognize: async () => ({ status: 'success', text: recognizedText, isAvailable: true }),
} });

function Fixture() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [objects, setObjects] = useState<TextObject[]>([]);
  const [active, setActive] = useState(true);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    engine.mount(canvasRef.current!, 794, 1123);
    Object.assign(window, {
      placementReady: true,
      placementEngine: engine,
      placementFocus: (value: boolean) => setActive(value),
      placementZoom: (value: number) => setZoom(value),
      placementConvert: async (sources: Source[], mode: 'manual' | 'realtime', settings = {}) => {
        const preferences = sanitizeHandwritingToolPreferences(settings);
        await loadTextFont(preferences.fontFamily);
        await document.fonts.ready;
        engine.setDrawingData(createEmptyDrawingData(), 'geometry-page');
        engine.handwriting.setPreferences(preferences);
        engine.handwriting.setActive(true);
        for (const [index, source] of sources.entries()) {
          const stroke: Stroke = {
            id: `source-${index}`, type: 'stroke', tool: 'pen', layerId: engine.layers.getActiveLayerId(),
            color: '#111111', thickness: 2, opacity: 1, createdAt: index,
            points: [{ x: source.x, y: source.y, pressure: .5, t: 0 },
              { x: source.x + source.width, y: source.y + source.height, pressure: .5, t: 50 }],
          };
          engine.drawing.setStrokes([...engine.drawing.getStrokes(), stroke]);
          if (mode === 'manual') {
            engine.selection.select(stroke.id, 'stroke');
            const bounds = getHandwritingBounds([stroke])!;
            if (!engine.convertSelectedHandwritingLinesToText([{
              id: `line-${index}`, strokes: [stroke], bounds, baseline: bounds.y + bounds.height * .82,
              blankLinesBefore: 0, layerId: stroke.layerId, text: source.text, candidates: [], status: 'success',
            }], preferences, 'geometry-fixture')) throw new Error('manual conversion failed');
          } else {
            recognizedText = source.text;
            engine.handwriting.beginStroke(); engine.handwriting.completeStroke(stroke); engine.handwriting.flush();
            for (let frame = 0; engine.texts.getTexts().length < index + 1; frame++) {
              if (frame > 60) throw new Error('realtime conversion failed');
              await new Promise(requestAnimationFrame);
            }
          }
        }
        setObjects([...engine.texts.getTexts()]);
        return structuredClone(engine.texts.getTexts());
      },
      placementManualText: () => {
        const text: TextObject = { id: 'ordinary-text', type: 'text', x: 100, y: 100, width: 240, height: 72, createdAt: 1,
          content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ordinary manual text' }] }] } };
        engine.texts.setTexts([text]); setObjects([text]);
      },
    });
    return () => engine.destroy();
  }, []);
  return <>
    <canvas ref={canvasRef} style={{ display: 'none' }} />
    <div id="placement-page" style={{ position: 'relative', margin: '40px', width: 1000, height: 1200, transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
      {objects.map(object => <div key={object.id} data-placement-id={object.id}>
        {active ? <FloatingTextEditor object={object} engine={engine} scale={1} toolMode="select" onFocus={() => {}} onBlur={() => {}} />
          : <StaticTextPreview object={object} scale={1} />}
      </div>)}
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
