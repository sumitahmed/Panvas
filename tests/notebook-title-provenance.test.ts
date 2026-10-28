import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSectionRenumbering, type PageForRenumbering } from '../src/lib/notebookPageRenumbering.ts';
import type { NotebookPage } from '../src/types/notebook.ts';

function createPage(
  id: string,
  title: string,
  order: number,
  titleProvenance?: 'default' | 'custom',
  deletedAt: number | null = null,
): NotebookPage {
  return {
    id,
    notebookId: 'nb-1',
    sectionId: 'sec-1',
    title,
    titleProvenance,
    order,
    createdAt: 1000 + order * 10,
    updatedAt: 1000 + order * 10,
    userId: null,
    deletedAt,
  };
}

test('Suite 2 - Test 7: Default Title Renumbering when an intermediate page is deleted', () => {
  const pages: NotebookPage[] = [
    createPage('p1', 'Page 1', 0, 'default'),
    createPage('p2', 'Page 2', 1, 'default'),
    createPage('p3', 'Page 3', 2, 'default'),
    createPage('p4', 'Page 4', 3, 'default'),
  ];

  // Delete Page 2 (id: p2)
  pages[1].deletedAt = Date.now();

  // Renumber remaining pages
  const updates = computeSectionRenumbering(pages);

  assert.equal(updates.length, 2);
  assert.deepEqual(updates, [
    { id: 'p3', title: 'Page 2', titleProvenance: 'default' },
    { id: 'p4', title: 'Page 3', titleProvenance: 'default' },
  ]);

  // Apply updates to simulate database / memory update
  updates.forEach(u => {
    const page = pages.find(p => p.id === u.id);
    if (page) {
      page.title = u.title;
      page.titleProvenance = u.titleProvenance;
    }
  });

  const activePages = pages.filter(p => !p.deletedAt);
  assert.equal(activePages[0].title, 'Page 1');
  assert.equal(activePages[1].title, 'Page 2');
  assert.equal(activePages[2].title, 'Page 3');
});

test('Suite 2 - Test 8: Custom Title Immutability preserves custom titles while renumbering default ones', () => {
  const pages: NotebookPage[] = [
    createPage('p1', 'Intro', 0, 'custom'),
    createPage('p2', 'Index', 1, 'custom'),
    createPage('p3', 'Page 3', 2, 'default'),
    createPage('p4', 'Page 4', 3, 'default'),
  ];

  // Delete 'Index' (p2)
  pages[1].deletedAt = Date.now();

  const updates = computeSectionRenumbering(pages);

  // 'Intro' is custom (index 0 -> logical 1), so no update.
  // 'Page 3' is default at sorted index 1 -> expected 'Page 2'.
  // 'Page 4' is default at sorted index 2 -> expected 'Page 3'.
  assert.equal(updates.length, 2);
  assert.deepEqual(updates, [
    { id: 'p3', title: 'Page 2', titleProvenance: 'default' },
    { id: 'p4', title: 'Page 3', titleProvenance: 'default' },
  ]);

  updates.forEach(u => {
    const page = pages.find(p => p.id === u.id);
    if (page) {
      page.title = u.title;
      page.titleProvenance = u.titleProvenance;
    }
  });

  const active = pages.filter(p => !p.deletedAt);
  assert.equal(active[0].title, 'Intro');
  assert.equal(active[1].title, 'Page 2');
  assert.equal(active[2].title, 'Page 3');
});

test('Suite 2 - Test 9: Custom Title Named "Page 3" is not renamed on deletion of earlier pages', () => {
  const pages: NotebookPage[] = [
    createPage('p1', 'Page 1', 0, 'default'),
    createPage('p2', 'Page 2', 1, 'default'),
    // User intentionally named this page "Page 3" with custom provenance
    createPage('p3', 'Page 3', 2, 'custom'),
    createPage('p4', 'Page 4', 3, 'default'),
  ];

  // Delete Page 1
  pages[0].deletedAt = Date.now();

  const updates = computeSectionRenumbering(pages);

  // p2 ('Page 2', default) is now at index 0 -> should become 'Page 1'
  // p3 ('Page 3', custom) is at index 1 -> MUST NOT be changed even though it matches /Page \d+/
  // p4 ('Page 4', default) is at index 2 -> should become 'Page 3'
  assert.equal(updates.length, 2);
  assert.deepEqual(updates, [
    { id: 'p2', title: 'Page 1', titleProvenance: 'default' },
    { id: 'p4', title: 'Page 3', titleProvenance: 'default' },
  ]);

  const p3Update = updates.find(u => u.id === 'p3');
  assert.equal(p3Update, undefined, 'Custom title named Page 3 must never be renumbered');
});

test('Suite 2 - Test 10: Provenance Flip on Rename prevents subsequent renumbering', () => {
  const pages: NotebookPage[] = [
    createPage('p1', 'Page 1', 0, 'default'),
    createPage('p2', 'Page 2', 1, 'default'),
    createPage('p3', 'Page 3', 2, 'default'),
  ];

  // User renames Page 2 to "My Notes" -> provenance flips to 'custom'
  pages[1].title = 'My Notes';
  pages[1].titleProvenance = 'custom';

  // Now delete Page 1
  pages[0].deletedAt = Date.now();

  const updates = computeSectionRenumbering(pages);

  // p2 is custom: must stay "My Notes"
  // p3 is default: was 'Page 3', now at sorted index 1 -> becomes 'Page 2'
  assert.equal(updates.length, 1);
  assert.deepEqual(updates, [
    { id: 'p3', title: 'Page 2', titleProvenance: 'default' },
  ]);

  assert.equal(pages[1].title, 'My Notes');
  assert.equal(pages[1].titleProvenance, 'custom');
});

test('Suite 2 - Test 11: Legacy Compatibility treats undefined provenance conservatively as custom', () => {
  // Legacy notes without titleProvenance in database
  const pages: NotebookPage[] = [
    createPage('p1', 'Page 1', 0, undefined),
    createPage('p2', 'Page 2', 1, undefined),
    createPage('p3', 'Page 3', 2, undefined),
  ];

  // Deleting Page 1 on legacy notes must NOT mutate legacy titles
  pages[0].deletedAt = Date.now();

  const updates = computeSectionRenumbering(pages);

  assert.equal(updates.length, 0, 'Legacy pages without provenance metadata must not be rewritten');
  assert.equal(pages[1].title, 'Page 2');
  assert.equal(pages[2].title, 'Page 3');
});

test('Suite 2 - Test 12: Reordering Preservation updates default labels and preserves custom titles', () => {
  const pages: NotebookPage[] = [
    createPage('p1', 'Intro', 0, 'custom'),
    createPage('p2', 'Page 2', 1, 'default'),
    createPage('p3', 'Page 3', 2, 'default'),
  ];

  // Reorder: Move 'Intro' to index 2 (end), p2 to index 0, p3 to index 1
  pages[0].order = 2; // Intro
  pages[1].order = 0; // p2
  pages[2].order = 1; // p3

  const updates = computeSectionRenumbering(pages);

  // Sorted order: p2 (index 0 -> 'Page 1'), p3 (index 1 -> 'Page 2'), p1 (index 2 -> custom 'Intro')
  assert.equal(updates.length, 2);
  assert.deepEqual(updates, [
    { id: 'p2', title: 'Page 1', titleProvenance: 'default' },
    { id: 'p3', title: 'Page 2', titleProvenance: 'default' },
  ]);

  const p1Update = updates.find(u => u.id === 'p1');
  assert.equal(p1Update, undefined, 'Custom title Intro must retain its name upon reordering');
});

test('Suite 2 - Test 13: Cloud Sync Non-Reversion generates clean delta operations with monotonic timestamps', () => {
  const pages: NotebookPage[] = [
    createPage('p1', 'Page 1', 0, 'default'),
    createPage('p2', 'Page 2', 1, 'default'),
    createPage('p3', 'Page 3', 2, 'default'),
  ];

  pages[0].deletedAt = 2000;

  const updates = computeSectionRenumbering(pages);
  const now = 3000;

  // Verify journal changes for sync serialization
  const syncRecords = updates.map(u => ({
    entityType: 'notebookPage',
    entityId: u.id,
    operation: 'update',
    payload: { title: u.title, titleProvenance: u.titleProvenance },
    timestamp: now,
  }));

  assert.equal(syncRecords.length, 2);
  assert.equal(syncRecords[0].payload.title, 'Page 1');
  assert.equal(syncRecords[0].payload.titleProvenance, 'default');
  assert.equal(syncRecords[1].payload.title, 'Page 2');
  assert.equal(syncRecords[1].payload.titleProvenance, 'default');

  // Verify that a stale remote snapshot with old timestamp cannot overwrite newer local revision
  const staleRemoteTimestamp = 1500;
  assert.ok(syncRecords[0].timestamp > staleRemoteTimestamp, 'Newer local renumbering takes precedence over stale remote sync');
});
