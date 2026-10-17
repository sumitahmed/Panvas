import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { mergeAttributes, createAtomBlockMarkdownSpec, createInlineMarkdownSpec } from '@tiptap/core';
import katex from 'katex';

test('KaTeX ignores inherited trust and resource-limit options', () => {
  const options = Object.create({ trust: true, maxExpand: Infinity, maxSize: Infinity });
  const html = katex.renderToString('\\href{javascript:alert(1)}{unsafe}', options);
  assert.doesNotMatch(html, /href\s*=\s*["']javascript:/i);
  assert.match(html, /unsafe|unsupported|katex-error/);
  const image = katex.renderToString('\\includegraphics{https://untrusted.invalid/canary.png}', options);
  assert.doesNotMatch(image, /<img\b/i);
});

test('patched Tiptap never turns a JSON __proto__ attribute into executable inherited attributes', () => {
  const malicious = JSON.parse('{"__proto__":{"src":"x-invalid://canary","onerror":"globalThis.canary=1"}}');
  const attrs = mergeAttributes(malicious, { class: 'safe' });
  assert.equal(Object.getPrototypeOf(attrs), Object.prototype);
  assert.equal('onerror' in attrs, false); assert.equal('src' in attrs, false);
  assert.equal(attrs.class, 'safe'); assert.equal(({} as any).onerror, undefined);
});

test('patched Markdown tokenizers process complete adversarial attribute tokens within a bounded time', () => {
  const atom = createAtomBlockMarkdownSpec({ nodeName: 'probe' }).markdownTokenizer!;
  const inline = createInlineMarkdownSpec({ nodeName: 'probe', selfClosing: true }).markdownTokenizer!;
  const start = performance.now();
  (atom.tokenize as any)(`:::probe {${'__QUOTED_0'.repeat(2048)}__QUOTED_0__} :::\n`, [], {});
  (inline.tokenize as any)(`[probe ${'0'.repeat(32768)}]`, [], {});
  assert.ok(performance.now() - start < 1000, 'Two small untrusted Markdown inputs must not stall the main thread for seconds');
});

test('local Excalidraw assets stay anchored to the config script across SPA routes and packaged file URLs', async () => {
  const source = await readFile('public/excalidraw-config.js', 'utf8');
  for (const script of ['https://panvas.example/excalidraw-config.js', 'https://panvas.example/subdir/excalidraw-config.js', 'file:///C:/Program%20Files/Panvas/dist/excalidraw-config.js']) {
    const window: Record<string, unknown> = {};
    runInNewContext(source, { window, document: { currentScript: { src: script }, baseURI: 'https://panvas.example/app/settings/workspace' }, URL });
    assert.equal(window.EXCALIDRAW_ASSET_PATH, new URL('./', script).href);
  }
});
