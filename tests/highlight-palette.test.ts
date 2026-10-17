import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultHighlightPalette, readHighlightPalette, selectHighlightColor } from '../src/lib/highlightPalette.ts';

test('six-slot palette rolls FIFO across serialized restarts without changing document colors', () => {
  let palette = defaultHighlightPalette();
  const documentMark = { type: 'highlight', attrs: { color: palette.colors[0] } };
  const custom = ['#9b59b6', '#8bc34a', '#123456', '#654321', '#abcdef', '#fedcba', '#135790'];
  for (const [index, color] of custom.entries()) {
    palette = selectHighlightColor(readHighlightPalette(JSON.parse(JSON.stringify(palette))), color, true);
    assert.equal(palette.colors.length, 6);
    assert.equal(palette.colors[index % 6], color);
    assert.equal(palette.next, (index + 1) % 6);
    assert.equal(palette.selectedColor, color);
  }
  assert.deepEqual(palette.colors, ['#135790', ...custom.slice(1, 6)]);
  assert.equal(documentMark.attrs.color, '#fff4b8');
});

test('existing custom and default colors never duplicate or advance replacement order', () => {
  let palette = selectHighlightColor(defaultHighlightPalette(), '#9B59B6', true);
  const colors = palette.colors;
  palette = selectHighlightColor(palette, '#BBF7D0', true);
  assert.equal(palette.colors, colors); assert.equal(palette.next, 1);
  palette = selectHighlightColor(palette, '#9B59B6', true);
  assert.equal(palette.colors, colors); assert.equal(palette.next, 1);
  assert.equal(selectHighlightColor(palette, '#9b59b6', true), palette);
  palette = selectHighlightColor(palette, null);
  assert.equal(palette.selectedColor, null); assert.equal(palette.colors, colors); assert.equal(palette.next, 1);
});

test('malformed saved palettes fall back safely, without retaining aliases to input arrays', () => {
  const defaults = defaultHighlightPalette();
  for (const invalid of [null, {}, { ...defaults, next: 6 }, { ...defaults, next: 0.5 },
    { ...defaults, colors: ['#000000'] }, { ...defaults, colors: Array(6).fill('#ffffff') },
    { ...defaults, selectedColor: 'url(javascript:alert(1))' }, { ...defaults, version: 2 }]) {
    assert.deepEqual(readHighlightPalette(invalid), defaults);
  }
  const saved = { ...defaults, selectedColor: '#9B59B6' };
  const loaded = readHighlightPalette(saved);
  assert.equal(loaded.selectedColor, '#9b59b6'); assert.notEqual(loaded.colors, saved.colors);
});

test('reset restores defaults and replacement order while remembering an armed custom color or erase', () => {
  for (const color of ['#9b59b6', null]) {
    const reset = defaultHighlightPalette(color);
    assert.equal(reset.selectedColor, color); assert.equal(reset.next, 0);
    assert.deepEqual(reset.colors, defaultHighlightPalette().colors);
  }
});
