import assert from 'node:assert/strict';
import test from 'node:test';
import { extractNotebookOutline, type OutlinePage } from '../src/components/notebook/outlineModel.ts';

const page = (id: string, sectionId: string, order: number, title: string, content?: unknown, drawing?: unknown): OutlinePage => ({
  id, notebookId: 'notebook-1', sectionId, order, title, content, drawing,
  createdAt: 0, updatedAt: order, userId: null,
} as OutlinePage);

const section = (id: string, order: number) => ({ id, notebookId: 'notebook-1', order, name: id, createdAt: 0, updatedAt: 0, isExpanded: true, userId: null } as any);

test('extracts all six heading levels from TipTap JSON', () => {
  const outline = extractNotebookOutline([
    page('page-1', 'section-1', 0, 'Planning', {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Overview' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goals' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Stretch goal' }] },
        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Details' }] },
        { type: 'heading', attrs: { level: 5 }, content: [{ type: 'text', text: 'Subdetails' }] },
        { type: 'heading', attrs: { level: 6 }, content: [{ type: 'text', text: 'Deep heading' }] },
      ],
    }),
  ], [section('section-1', 0)]);

  assert.deepEqual(outline.filter(item => item.kind === 'heading').map(item => ({ title: item.title, level: item.level, pageNumber: item.pageNumber })), [
    { title: 'Overview', level: 1, pageNumber: 1 },
    { title: 'Goals', level: 2, pageNumber: 1 },
    { title: 'Stretch goal', level: 3, pageNumber: 1 },
    { title: 'Details', level: 4, pageNumber: 1 },
    { title: 'Subdetails', level: 5, pageNumber: 1 },
    { title: 'Deep heading', level: 6, pageNumber: 1 },
  ]);
});

test('orders pages by section and page order and assigns page numbers across sections', () => {
  const outline = extractNotebookOutline([
    page('page-2', 'section-2', 0, 'Second'),
    page('page-1', 'section-1', 2, 'First', undefined, { objects: [{ type: 'text', content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Start' }] }] } }] }),
  ], [section('section-2', 1), section('section-1', 0)]);

  assert.deepEqual(outline.filter(item => item.kind === 'page').map(item => ({ pageId: item.pageId, title: item.title, pageNumber: item.pageNumber })), [
    { pageId: 'page-1', title: 'First', pageNumber: 1 },
    { pageId: 'page-2', title: 'Second', pageNumber: 2 },
  ]);
  assert.equal(outline.find(item => item.kind === 'heading')?.pageNumber, 1);
});

test('ignores empty content, unsupported heading levels, and malformed nodes', () => {
  const outline = extractNotebookOutline([
    page('page-1', 'section-1', 0, 'Empty', { type: 'doc', content: [{ type: 'heading', attrs: { level: 7 }, content: [{ type: 'text', text: 'Ignore' }] }, { type: 'heading', attrs: { level: 2 }, content: [] }] }),
    page('page-2', 'section-1', 1, 'Still useful', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }, null, 'not-a-node'] }),
  ], [section('section-1', 0)]);

  assert.equal(outline.filter(item => item.kind === 'heading').length, 0);
  assert.deepEqual(outline.filter(item => item.kind === 'page').map(item => item.title), ['Empty', 'Still useful']);
});

test('collapsible heading targets use the section identity and include semantic inline labels', () => {
  const outline = extractNotebookOutline([page('page-1', 'section-1', 0, 'Math', {
    type: 'doc', content: [{ type: 'details', attrs: { blockId: 'section-id', open: false }, content: [
      { type: 'detailsSummary', attrs: { headingLevel: 5, blockId: 'title-id' }, content: [
        { type: 'text', text: 'Formula ' }, { type: 'inlineMath', attrs: { latex: 'x^2' } },
        { type: 'text', text: ' ' }, { type: 'pageReference', attrs: { label: 'Ref' } },
      ] },
      { type: 'detailsContent', content: [{ type: 'paragraph' }] },
    ] }],
  })], [section('section-1', 0)]);
  const heading = outline.find(item => item.kind === 'heading')!;
  assert.equal(heading.title, 'Formula x^2 Ref');
  assert.equal(heading.level, 5);
  assert.equal(heading.blockId, 'section-id');
  assert.equal(heading.id, 'heading:page-1:section-id');
});

