import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { createLowlight, common } from 'lowlight';
import { notebookCodeHighlight } from '../src/components/notebook/notebookCodeHighlight.ts';

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' }, paragraph: { group: 'block', content: 'inline*' },
  codeBlock: { group: 'block', content: 'text*', code: true, marks: '', attrs: { language: { default: 'java' }, wrap: { default: false }, caption: { default: '' } } },
} });
const fixture = () => {
  const lowlight = createLowlight(common), calls: string[] = [];
  const plugin = notebookCodeHighlight('codeBlock', { registered: lowlight.registered, highlight: (language, source) => { calls.push(source); return lowlight.highlight(language, source); } });
  const blocks = Array.from({length:40}, (_,i)=>schema.nodes.codeBlock.create(null, schema.text(`public class Example${i} { int value = ${i}; }`)));
  let state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, blocks), plugins: [plugin] });
  return { calls, plugin, get state() { return state; }, apply: (tr: typeof state.tr) => state = state.apply(tr), reset: () => calls.splice(0) };
};
test('editing one of forty blocks only highlights the changed block', () => {
  const f=fixture(); f.reset(); f.apply(f.state.tr.insertText('x', 15));
  assert.equal(f.calls.length,1); assert.ok(f.plugin.getState(f.state)!.decorations.find().length > 100);
});
test('selection changes and non-syntax attributes retain existing decorations', () => {
  const f=fixture(), initial=f.plugin.getState(f.state)!.decorations.find().length; f.reset();
  f.apply(f.state.tr.setSelection(TextSelection.create(f.state.doc, 6, 12)));
  f.apply(f.state.tr.setNodeMarkup(0, undefined, {language:'java',wrap:true,caption:'Saved caption'}));
  assert.equal(f.calls.length,0); assert.equal(f.plugin.getState(f.state)!.decorations.find().length,initial);
});
test('language changes remove the target classes and preserve all other code blocks', () => {
  const f=fixture(); f.reset(); f.apply(f.state.tr.setNodeMarkup(0,undefined,{language:'plaintext'}));
  assert.equal(f.calls.length,1); assert.equal(f.plugin.getState(f.state)!.decorations.find(1,f.state.doc.firstChild!.nodeSize-1).length,0);
  assert.ok(f.plugin.getState(f.state)!.decorations.find().length > 100);
});
test('converting code to a paragraph removes mapped syntax classes', () => {
  const f=fixture(); f.reset(); f.apply(f.state.tr.setNodeMarkup(0,schema.nodes.paragraph));
  assert.equal(f.calls.length,0); assert.equal(f.plugin.getState(f.state)!.decorations.find(1,f.state.doc.firstChild!.nodeSize-1).length,0);
});
test('replacing the document with equivalent code still recreates valid decorations', () => {
  const f=fixture(), initial=f.plugin.getState(f.state)!.decorations.find().length; f.reset();
  f.apply(f.state.tr.replaceWith(0,f.state.doc.content.size,f.state.doc.content));
  assert.equal(f.calls.length,40); assert.equal(f.plugin.getState(f.state)!.decorations.find().length,initial);
});
