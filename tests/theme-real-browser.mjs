import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ mode: 'web', server: { port: 0, open: false } });
const artifacts = await mkdtemp(path.join(tmpdir(), 'panvas-theme-review-'));
let browser;
let passed = 0;
const errors = [];
const settle = page => page.evaluate(async () => {
  for (let frame = 0; frame < 5; frame++) await new Promise(requestAnimationFrame);
  await new Promise(resolve => setTimeout(resolve, 220));
});
const state = page => page.evaluate(() => {
  const fixture = window.themeFixture;
  const paper = document.getElementById('page-' + fixture.id);
  const canvas = paper.querySelector('canvas[data-rendered-page-id]');
  const text = paper.querySelector('[data-text-object-id]');
  const bounds = paper.getBoundingClientRect();
  const zoom = bounds.width / 794;
  return {
    paper: getComputedStyle(paper).backgroundColor,
    filter: getComputedStyle(canvas).filter,
    textFilter: getComputedStyle(text).filter,
    textBounds: { x: text.getBoundingClientRect().x, y: text.getBoundingClientRect().y },
    saved: JSON.stringify(fixture.data().objects),
    pixels: [{ x: bounds.x + 30 * zoom, y: bounds.y + 285 * zoom }, { x: bounds.x + 240 * zoom, y: bounds.y + 310 * zoom }],
  };
});
async function screenshotPixels(page, file, points) {
  const png = await page.screenshot({ path: file });
  return page.evaluate(async ({ data, points }) => {
    const image = new Image(); image.src = data; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return points.map(point => Array.from(context.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data));
  }, { data: 'data:image/png;base64,' + png.toString('base64'), points });
}

try {
  await server.listen();
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  for (const profile of [{ name: 'desktop', width: 1920, height: 1200 }, { name: 'phone', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height } });
    await context.addInitScript(() => {
      localStorage.setItem('panvas-theme', 'light');
      sessionStorage.setItem('panvas.cloudSyncPromptDismissed', 'true');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + 'tests/fixtures/theme-templates.html?appearance');
    await page.getByRole('heading', { name: 'Appearance', exact: true }).waitFor();
    const cards = page.getByRole('button').filter({ hasText: /^(Light|Ink|Dark)/ });
    assert.equal(await cards.count(), 3);
    const backgrounds = [];
    for (const theme of ['Ink', 'Dark', 'Light']) {
      const card = page.getByRole('button', { name: new RegExp('^' + theme + '\\b') });
      await card.click();
      assert.equal(await card.getAttribute('aria-pressed'), 'true');
      backgrounds.push(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()));
      passed++;
    }
    assert.equal(new Set(backgrounds).size, 3);
    await page.goto(base + 'tests/fixtures/theme-templates.html');
    await page.waitForFunction(() => window.themeFixture
      && window.themeFixture.engine()?.getDrawingOwnership().pageId === window.themeFixture.id
      && document.querySelector('canvas[data-render-ready="true"]'));
    await settle(page);
    const before = await state(page);
    for (const theme of ['light', 'ink', 'dark', 'light']) {
      await page.evaluate(theme => window.themeFixture.theme(theme), theme);
      await settle(page);
      const next = await state(page);
      assert.equal(next.paper, 'rgb(255, 249, 196)');
      assert.equal(next.filter, theme === 'ink' ? 'saturate(0.5)' : 'none');
      assert.equal(next.textFilter, next.filter);
      assert.equal(next.saved, before.saved);
      assert.deepEqual(next.textBounds, before.textBounds);
      const exported = await page.evaluate(() => window.themeFixture.exportPixels());
      assert.deepEqual(exported.paper, [255, 249, 196, 255]);
      assert.deepEqual(exported.red, theme === 'ink' ? [155, 27, 27, 255] : [255, 0, 0, 255]);
      assert.equal(exported.warnings.length, 0);
      if (profile.name === 'desktop') {
        const pixels = await screenshotPixels(page, path.join(artifacts, profile.name + '-' + theme + '.png'), next.pixels);
        assert.deepEqual(pixels[0], exported.paper);
        for (let channel = 0; channel < 4; channel++) assert.ok(Math.abs(pixels[1][channel] - exported.red[channel]) <= 1, 'Screen/export color mismatch');
      } else await page.screenshot({ path: path.join(artifacts, profile.name + '-' + theme + '.png') });
      passed++;
    }
    const image = await page.evaluate(() => window.themeFixture.imagePixels());
    assert.deepEqual(image.pixel, [155, 27, 27, 255]);
    assert.deepEqual([image.width, image.height], [4, 2]);
    assert.equal(image.unchanged, true);
    passed++;

    await page.getByRole('button', { name: 'Open page and view inspector' }).click();
    for (const [label, paperColor] of [['White', 'rgb(255, 255, 255)'], ['Yellow', 'rgb(255, 249, 196)'], ['Charcoal', 'rgb(35, 35, 35)'], ['Mint', 'rgb(232, 245, 233)'], ['Custom', 'rgb(66, 106, 149)']]) {
      if (label === 'Custom') await page.locator('label[title="Custom color picker"] input').fill('#426a95');
      else await page.getByRole('button', { name: 'Select paper color ' + label, exact: true }).click();
      for (const theme of ['light', 'ink', 'dark']) {
        await page.evaluate(theme => window.themeFixture.theme(theme), theme);
        await settle(page);
        assert.equal((await state(page)).paper, paperColor);
        passed++;
      }
    }
    if (profile.name === 'desktop') {
      // Match the supplied mint-paper/ruled/Pencil Settings/inspector layout in
      // an isolated notebook; this fixture never reads the user's notebooks.
      await page.getByRole('button', { name: 'Select paper color Mint', exact: true }).click();
      await page.locator('.panvas-properties-panel select').filter({ has: page.locator('option[value="Ruled"]') }).selectOption('Ruled');
      await page.evaluate(() => window.themeFixture.theme('ink'));
      await page.getByRole('button', { name: 'Pencil (N)', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Pencil settings', exact: true });
      await settings.waitFor();
      await settings.getByRole('button', { name: 'Pencil color #CC0000', exact: true }).click();
      await settle(page);
      const saved = await page.evaluate(() => JSON.stringify({ objects: window.themeFixture.data().objects, properties: window.themeFixture.data().properties }));
      const controls = page.locator('.panvas-tool-control');
      const layout = await controls.evaluateAll(items => items.map(item => ({ label: item.getAttribute('aria-label'), width: item.getBoundingClientRect().width, height: item.getBoundingClientRect().height })));
      for (const theme of ['ink', 'light', 'dark', 'ink']) {
        await page.evaluate(theme => window.themeFixture.theme(theme), theme);
        await settle(page);
        assert.equal((await state(page)).paper, 'rgb(232, 245, 233)');
        assert.equal(await page.evaluate(() => JSON.stringify({ objects: window.themeFixture.data().objects, properties: window.themeFixture.data().properties })), saved);
        assert.deepEqual(await controls.evaluateAll(items => items.map(item => ({ label: item.getAttribute('aria-label'), width: item.getBoundingClientRect().width, height: item.getBoundingClientRect().height }))), layout);
        assert.equal(await page.locator('body').evaluate(item => getComputedStyle(item).filter), 'none');
        if (theme === 'ink') {
          for (const selector of ['.panvas-sidebar', '.panvas-topbar', '.panvas-toolbar-surface', '.panvas-properties-panel']) {
            const color = await page.locator(selector).first().evaluate(item => getComputedStyle(item).backgroundColor);
            const [r, g, b] = color.match(/\d+/g).map(Number);
            assert.ok(r > g && g > b, selector + ' has warm-neutral chrome');
          }
          assert.equal(await settings.evaluate(item => getComputedStyle(item).backgroundColor), 'rgb(216, 213, 200)');
          assert.equal(await settings.locator('.panvas-ink-palette').last().evaluate(item => getComputedStyle(item).filter), 'saturate(0.5)');
        }
        await page.screenshot({ path: path.join(artifacts, 'desktop-polish-' + theme + '-settings.png') });
        passed++;
      }
      await page.getByRole('button', { name: 'Close Pencil settings', exact: true }).click();
      await page.evaluate(() => window.themeFixture.theme('dark'));
      await settle(page);
      const toolbar = page.locator('.panvas-floating-toolbar > .panvas-toolbar-surface');
      const strip = page.locator('[aria-label="Pencil quick presets"]');
      const surface = locator => locator.evaluate(item => {
        const css = getComputedStyle(item);
        return { background: css.background, border: css.borderColor, radius: css.borderRadius, shadow: css.boxShadow };
      });
      assert.deepEqual(await surface(toolbar), await surface(strip));
      const pencil = page.getByRole('button', { name: 'Pencil (N)', exact: true });
      assert.equal(await pencil.getAttribute('aria-pressed'), 'true');
      assert.equal(await pencil.evaluate(item => getComputedStyle(item).backgroundColor), 'rgb(62, 71, 79)');
      assert.equal(await pencil.locator('svg').evaluate(item => getComputedStyle(item).filter), 'none', 'Colored tools have no pale glow');
      assert.equal(await page.getByRole('button', { name: 'Pen (P)', exact: true }).locator('svg').evaluate(item => getComputedStyle(item).stroke), 'rgba(244, 243, 239, 0.9)', 'Black tool symbol stays readable');
      const swatch = strip.getByRole('button', { name: 'Pencil color #CC0000', exact: true });
      assert.equal(await swatch.evaluate(item => getComputedStyle(item).getPropertyValue('--tw-ring-offset-color').trim()), 'rgb(43 47 49)');
      await page.screenshot({ path: path.join(artifacts, 'desktop-polish-dark-toolbar.png') });
      const toolbarBounds = await toolbar.boundingBox();
      const stripBounds = await strip.boundingBox();
      await page.screenshot({ path: path.join(artifacts, 'desktop-polish-dark-controls.png'), clip: {
        x: toolbarBounds.x - 8, y: toolbarBounds.y - 8, width: toolbarBounds.width + 16,
        height: stripBounds.y + stripBounds.height - toolbarBounds.y + 16,
      } });
      passed++;
    }
    await page.getByRole('button', { name: 'Select paper color Yellow', exact: true }).click();
    await page.evaluate(() => window.themeFixture.theme('ink'));
    for (const [name, id, margins] of [['Large Ruled with Margin', 'Large ruled with margin', 1], ['Double Margin Ruled', 'Double margin ruled', 2]]) {
      await page.getByRole('button', { name: 'Browse template gallery', exact: true }).click();
      await page.getByRole('button', { name: 'Basic Paper', exact: true }).click();
      const card = page.getByRole('button', { name: new RegExp('^' + name) });
      const preview = await card.locator('svg[viewBox]').evaluate(svg => ({
        paper: getComputedStyle(svg).backgroundColor,
        filter: getComputedStyle(svg.querySelector('g.panvas-colored-content')).filter,
        margins: [...svg.querySelectorAll('line')].filter(line => line.getAttribute('x1') === line.getAttribute('x2')).length,
      }));
      assert.equal(preview.paper, 'rgb(255, 249, 196)');
      assert.equal(preview.filter, 'saturate(0.5)');
      assert.equal(preview.margins, margins);
      await card.click();
      await page.getByRole('button', { name: 'Apply to current page', exact: true }).click();
      await page.waitForFunction(id => window.themeFixture.data().properties.template === id, id);
      const exported = await page.evaluate(() => window.themeFixture.exportPixels());
      assert.ok(!exported.warnings.some(warning => warning.code === 'template-approximated'));
      assert.equal((await state(page)).paper, 'rgb(255, 249, 196)');
      passed++;
    }
    await page.screenshot({ path: path.join(artifacts, profile.name + '-inspector.png') });
    await context.close();
    console.log(profile.name + ' theme/template/export checks passed');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed, artifacts, errors }));
} finally {
  await browser?.close();
  await server.close();
}
