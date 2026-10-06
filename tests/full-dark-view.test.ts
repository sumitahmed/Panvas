import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { colorLuminance, fullDarkInkColor, fullDarkSurfaceColor, fullDarkRuleLineColor, isBrightDocumentPixels } from '../src/lib/fullDarkView.ts';
import { applyThemeClasses, readFullDarkView, FULL_DARK_VIEW_STORAGE_KEY } from '../src/lib/theme.ts';
import { createEmptyDrawingData } from '../src/components/notebook/engine/drawingTypes.ts';
import { exportNotebookPdf } from '../src/services/pdf/notebookPdfExport.ts';

test('bright paper is darkened while already-dark paper retains its exact color', () => {
  for (const paper of ['#ffffff', '#FFF9C4', '#bbf7d0', '#bae6fd']) assert.ok(colorLuminance(fullDarkSurfaceColor(paper)) < .18);
  for (const paper of ['#000000', '#20252b', '#102040']) assert.equal(fullDarkSurfaceColor(paper), paper);
});

test('dark ink gains contrast and authored red, blue, orange and green retain channel identity', () => {
  assert.ok(colorLuminance(fullDarkInkColor('#000000')) > .7);
  for (const [color, dominant] of [['#b91c1c', 0], ['#1d4ed8', 2], ['#c2410c', 0], ['#15803d', 1]] as const) {
    const channels = fullDarkInkColor(color).slice(1).match(/../g)!.map(c => parseInt(c, 16));
    assert.equal(channels.indexOf(Math.max(...channels)), dominant);
    assert.ok(colorLuminance(fullDarkInkColor(color)) > colorLuminance(color));
  }
  assert.equal(fullDarkInkColor('#ffff00'), '#ffff00');
  assert.equal(fullDarkInkColor('#ffffff'), '#ffffff');
});

test('yellow sticky presentation is muted warm yellow, never a black replacement', () => {
  const color = fullDarkSurfaceColor('#fef08a', true);
  const [r,g,b] = color.slice(1).match(/../g)!.map(c => parseInt(c, 16));
  assert.ok(r > b && g > b && colorLuminance(color) > .08 && colorLuminance(color) < .3);
});

test('rule lines remain visible and restrained on dark paper', () => {
  for (const color of ['#ffffff', '#e5e7eb', '#000000']) {
    const luminance = colorLuminance(fullDarkRuleLineColor(color));
    assert.ok(luminance > .06 && luminance < .25);
  }
});

test('median PDF luminance distinguishes bright pages from already-dark pages', () => {
  const pixels = (channel: number) => new Uint8ClampedArray(Array.from({length: 144}, () => [channel,channel,channel,255]).flat());
  assert.equal(isBrightDocumentPixels(pixels(255)), true);
  assert.equal(isBrightDocumentPixels(pixels(25)), false);
  assert.equal(isBrightDocumentPixels([255,255,255,0]), false);
  const bright = pixels(255);bright.fill(0,0,40);assert.equal(isBrightDocumentPixels(bright), true);
});

test('local preference is independent of theme and Full Dark class belongs only to Dark', () => {
  const previousDocument = globalThis.document, previousStorage = Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  const classes = new Set<string>();
  const storage = new Map([[FULL_DARK_VIEW_STORAGE_KEY,'true']]);
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null}});
  // @ts-expect-error minimal DOM contract
  globalThis.document={documentElement:{classList:{add:(...names:string[])=>names.forEach(n=>classes.add(n)),remove:(...names:string[])=>names.forEach(n=>classes.delete(n))}}};
  try {
    assert.equal(readFullDarkView(),true);applyThemeClasses('dark');assert.ok(classes.has('full-dark-view'));
    applyThemeClasses('light');assert.equal(classes.has('full-dark-view'),false);
    applyThemeClasses('ink');assert.equal(classes.has('full-dark-view'),false);
    applyThemeClasses('dark',false);assert.deepEqual([...classes],['dark']);
  } finally {
    globalThis.document=previousDocument;
    if(previousStorage)Object.defineProperty(globalThis,'localStorage',previousStorage);else Reflect.deleteProperty(globalThis,'localStorage');
  }
});

test('notebook PDF export retains original paper and paint even while Full Dark class is active', async () => {
  const data=createEmptyDrawingData();Object.assign(data.properties,{paperColor:'#ffffff',ruleLineColor:'#000000',template:'Blank',margins:'No Margin'});
  data.objects=[{id:'black',type:'stroke',tool:'pen',color:'#000000',thickness:2,opacity:1,createdAt:0,points:[{x:20,y:20,pressure:.5,t:0},{x:50,y:50,pressure:.5,t:1}]}];
  const original=JSON.stringify(data),before=globalThis.document;
  // @ts-expect-error minimal export appearance contract
  globalThis.document={documentElement:{classList:{contains:(name:string)=>name==='dark'||name==='full-dark-view'}}};
  try {
    const result=await exportNotebookPdf({pages:[{id:'page',title:'Page',drawing:data,properties:data.properties}]});
    assert.equal(result.success,true);
    const pdf=await PDFDocument.load(result.bytes!);
    const content=pdf.getPage(0).node.Contents()!.asArray().map(ref=>Buffer.from(decodePDFRawStream(pdf.context.lookup(ref,PDFRawStream)).decode()).toString()).join('\n');
    assert.match(content,/1 1 1 rg/);assert.match(content,/0 0 0 (?:rg|RG)/);assert.equal(JSON.stringify(data),original);
  } finally {globalThis.document=before;}
});
