import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PAGE_PROPERTY_SET } from '../src/types/notebook.ts';
import { documentExtent, positionedContentBottom, documentSheetStride } from '../src/components/notebook/documentFlowGeometry.ts';
import { nextLogicalScrollBase, LOGICAL_SCROLL_WINDOW } from '../src/components/notebook/logicalScrollWindow.ts';
import { derivePagePropertyOverrides, getNotebookPageDefaults, resolveBasePageDimensions, resolvePageProperties, resolvePageSurfaceGeometry } from '../src/lib/pageProperties.ts';

const document = { ...DEFAULT_PAGE_PROPERTY_SET, layoutMode: 'document' as const };

test('fixed continuation reclamation keeps annotation coordinates and source note-space offsets', () => {
  const properties = { ...document, extraTop: 100, extraBottom: 200, extraLeft: 80 };
  const stride = documentSheetStride(properties);
  const extent = documentExtent(properties, 120, stride * 2 + 300);
  const geometry = resolvePageSurfaceGeometry({ ...properties, layoutExtent: extent });
  assert.equal(geometry.height, stride * 3 - 32);
  assert.equal(geometry.source.left, 80);
  assert.equal(geometry.source.top, 100);
  assert.equal(geometry.source.height, 1123);
  assert.equal(documentExtent(properties, 120), 1123);
  assert.equal(positionedContentBottom([{ type: 'text', x: 0, y: 0, width: 0, height: 9000, metadata: { documentRole: 'body' } }, { type: 'text', x: 40, y: stride * 2 + 200, width: 100, height: 100 }] as any), stride * 2 + 300);
});

test('Infinite retains converted width and finite extent well beyond browser CSS limits', () => {
  const properties = { ...document, pageSize: 'Infinite' as const, infiniteWidth: 1123, layoutExtent: 50_000_384 };
  assert.deepEqual(resolveBasePageDimensions(properties), { width: 1123, height: 1123 });
  assert.equal(resolvePageSurfaceGeometry(properties).height, 50_000_384);
  assert.ok(documentExtent(properties, 50_000_000) > 50_000_000);
  assert.equal(resolveBasePageDimensions({ ...properties, infiniteWidth: Number.NaN }).width, 794);
  assert.equal(resolvePageSurfaceGeometry({ ...properties, layoutExtent: Number.POSITIVE_INFINITY }).height, 1123);
});

test('logical window rebasing preserves absolute positions without imposing a document cap', () => {
  const extent = 50_000_384;
  let base = 0, local = 800_000;
  for (let step = 0; step < 90; step++) {
    const absolute = base + local;
    const next = nextLogicalScrollBase(base, local, extent);
    local -= next - base;
    assert.equal(next + local, absolute);
    base = next;
    local += 500_000;
  }
  assert.ok(base > 40_000_000);
  assert.ok(base + LOGICAL_SCROLL_WINDOW <= extent);
  assert.equal(nextLogicalScrollBase(base, 100_000, extent), base - 500_000);
  assert.equal(nextLogicalScrollBase(100_000, 800_000, 1123), 0);
});

test('document authority and extent remain page-owned across inheritance and drawing reload', () => {
  const notebook = { defaultPageProperties: { ...document, infiniteWidth: 1000, layoutExtent: 9000 } } as any;
  assert.equal(getNotebookPageDefaults(notebook).layoutMode, undefined);
  assert.equal(getNotebookPageDefaults(notebook).layoutExtent, undefined);
  assert.equal(getNotebookPageDefaults(notebook).infiniteWidth, undefined);
  const overrides = derivePagePropertyOverrides({ ...document, layoutExtent: 7000 }, notebook);
  assert.equal(overrides.layoutMode, 'document');
  assert.equal(overrides.layoutExtent, undefined);
  assert.equal(resolvePageProperties(notebook, { pagePropertyOverrides: overrides } as any, { ...document, layoutExtent: 7000 }).layoutExtent, 7000);
});
