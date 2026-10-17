import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';

const out = 'artifacts/documentation-flow';
await mkdir(out, { recursive: true });
const server = await createServer({ mode: 'web', optimizeDeps: { entries: ['tests/fixtures/documentation-engine.html'] }, server: { port: 0, open: false } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(server.resolvedUrls.local[0] + 'tests/fixtures/documentation-engine.html');
  await page.waitForFunction(() => window.richFixture?.ready());
  const result = await page.evaluate(async () => {
    const html = '<h1>Technical documentation</h1><p>java</p><pre><code class="language-java">public class Demo {\n  public static void main(String[] args) {\n    System.out.println("Hello");\n  }\n}</code></pre>' + Array.from({ length: 50 }, (_, i) => `<p>Paragraph ${i + 1}. ${'A long technical explanation retains all of its content and structure. '.repeat(8)}</p>`).join('');
    const content = window.richFixture.parseHtml(html);
    await window.richFixture.reset([content]);
    return { clipboardHtml: html, parsed: content };
  });
  await page.waitForFunction(() => window.richFixture.editor()?.view.dom.isConnected);
  await page.evaluate(() => window.richFixture.editor().commands.focus('start'));
  await page.screenshot({ path: out + '/baseline-freeform.png' });
  result.geometry = await page.evaluate(() => {
    const editor = window.richFixture.editor(), paper = document.querySelector('[id^="page-"]');
    return { editorWidth: editor.view.dom.getBoundingClientRect().width, editorHeight: editor.view.dom.getBoundingClientRect().height, paperHeight: paper.getBoundingClientRect().height, languages: editor.getJSON().content.filter(node => node.type === 'codeBlock').map(node => node.attrs.language), tokens: editor.view.dom.querySelectorAll('[class*="hljs-"]').length, sheets: document.querySelectorAll('[data-page-index]').length };
  });
  await writeFile(out + '/baseline.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.geometry));
} finally { await browser.close(); await server.close(); }
