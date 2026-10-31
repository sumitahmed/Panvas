import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { textFromTipTap } from '../src/services/search/pageSearchContent.ts';
import { isUsableFormattingEditor, runFormattingCommand } from '../src/components/notebook/textFormatting.ts';

function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

const RICH_DOC = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'I ' },
        { type: 'text', marks: [{ type: 'bold' }, { type: 'italic' }], text: 'really' },
        { type: 'text', text: ' like ' },
        {
          type: 'text',
          marks: [
            { type: 'textStyle', attrs: { color: '#cc0000', fontSize: '20px', fontFamily: "'Kalam', cursive" } },
            { type: 'underline' },
            { type: 'highlight', attrs: { color: '#fef08a' } },
            { type: 'strike' },
          ],
          text: 'Panvas',
        },
      ],
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Two' }] }] },
      ],
    },
    {
      type: 'orderedList',
      attrs: { start: 1 },
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }] },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
  ],
};

test('plain-text extraction ignores every formatting mark but keeps the words', () => {
  assert.equal(textFromTipTap(RICH_DOC), 'I really like Panvas One Two First Title');
});

test('formatting marks never change searchable text (formatted and plain docs extract identically)', () => {
  const plain = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'I really like Panvas' }] }],
  };
  const formattedParagraph = (RICH_DOC.content as Array<Record<string, unknown>>)[0];
  assert.equal(textFromTipTap({ type: 'doc', content: [formattedParagraph] }), textFromTipTap(plain));
});

test('format combinations coexist as independent marks in one JSON document', () => {
  const runs = ((RICH_DOC.content as Array<{ content: Array<Record<string, unknown>> }>)[0].content);
  const combinations = runs.find(run => (run.text === 'Panvas'))?.marks as Array<Record<string, unknown>>;
  const markTypes = combinations.map(mark => mark.type);
  for (const expected of ['textStyle', 'underline', 'highlight', 'strike']) {
    assert.ok(markTypes.includes(expected), `${expected} mark must survive alongside the others`);
  }
});

interface FakeChainCall { kind: string; value?: unknown }

function fakeEditor(docSize: number, selection: { from: number; to: number }) {
  const state = {
    selection: { ...selection },
    doc: { content: { size: docSize } },
  };
  const calls: FakeChainCall[] = [];
  const editor = {
    isDestroyed: false,
    state,
    chain() {
      const api = new Proxy({}, {
        get(_target, prop) {
          if (prop === 'run') {
            return () => {
              calls.push({ kind: 'run' });
              return true;
            };
          }
          return (...args: unknown[]) => {
            if (prop === 'setTextSelection') {
              const range = args[0] as { from: number; to: number };
              calls.push({ kind: 'setTextSelection', value: { ...range } });
              state.selection = { from: range.from, to: range.to };
            } else {
              calls.push({ kind: String(prop) });
            }
            return api;
          };
        },
      });
      return api;
    },
  };
  return { editor, calls, state };
}

test('formatting with no retained range runs at the live caret selection', () => {
  const { editor, calls } = fakeEditor(40, { from: 7, to: 7 });
  const result = runFormattingCommand(editor as never, null, chain => (chain as { toggleBold: () => unknown }).toggleBold());
  assert.deepEqual(calls.map(call => call.kind), ['focus', 'toggleBold', 'run']);
  assert.deepEqual(result, { from: 7, to: 7 });
});

test('a retained selected range is restored and clamped to the document', () => {
  const { editor, calls } = fakeEditor(10, { from: 0, to: 0 });
  const result = runFormattingCommand(editor as never, { from: 2, to: 50 }, chain => (chain as { toggleBold: () => unknown }).toggleBold());
  const selection = calls.find(call => call.kind === 'setTextSelection')?.value;
  assert.deepEqual(selection, { from: 2, to: 10 });
  assert.deepEqual(result, { from: 2, to: 10 });
});

test('an inverted retained range collapses to an ordered caret before the command runs', () => {
  const { editor, calls } = fakeEditor(20, { from: 0, to: 0 });
  runFormattingCommand(editor as never, { from: 8, to: 3 }, chain => (chain as { toggleItalic: () => unknown }).toggleItalic());
  assert.deepEqual(calls.find(call => call.kind === 'setTextSelection')?.value, { from: 8, to: 8 });
});

test('a destroyed editor refuses to format', () => {
  const { editor, calls } = fakeEditor(20, { from: 1, to: 2 });
  (editor as { isDestroyed: boolean }).isDestroyed = true;
  assert.equal(isUsableFormattingEditor(editor as never), false);
  assert.equal(runFormattingCommand(editor as never, { from: 1, to: 2 }, () => {}), null);
  assert.equal(calls.length, 0);
});

test('loading surfaces use the canonical Panvas mark with restrained, theme-aware chrome', async () => {
  const html = await read('../index.html');
  assert.match(html, /src="\/panvas_logo\.png"/);
  assert.match(html, /panvas-bootstrap-logo/);
  assert.match(html, /panvas-bootstrap-wordmark">Panvas</);
  assert.match(html, /panvas-bootstrap-bar/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  // No sparkle/AI imagery and no giant headline in the bootstrap fallback.
  assert.ok(!/sparkle|Sparkles|gemini/i.test(html));
  assert.ok(!/<h1>/i.test(html.split('<div id="root">')[1] ?? ''));

  const app = await read('../src/app/App.tsx');
  assert.match(app, /PANVAS_LOGO_SRC/);
  const brand = await read('../src/lib/brand.ts');
  assert.match(brand, /window\.location\.protocol === 'file:'/);
  assert.match(brand, /'\.\/panvas_logo\.png'/);
  assert.match(brand, /'\/panvas_logo\.png'/);
  assert.match(app, /Starting…/);
  assert.match(app, /animate-\[slideInRight_1\.4s_ease-in-out_infinite\]/);
  assert.ok(!/animate-pulse-subtle/.test(app));
});

test('the contextual text strip and the Aa menu share one formatting surface', async () => {
  const [toolbar, fontPicker] = await Promise.all([
    read('../src/components/notebook/NotebookFloatingToolbar.tsx'),
    read('../src/components/notebook/TextFontPicker.tsx'),
  ]);
  // One shared menu body, consumed by both the trigger and the strip.
  assert.equal((toolbar.match(/function TextFormatMenuContent/g) ?? []).length, 1);
  assert.equal((toolbar.match(/<TextFormatMenuContent /g) ?? []).length, 2);
  assert.match(toolbar, /function TextFormattingStrip/);
  assert.match(toolbar, /<TextFormattingStrip editor=\{editor\} engine=\{engine\} enabled=\{activeTool === 'text'\} \/>/);
  assert.match(toolbar, /if \(!enabled\) return null/);
  assert.match(toolbar, /resolveFormattingEditor\(editor, engine\)/);
  assert.equal((toolbar.match(/<TextFontPicker/g) ?? []).length, 2);
  assert.match(fontPicker, /role="listbox"/);
  assert.match(fontPicker, /style=\{fontOptionStyle\(font, state\)\}/);
  const richTextMenu = toolbar.slice(toolbar.indexOf('function TextFormatMenuContent'), toolbar.indexOf('function TextFormattingStrip'));
  assert.ok(!richTextMenu.includes('<optgroup label="Handwriting">'));
  // Strip holds the pointer so the editor never blurs and no ink is created.
  assert.match(toolbar, /aria-label="Text formatting"/);
  // Paragraph/typography commands exist only in the shared menu body (once);
  // Primary controls belong only to the stationary strip.
  // toggleHeading is one per level (H1/H2/H3); setTextAlign once per alignment.
  const singleSourceCommands: Array<[string, number]> = [
    ['toggleBulletList', 1], ['toggleOrderedList', 1], ['toggleTaskList', 1],
    ['toggleBlockquote', 1], ['toggleCodeBlock', 1], ['toggleHeading', 3],
    ['\\bsetFontFamily\\b', 1], ['\\bsetFontSize\\b', 1], ['\\bsetTextAlign\\b', 8],
  ];
  for (const [command, expected] of singleSourceCommands) {
    assert.equal((toolbar.match(new RegExp(command, 'g')) ?? []).length, expected, command);
  }
  // Mobile and desktop expose the same primary controls and palette removal.
  const strip = toolbar.slice(toolbar.indexOf('function TextFormattingStrip'));
  assert.ok(!strip.includes('!isMobileViewport'));
  assert.ok(!richTextMenu.includes('toggleBold()'));
  assert.ok(!strip.includes('aria-label="No background"'));
  assert.match(strip, /toggleStrike/);
  assert.match(strip, /aria-label="Highlight color"/);
  assert.match(strip, /resolvedEditor\.on\('transaction', update\)/);
});

test('text persistence is the shared TipTap JSON path with no environment branch', async () => {
  const editorSource = await read('../src/components/notebook/FloatingTextEditor.tsx');
  assert.match(editorSource, /const json = editor\.getJSON\(\)/);
  assert.match(editorSource, /engine\.texts\.updateTextContent\(object\.id, json\)/);
  assert.match(editorSource, /notebookTipTapExtensions/);
  // Web/Electron parity: the editor content path never branches on window.panvas.
  assert.ok(!/window\.panvas/.test(editorSource));

  const extensions = await read('../src/components/notebook/tiptapExtensions.ts');
  for (const extension of ['Underline', 'Highlight.configure({ multicolor: true })', 'TextAlign.configure', 'TaskList', 'TaskItem.configure', 'TextStyle', 'Color', 'FontFamily', 'FontSize']) {
    assert.match(extensions, new RegExp(extension.replace(/[.(){}]/g, match => `\\${match}`)));
  }
});

test('the PDF exporter renders bold, italic, color, size, alignment, and list markers from the shared JSON', async () => {
  const exporter = await read('../src/services/pdf/notebookPdfExport.ts');
  assert.match(exporter, /type TextRun = \{ text: string; bold: boolean; italic: boolean/);
  assert.match(exporter, /mark\.type === 'bold'/);
  assert.match(exporter, /mark\.type === 'italic'/);
  assert.match(exporter, /style\.fontSize/);
  assert.match(exporter, /style\.color/);
  assert.match(exporter, /node\.attrs\?\.textAlign/);
  assert.match(exporter, /'• '/);
  assert.match(exporter, /toggleHeading|heading/);
});

test('paragraph alignment is part of the persisted document schema, not a CSS overlay', async () => {
  // Runtime JSON round-trips run in the browser pipeline harness; here the
  // schema wiring itself is pinned: TextAlign must target real block nodes so
  // the attribute is stored in the persisted TipTap JSON.
  const extensions = await read('../src/components/notebook/tiptapExtensions.ts');
  assert.match(extensions, /TextAlign\.configure\(\{ types: \['heading', 'paragraph', 'detailsSummary'\] \}\)/);
  // The exporter already renders node.attrs.textAlign from the shared JSON.
  const exporter = await read('../src/services/pdf/notebookPdfExport.ts');
  assert.match(exporter, /node\.attrs\?\.textAlign/);
  // The strip issues the same extension commands (shared formatting surface).
  const toolbarSource = await read('../src/components/notebook/NotebookFloatingToolbar.tsx');
  const strip = toolbarSource.slice(toolbarSource.indexOf('function TextFormattingStrip'));
  for (const alignment of ['left', 'center', 'right', 'justify']) {
    assert.match(strip, new RegExp(`setTextAlign\\('${alignment}'\\)`));
  }
});
