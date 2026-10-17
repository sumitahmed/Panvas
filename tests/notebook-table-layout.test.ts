import test from 'node:test';
import assert from 'node:assert/strict';
import { notebookDocumentViewContent } from '../src/components/notebook/notebookDocumentView.ts';

test('malformed legacy table spans have a readable view without mutating their stored payload', () => {
  const original = { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [
    { type: 'tableHeader', attrs: { colspan: 'undefined', rowspan: 1, blockId: 'retain-id' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Feature' }] }] },
    { type: 'tableCell', attrs: { colspan: '2', rowspan: '3', colwidth: [150, 180] }, content: [{ type: 'paragraph' }] },
  ] }] }] };
  const before = JSON.stringify(original), view = notebookDocumentViewContent(original);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(view.content![0].content![0].content![0].attrs, { colspan: 1, rowspan: 1, blockId: 'retain-id' });
  assert.deepEqual(view.content![0].content![0].content![1].attrs, { colspan: 2, rowspan: 3, colwidth: [150, 180] });
  assert.equal(view.content![0].content![0].content![0].content, original.content[0].content[0].content[0].content);
});

test('valid merged tables and unknown future structures retain their identity and attributes', () => {
  const original = { type: 'doc', content: [
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2, rowspan: 3, colwidth: [150, 180] }, content: [{ type: 'paragraph' }] }] }] },
    { type: 'future-node', attrs: { colspan: 'unknown', payload: { keep: true } } },
  ] };
  assert.equal(notebookDocumentViewContent(original), original);
});

test('explicit known language names use installed grammar casing while unknown labels and source JSON remain intact', () => {
  const original = { type: 'doc', content: [{ type: 'codeBlock', attrs: { language: 'Java' } }, { type: 'codeBlock', attrs: { language: 'CUSTOMLang' } }] };
  const before = JSON.stringify(original), view = notebookDocumentViewContent(original);
  assert.equal(view.content![0].attrs!.language, 'java');
  assert.equal(view.content![1], original.content[1]);
  assert.equal(JSON.stringify(original), before);
});
