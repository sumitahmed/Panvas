import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveNotebookNavigationDelta, shouldNotebookHandleNavigationKey } from '../src/components/notebook/notebookNavigation.ts';
import { HANDWRITING_FONT_FAMILIES, STANDARD_TEXT_FONT_FAMILIES, TEXT_FONT_GROUPS, UI_FONT_FAMILY, fontOptionStyle } from '../src/components/notebook/textFonts.ts';
import { hasAuthoritativePageAppearance, resolvePageProperties } from '../src/lib/pageProperties.ts';
import { DEFAULT_PAGE_PROPERTY_SET, type Notebook, type NotebookPage } from '../src/types/notebook.ts';

const plainTarget = { closest: () => null } as unknown as EventTarget;
const ownedTarget = { closest: () => ({}) } as unknown as EventTarget;

test('present navigation maps keyboard controls to predictable viewport progress', () => {
  assert.equal(resolveNotebookNavigationDelta({ key: 'ArrowDown' }, 'present', 1000), 860);
  assert.equal(resolveNotebookNavigationDelta({ key: 'ArrowUp' }, 'present', 1000), -860);
  assert.equal(resolveNotebookNavigationDelta({ key: 'PageDown' }, 'present', 1000), 860);
  assert.equal(resolveNotebookNavigationDelta({ key: 'PageUp' }, 'present', 1000), -860);
  assert.equal(resolveNotebookNavigationDelta({ key: ' ', code: 'Space' }, 'present', 1000), 860);
  assert.equal(resolveNotebookNavigationDelta({ key: ' ', code: 'Space', shiftKey: true }, 'present', 1000), -860);
  assert.equal(resolveNotebookNavigationDelta({ key: 'ArrowRight' }, 'present', 1000), 860);
  assert.equal(resolveNotebookNavigationDelta({ key: 'ArrowLeft' }, 'present', 1000), -860);
});

test('present wheel and all-mode keyboard navigation are wired to the existing notebook viewport', async () => {
  const [renderer, overlay] = await Promise.all([
    readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/workspace/PresentationOverlay.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(renderer, /resolveNotebookNavigationDelta\(e, workspaceViewMode/);
  assert.match(renderer, /shouldNotebookHandleNavigationKey\(e\)/);
  assert.match(renderer, /<PresentationOverlay onWheel=/);
  assert.match(renderer, /container\.scrollBy\(\{ left: event\.deltaX, top: event\.deltaY/);
  assert.match(renderer, /tabIndex=\{0\}[\s\S]*aria-label="Notebook pages"/);
  assert.match(overlay, /onWheel=\{onWheel\}/);
});

test('read and edit arrows use native-sized scrolling and page keys use viewport scrolling', () => {
  for (const mode of ['edit', 'read'] as const) {
    assert.equal(resolveNotebookNavigationDelta({ key: 'ArrowDown' }, mode, 900), 56);
    assert.equal(resolveNotebookNavigationDelta({ key: 'ArrowUp' }, mode, 900), -56);
    assert.equal(resolveNotebookNavigationDelta({ key: 'PageDown' }, mode, 900), 774);
    assert.equal(resolveNotebookNavigationDelta({ key: 'PageUp' }, mode, 900), -774);
    assert.equal(resolveNotebookNavigationDelta({ key: ' ', code: 'Space' }, mode, 900), null);
  }
});

test('navigation routing yields to editors, menus, listboxes, sliders and modified shortcuts', () => {
  assert.equal(shouldNotebookHandleNavigationKey({ key: 'ArrowDown', target: plainTarget }), true);
  for (const kind of ['INPUT', 'TEXTAREA', 'SELECT', 'contentEditable', 'TipTap', 'menu', 'listbox', 'slider']) {
    assert.equal(shouldNotebookHandleNavigationKey({ key: 'ArrowDown', target: ownedTarget }), false, kind);
  }
  assert.equal(shouldNotebookHandleNavigationKey({ key: 'ArrowDown', target: plainTarget, defaultPrevented: true }), false);
  assert.equal(shouldNotebookHandleNavigationKey({ key: 'ArrowDown', target: plainTarget, ctrlKey: true }), false);
  assert.equal(shouldNotebookHandleNavigationKey({ key: 'ArrowDown', target: plainTarget, metaKey: true }), false);
  assert.equal(shouldNotebookHandleNavigationKey({ key: 'ArrowDown', target: plainTarget, altKey: true }), false);
});

test('font menu model isolates every preview and keeps category chrome in the UI face', () => {
  assert.deepEqual(TEXT_FONT_GROUPS.map(group => group.label), ['Standard', 'Handwriting']);
  for (const group of TEXT_FONT_GROUPS) assert.equal(group.fontFamily, UI_FONT_FAMILY);
  for (const font of [...STANDARD_TEXT_FONT_FAMILIES, ...HANDWRITING_FONT_FAMILIES]) assert.equal(fontOptionStyle(font, 'loaded').fontFamily, font);
  assert.equal(fontOptionStyle("'Kalam', cursive", 'unavailable').fontFamily, UI_FONT_FAMILY);
  assert.equal(fontOptionStyle("'Dancing Script', cursive", 'loaded').fontFamily, "'Dancing Script', cursive");
  assert.equal(fontOptionStyle('Inter, sans-serif', 'loaded').fontFamily, 'Inter, sans-serif');
  assert.equal(fontOptionStyle("'JetBrains Mono', monospace", 'loaded').fontFamily, "'JetBrains Mono', monospace");
});

test('both text surfaces use the custom font listbox rather than a native font select', async () => {
  const [toolbar, picker, conversionDialog] = await Promise.all([
    readFile(new URL('../src/components/notebook/NotebookFloatingToolbar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/notebook/TextFontPicker.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/notebook/HandwritingConversionDialog.tsx', import.meta.url), 'utf8'),
  ]);
  assert.equal((toolbar.match(/<TextFontPicker/g) ?? []).length, 2);
  assert.doesNotMatch(toolbar, /<optgroup label="(?:Standard|Handwriting)"/);
  assert.match(conversionDialog, /<TextFontPicker/);
  assert.doesNotMatch(conversionDialog, /<optgroup label="(?:Standard|Handwriting)"/);
  assert.match(picker, /role="listbox"/);
  assert.match(picker, /role="option"/);
  assert.match(picker, /loadTextFont/);
});

test('saved page shells have authoritative appearance before active or inactive rendering', () => {
  const notebook: Notebook = { id: 'n', workspaceId: 'w', folderId: null, name: 'N', createdAt: 1, updatedAt: 1, order: 0, isExpanded: true, userId: null, defaultPageProperties: { ...DEFAULT_PAGE_PROPERTY_SET } };
  const variants = [
    { paperColor: '#ffffff', template: 'Ruled', ruleLineColor: '#94a3b8' },
    { paperColor: '#232323', template: 'Large grid', ruleLineColor: '#ef4444' },
    { paperColor: '#fff9c4', template: 'Dotted', ruleLineColor: '#a855f7' },
    { paperColor: '#e8f5e9', template: 'Cornell', ruleLineColor: '#16a34a' },
  ] as const;
  const pages = variants.map((appearance, index): NotebookPage => ({ id: `p${index + 1}`, notebookId: 'n', sectionId: 's', title: `P${index + 1}`, createdAt: 1, updatedAt: 1, order: index, userId: null, pagePropertyOverrides: appearance }));
  for (let index = 0; index < pages.length; index += 1) {
    assert.equal(hasAuthoritativePageAppearance(pages[index]), true);
    const inactive = resolvePageProperties(notebook, pages[index]);
    const active = resolvePageProperties(notebook, pages[index], { ...DEFAULT_PAGE_PROPERTY_SET });
    assert.equal(inactive.paperColor, variants[index].paperColor);
    assert.equal(inactive.template, variants[index].template);
    assert.deepEqual(active, inactive, 'activation must not replace metadata with defaults');
  }
  assert.equal(hasAuthoritativePageAppearance({ pagePropertyOverrides: undefined }), false);
  assert.equal(hasAuthoritativePageAppearance({ pagePropertyOverrides: undefined }, DEFAULT_PAGE_PROPERTY_SET), true);
});

test('legacy pages use a neutral preparation shell until persisted drawing appearance is known', async () => {
  const renderer = await readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8');
  assert.match(renderer, /hasAuthoritativePageAppearance\(sectionPage, sectionDataCacheRef\.current\[sectionPage\.id\]\?\.properties\)/);
  assert.match(renderer, /!sectionAppearanceReady[\s\S]*Preparing notebook appearance/);
  assert.doesNotMatch(renderer, /Date\.now\(\).*key=|forceUpdate/);
});
