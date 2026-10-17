import assert from 'node:assert/strict';
import { openNotebookProperties, closeNotebookProperties, chooseWritingLayout } from './helpers/notebook-properties.mjs';

const formulae = String.raw`Inline \(n\).

\[ T(n)=3n^2+5n+10 \]

\[ \boxed{T(n)=O(n^2)} \]

Dollar $x^2$ and currency $5 and $10.

$$x+y=z$$`;
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const longCode = 'public class Main {\n    String message = "' + 'A genuinely long code line with spaces and_very_long_identifiers_'.repeat(18) + '";\n    // ' + 'unbroken_identifier_'.repeat(60) + '\n}\n';
const codeHTML = (code, language = 'java') => `<pre><code class="language-${language}">${escape(code)}</code></pre>`;

export async function runDocumentationPolish({ page, app, native, phase, mode, out, evidence, workload, createDocument, settle, waitSaved }) {
  const baseline = phase.includes('before');
  const checks = evidence.polish = {};
  const json = () => page.evaluate(() => window.workflowProbe.editor().getJSON());
  const paste = async (text, html = '') => {
    await page.evaluate(({ text, html }) => {
      const editor = window.workflowProbe.editor(); editor.commands.focus('start'); editor.commands.selectAll();
      const data = new DataTransfer(); data.setData('text/plain', text); if (html) data.setData('text/html', html);
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, { text, html }); await settle();
  };
  const counts = () => page.evaluate(() => {
    const counts = {}; window.workflowProbe.editor().state.doc.descendants(node => counts[node.type.name] = (counts[node.type.name] ?? 0) + 1);
    return { counts, rendered: window.workflowProbe.editor().view.dom.querySelectorAll('.katex').length, json: window.workflowProbe.editor().getJSON() };
  });
  await createDocument('Documentation polish', 'A4');
  await paste(formulae); checks.plainMath = await counts();
  await page.screenshot({ path: `${out}/${phase}-${mode}-math-plain.png` });
  await paste(formulae, formulae.split('\n\n').map(line => `<p>${escape(line)}</p>`).join('')); checks.htmlMath = await counts();
  await page.screenshot({ path: `${out}/${phase}-${mode}-math-html.png` });
  if (!baseline) for (const result of [checks.plainMath, checks.htmlMath]) {
    assert.equal(result.counts.inlineMath, 2); assert.equal(result.counts.blockMath, 3); assert.equal(result.rendered, 5); assert.equal(result.counts.paragraph,2);
    assert.ok(JSON.stringify(result.json).includes('$5 and $10'));
  }
  if (native) {
    await app.evaluate(({clipboard},text)=>{globalThis.mathClipboard={text:clipboard.readText(),html:clipboard.readHTML(),rtf:clipboard.readRTF(),image:clipboard.readImage(),bookmark:clipboard.readBookmark()};clipboard.writeText(text);},formulae);
    try { await page.evaluate(()=>{const editor=window.workflowProbe.editor();editor.commands.focus('start');editor.commands.selectAll();});await page.keyboard.press('Control+v');await settle();checks.nativeMath=await counts();if(!baseline){assert.equal(checks.nativeMath.counts.inlineMath,2);assert.equal(checks.nativeMath.counts.blockMath,3);assert.equal(checks.nativeMath.rendered,5);} }
    finally { await app.evaluate(({clipboard})=>{const {bookmark,...data}=globalThis.mathClipboard;clipboard.write(data);if(bookmark.url)clipboard.writeBookmark(bookmark.title,bookmark.url);delete globalThis.mathClipboard;}); }
  }
  const literal=String.raw`Costs $5 and $10. Ordinary $ sign. Unmatched \(n. Inline code `+'`'+String.raw`\(x\) $y$`+'`';
  await paste(literal);checks.literalPlain=await counts();if(!baseline){assert.equal(checks.literalPlain.rendered,0);assert.equal(await page.evaluate(()=>window.workflowProbe.editor().getText()),literal.replaceAll('`',''));assert.ok(checks.literalPlain.json.content[0].content.some(node=>node.marks?.some(mark=>mark.type==='code')&&node.text===String.raw`\(x\) $y$`));}
  const literalCode=String.raw`\(n\) $x^2$ \[x+y\]`;
  await paste(literalCode,`<p>Currency $5 and $10. <code>${escape(literalCode)}</code></p>${codeHTML(literalCode,'latex')}`);checks.literalHTML=await counts();if(!baseline){assert.equal(checks.literalHTML.rendered,0);assert.equal(checks.literalHTML.json.content.find(node=>node.type==='codeBlock').content[0].text,literalCode);}
  await paste('```latex\n'+literalCode+'\n```');checks.literalFence=await counts();if(!baseline){assert.equal(checks.literalFence.counts.codeBlock,1);assert.equal(checks.literalFence.rendered,0);}
  await paste(longCode, codeHTML(longCode));
  const block = page.locator('[data-document-body] .panvas-code-block').first();
  const bounds = () => block.evaluate(root => {
    const pre = root.querySelector('pre'), code = pre.querySelector('code'), range = document.createRange(); range.selectNodeContents(code);
    return { text: code.textContent, wrap: pre.dataset.codeWrap, whiteSpace: getComputedStyle(code).whiteSpace,
      preWidth: pre.clientWidth, scrollWidth: pre.scrollWidth, height: pre.offsetHeight, textWidth: range.getBoundingClientRect().width,
      documentWidth: root.closest('.ProseMirror').offsetWidth, rootOverflow: root.closest('.ProseMirror').scrollWidth > root.closest('.ProseMirror').clientWidth + 2 };
  });
  checks.wrapOff = await bounds();
  await page.evaluate(()=>window.workflowProbe.editor().commands.setTextSelection({from:50,to:70}));
  await workload('wrap-on', () => block.getByRole('button', { name: 'Wrap lines', exact: true }).click()); checks.wrapOn = await bounds();
  if(!baseline) assert.deepEqual(await page.evaluate(()=>({from:window.workflowProbe.editor().state.selection.from,to:window.workflowProbe.editor().state.selection.to})),{from:50,to:70});
  await page.screenshot({ path: `${out}/${phase}-${mode}-wrap-on.png` });
  await block.getByRole('button', { name: 'Wrap lines', exact: true }).click(); await settle(); checks.wrapOffAgain = await bounds();
  if (!baseline) { assert.equal(checks.wrapOn.text, longCode); assert.equal(checks.wrapOffAgain.text, longCode); assert.ok(checks.wrapOn.height > checks.wrapOff.height * 2); assert.ok(checks.wrapOn.scrollWidth <= checks.wrapOn.preWidth + 2); assert.ok(checks.wrapOff.scrollWidth > checks.wrapOff.preWidth * 2); assert.equal(checks.wrapOff.rootOverflow, false); }
  const manyCode = Array.from({ length: 40 }, (_, i) => `<h3>Example ${i}</h3>${codeHTML('public class Example' + i + ' {\n' + Array.from({length:18}, (_, j) => `    int value${j} = ${i + j}; // example ${i}`).join('\n') + '\n}')}`).join('');
  await paste('Many Java examples', manyCode);
  const first = page.locator('[data-document-body] .panvas-code-block').first();
  await first.locator('pre').click(); await page.keyboard.press('Home'); await settle();
  const selection = await page.evaluate(() => { const editor = window.workflowProbe.editor(); editor.commands.setTextSelection({ from: editor.state.selection.from, to: editor.state.selection.from + 6 }); return { from: editor.state.selection.from, to: editor.state.selection.to }; });
  if (native) await app.evaluate(({ clipboard }) => { globalThis.polishClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage(), bookmark: clipboard.readBookmark() }; });
  else await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  try {
    await workload('copy-code', async () => { await first.getByRole('button', { name: 'Copy code', exact: true }).click(); await first.getByRole('button', { name: 'Copied', exact: true }).waitFor(); });
    const selected = await page.evaluate(() => ({ from: window.workflowProbe.editor().state.selection.from, to: window.workflowProbe.editor().state.selection.to })); assert.deepEqual(selected, selection);
    checks.copied = native ? await app.evaluate(({ clipboard }) => clipboard.readText()) : await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(checks.copied.startsWith('public class Example0'));
  } finally { if (native) await app.evaluate(({ clipboard }) => { const {bookmark,...data} = globalThis.polishClipboard; clipboard.write(data); if (bookmark.url) clipboard.writeBookmark(bookmark.title,bookmark.url); delete globalThis.polishClipboard; }); }
  await workload('open-code-language', async () => { await first.locator('summary').click(); await page.getByRole('searchbox', { name: 'Search code languages', exact: true }).waitFor(); });
  await page.getByRole('searchbox', { name: 'Search code languages', exact: true }).fill('Plain Text');
  await workload('language-to-plain', () => page.getByRole('option', { name: 'Plain Text', exact: true }).click());
  assert.equal(await first.locator('.hljs-keyword').count(), 0);
  await first.locator('summary').click(); await page.getByRole('searchbox', { name: 'Search code languages', exact: true }).fill('Java');
  await workload('language-to-java', () => page.getByRole('option', { name: 'Java', exact: true }).click());
  assert.ok(await first.locator('.hljs-keyword').count());
  await first.locator('pre').click(); await page.keyboard.press('End'); await settle();
  await workload('edit-code-8-keys', async () => { for (const char of ' example') { await page.keyboard.type(char); await settle(2); } });
  if(!baseline) {
    const latest=await first.locator('code').textContent();
    if(native)await app.evaluate(({clipboard})=>{globalThis.latestClipboard={text:clipboard.readText(),html:clipboard.readHTML(),rtf:clipboard.readRTF(),image:clipboard.readImage(),bookmark:clipboard.readBookmark()};});
    try{await first.getByRole('button',{name:'Copy code',exact:true}).click();await first.getByRole('button',{name:'Copied',exact:true}).waitFor();const copied=native?await app.evaluate(({clipboard})=>clipboard.readText()):await page.evaluate(()=>navigator.clipboard.readText());assert.equal(copied.replace(/\r\n/g,'\n'),latest.replace(/\r\n/g,'\n'));checks.copyAfterEditExact=true;}
    finally{if(native)await app.evaluate(({clipboard})=>{const {bookmark,...data}=globalThis.latestClipboard;clipboard.write(data);if(bookmark.url)clipboard.writeBookmark(bookmark.title,bookmark.url);delete globalThis.latestClipboard;});}
  }
  await workload('select-code', async () => { for (let i=0;i<16;i++) await page.keyboard.press('Shift+ArrowRight'); });
  await workload('formatting-menu', async () => { await page.getByRole('button', { name: 'More text formatting', exact: true }).click(); await page.getByRole('dialog', { name: 'Text formatting options', exact: true }).waitFor(); }); await page.keyboard.press('Escape');
  await workload('scroll-code-document', async () => { await page.locator('.notebook-viewport').hover(); for (let i=0;i<8;i++) { await page.mouse.wheel(0,550); await settle(2); } });
  checks.finalJSON = await json(); checks.sheets = Number(await page.locator('[data-document-sheet-count]').last().getAttribute('data-document-sheet-count'));
  await page.screenshot({ path: `${out}/${phase}-${mode}-code-document.png` });
  if (!baseline) {
    const themedCode=page.locator('[data-document-body] .panvas-code-block').first();
    for(const theme of ['standard-dark','light','dark']) {
      const targetTheme=theme==='standard-dark'?'dark':theme;
      for(let attempt=0;attempt<4;attempt++) {
        const current=await page.locator('html').evaluate(root=>root.classList.contains('dark')?'dark':root.classList.contains('theme-ink')?'ink':'light');
        if(current===targetTheme)break;
        await page.getByRole('button',{name:/^Switch to .* theme$/}).click(); await settle();
        const choice=page.getByRole('alertdialog',{name:'Enable Full Dark View?',exact:true}); if(await choice.count())await choice.getByRole('button',{name:theme==='standard-dark'?'Standard Dark':'Full Dark View',exact:true}).click();
      }
      await themedCode.scrollIntoViewIfNeeded(); await settle();
      checks['theme-'+theme]=await themedCode.evaluate(root=>{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');
        const rgba=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].map((v,i)=>i===3?v/255:v);};
        const luminance=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
        const colors=[];
        for(const token of root.querySelectorAll('[class*="hljs-"],summary,button')) {
          const foreground=rgba(getComputedStyle(token).color), ancestors=[];let element=token;
          while(element){ancestors.push(element);element=element.parentElement;}
          let bg=[255,255,255];for(const element of ancestors.reverse()){const next=rgba(getComputedStyle(element).backgroundColor);bg=bg.map((v,i)=>v*(1-next[3])+next[i]*next[3]);}
          const a=luminance(foreground),b=luminance(bg);colors.push({class:token.className,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});
        }
        return {themeClasses:document.documentElement.className,background:getComputedStyle(root).backgroundColor,foreground:getComputedStyle(root).color,minContrast:Math.min(...colors.map(c=>c.ratio)),colors};
      });
      assert.ok(checks['theme-'+theme].minContrast>=4.5,JSON.stringify(checks['theme-'+theme]));
      await page.screenshot({path:`${out}/${phase}-${mode}-code-${theme}.png`});
    }
    assert.equal(await page.getByRole('button', {name:'Writing mode and paper',exact:true}).count(),0);
    const canonical=await json(), panel=await openNotebookProperties(page);
    assert.equal(await panel.getByRole('group',{name:'Writing layout'}).getByRole('button',{name:'Document',exact:true}).getAttribute('aria-pressed'),'true');
    await panel.getByRole('combobox',{name:'Page Size',exact:true}).selectOption('Infinite'); await settle();
    checks.documentInfinite=await page.evaluate(()=>({properties:window.workflowProbe.snapshot().properties,width:window.workflowProbe.editor().view.dom.offsetWidth,height:window.workflowProbe.editor().view.dom.offsetHeight,gaps:window.workflowProbe.editor().view.dom.querySelectorAll('.panvas-page-gap').length}));
    assert.equal(checks.documentInfinite.properties.layoutMode,'document'); assert.equal(checks.documentInfinite.width,666); assert.ok(checks.documentInfinite.height>10000); assert.equal(checks.documentInfinite.gaps,0); assert.deepEqual(await json(),canonical);
    await chooseWritingLayout(page,'Freeform'); await settle();
    assert.equal(await panel.getByRole('combobox',{name:'Page Size'}).inputValue(),'Infinite');
    assert.equal((await page.evaluate(()=>window.workflowProbe.snapshot())).properties.layoutMode,'freeform');
    await panel.getByRole('combobox',{name:'Page Size'}).selectOption('A4'); await settle();
    assert.equal((await page.evaluate(()=>window.workflowProbe.snapshot())).properties.layoutMode,'freeform');
    await chooseWritingLayout(page,'Document'); await settle(); assert.deepEqual(await json(),canonical);
    assert.ok(Number(await page.locator('[data-document-sheet-count]').last().getAttribute('data-document-sheet-count'))>=3);
    await page.screenshot({path:`${out}/${phase}-${mode}-sidebar-layout.png`}); await closeNotebookProperties(page);
    checks.fourModeCombinations=true;

    await paste(formulae,formulae.split('\n\n').map(line=>`<p>${escape(line)}</p>`).join(''));
    await page.locator('[data-document-body] [data-type="block-math"]').first().click({button:'right'});
    const menu=page.getByLabel('Document block menu',{exact:true}); await menu.getByRole('tab',{name:'Insert',exact:true}).click(); await menu.getByRole('button',{name:'Equation…',exact:true}).click();
    const latex=menu.getByRole('textbox',{name:'LaTeX source',exact:true}); assert.equal((await latex.inputValue()).trim(),'T(n)=3n^2+5n+10');
    await latex.fill('T(n)=4n^2+7'); await menu.getByRole('button',{name:'Block equation',exact:true}).click(); await page.keyboard.press('Escape');
    const edited=await json(); assert.equal(edited.content.find(node=>node.type==='blockMath').attrs.latex,'T(n)=4n^2+7');
    await waitSaved(edited); await page.reload(); await page.waitForFunction(()=>window.workflowProbe?.ready()&&Boolean(window.workflowProbe.editor())); await settle(); assert.deepEqual(await json(),edited); checks.mathEditReopenExact=true;
    await page.screenshot({path:`${out}/${phase}-${mode}-math-reopened.png`});

    await createDocument('Freeform math and wrapping','Infinite','freeform');
    await page.getByTitle('Text (T)',{exact:true}).click(); const canvas=page.locator('[data-live-page-visual] canvas').first(), box=await canvas.boundingBox(); await page.mouse.click(box.x+80,Math.max(200,box.y+140));
    await page.locator('[data-text-object-id] .ProseMirror').last().click();
    await page.waitForFunction(()=>window.workflowProbe.editor()?.isFocused);
    await paste(formulae+'\n'+longCode,formulae.split('\n\n').map(line=>`<p>${escape(line)}</p>`).join('')+codeHTML(longCode));
    const freeformPage=await page.evaluate(()=>window.workflowProbe.location().pageId), freeformRoot=page.locator(`#page-${freeformPage}`), freeformLive=freeformRoot.locator('[data-live-page-visual]'), freeformCode=freeformLive.locator('.panvas-code-block').first();
    assert.equal(await freeformLive.locator('.katex').count(),5);
    await freeformCode.getByRole('button',{name:'Wrap lines',exact:true}).click(); await settle(); const freeformJSON=await json();
    await page.getByTitle('Hand (Space)',{exact:true}).click(); await settle();
    const staticCode=await freeformCode.locator('pre').evaluate(pre=>({text:pre.textContent,whiteSpace:getComputedStyle(pre.querySelector('code')).whiteSpace,width:pre.clientWidth,scrollWidth:pre.scrollWidth,height:pre.offsetHeight}));
    assert.equal(staticCode.text,longCode); assert.equal(staticCode.whiteSpace,'pre-wrap'); assert.ok(staticCode.scrollWidth<=staticCode.width+2); assert.equal(await freeformLive.locator('.katex').count(),5); checks.readOnlyWrapOn=staticCode;
    await page.screenshot({path:`${out}/${phase}-${mode}-freeform-static.png`});
    const textId=await page.evaluate(()=>window.workflowProbe.snapshot().texts[0].id), deadline=Date.now()+25000;
    while(Date.now()<deadline){const saved=await page.evaluate(async id=>(await window.workflowProbe.saved())?.objects?.find(object=>object.id===id)?.content,textId);if(JSON.stringify(saved)===JSON.stringify(freeformJSON))break; await settle();}
    assert.ok(Date.now()<deadline,'Freeform content must finish saving');
    await page.reload(); await page.waitForFunction(()=>window.workflowProbe?.ready()&&window.workflowProbe.snapshot().texts.length>0); await settle();
    const restored=await page.evaluate(()=>window.workflowProbe.snapshot()); assert.equal(restored.properties.layoutMode,'freeform'); assert.equal(restored.properties.pageSize,'Infinite'); assert.deepEqual(restored.texts[0].content,freeformJSON); checks.freeformReopenExact=true;
    await page.getByTitle('Text (T)',{exact:true}).click(); await freeformLive.locator('p').filter({hasText:'Inline'}).first().click(); await page.waitForFunction(()=>window.workflowProbe.editor()?.isEditable);
    await freeformCode.getByRole('button',{name:'Wrap lines',exact:true}).click(); await settle();
    await freeformCode.locator('pre').hover(); await page.mouse.wheel(1100,0); await settle(); assert.ok(await freeformCode.locator('pre').evaluate(pre=>pre.scrollLeft>0));
    await page.getByTitle('Hand (Space)',{exact:true}).click(); await settle(); checks.readOnlyWrapOff=await freeformCode.locator('pre').evaluate(pre=>({text:pre.textContent,whiteSpace:getComputedStyle(pre.querySelector('code')).whiteSpace,width:pre.clientWidth,scrollWidth:pre.scrollWidth}));
    assert.equal(checks.readOnlyWrapOff.text,longCode); assert.equal(checks.readOnlyWrapOff.whiteSpace,'pre'); assert.ok(checks.readOnlyWrapOff.scrollWidth>checks.readOnlyWrapOff.width*2);
    const offJSON=await page.evaluate(()=>window.workflowProbe.snapshot().texts[0].content), offDeadline=Date.now()+25000;
    while(Date.now()<offDeadline){const saved=await page.evaluate(async id=>(await window.workflowProbe.saved())?.objects?.find(object=>object.id===id)?.content,textId);if(JSON.stringify(saved)===JSON.stringify(offJSON))break;await settle();}
    assert.ok(Date.now()<offDeadline,'Wrap OFF must finish saving');
    await page.reload();await page.waitForFunction(()=>window.workflowProbe?.ready()&&window.workflowProbe.snapshot().texts.length>0);await settle();
    assert.deepEqual(await page.evaluate(()=>window.workflowProbe.snapshot().texts[0].content),offJSON);assert.equal(await freeformCode.locator('pre').evaluate(pre=>getComputedStyle(pre.querySelector('code')).whiteSpace),'pre');checks.wrapOffReopenExact=true;

  }
  await createDocument('Text to code proof'); const prose='public class Conversion { String value = "'+ 'preserve this code text '.repeat(30)+'"; }'; await paste(prose);
  await page.getByRole('button',{name:'More text formatting',exact:true}).click(); const format=page.getByRole('dialog',{name:'Text formatting options',exact:true}); await format.getByRole('tab',{name:'Block',exact:true}).click(); await format.getByRole('button',{name:'Turn into…',exact:true}).click(); await format.getByRole('searchbox',{name:'Search block types',exact:true}).fill('Code');
  await workload('turn-text-to-code',()=>format.getByRole('option',{name:'Code',exact:true}).click()); assert.equal((await json()).content[0].type,'codeBlock'); assert.equal((await json()).content[0].content[0].text,prose);
  await page.keyboard.press('Control+z'); assert.equal((await json()).content[0].type,'paragraph'); assert.equal((await json()).content[0].content[0].text,prose); await page.keyboard.press('Control+Shift+z'); assert.equal((await json()).content[0].type,'codeBlock'); checks.turnIntoUndoExact=true;
  console.log(JSON.stringify({ phase, mode, math: [checks.plainMath.counts, checks.htmlMath.counts], wrapping: [checks.wrapOff.height, checks.wrapOn.height], sheets: checks.sheets }));
}
