import assert from 'node:assert/strict';
import { clearNotebookHighlight, chooseNotebookTextColor } from './helpers/notebook-formatting.mjs';

const rust = `<h2><span style="color:#cccccc;background-color:#000000"><strong>Getting started:</strong></span></h2><p><span style="color:#cccccc;background-color:#000000"><strong>What it's used for:</strong> operating systems, web servers, game engines, embedded devices, CLI tools, network services, and parts of <a href="https://www.rust-lang.org/">Firefox (the Servo engine)</a>.</span></p><p><span style="color:#cccccc;background-color:#000000"><em>Install via rustup</em> — then use Cargo.</span></p>`;
export async function runEditingCorrective({page, app, native, phase, mode, out, evidence, createDocument, settle, waitSaved, workload}) {
  const checks = evidence.editing = {};
  const before = phase === 'before';
  let body;
  const json = () => page.evaluate(() => window.workflowProbe.editor().getJSON());
  const set = async content => { await page.evaluate(content => { const e=window.workflowProbe.editor();e.commands.setContent(content);e.commands.focus('start'); },content);await settle(); };
  const paste = async html => {await page.evaluate(html=>{const e=window.workflowProbe.editor();e.commands.selectAll();const d=new DataTransfer();d.setData('text/html',html);d.setData('text/plain','Rust');e.view.dom.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));},html);await settle();};
  const activeBody = async () => page.locator(`#page-${await page.evaluate(()=>window.workflowProbe.location().pageId)} [data-document-body]`);
  const select = async (start, end=start) => {await page.evaluate(({start,end})=>{const e=window.workflowProbe.editor();let from,to;e.state.doc.descendants((n,p)=>{if(!n.isText)return;if(from==null&&n.text.includes(start))from=p+n.text.indexOf(start);if(n.text.includes(end))to=p+n.text.indexOf(end)+end.length;});e.commands.setTextSelection({from,to});e.view.focus();},{start,end});await settle();};
  const blockMenu = async locator => { await locator.click({button:'right',position:{x:30,y:10}});await settle();return page.getByLabel('Document block menu',{exact:true}); };
  const p = text => ({type:'paragraph',...(text?{content:[{type:'text',text}]}:{})});
  const toggle = (title='',children=[p()],open=true) => ({type:'details',attrs:{open},content:[{type:'detailsSummary',...(title?{content:[{type:'text',text:title}]}:{})},{type:'detailsContent',content:children}]});
  const startFreeform = async () => {
    await page.getByTitle('Text (T)',{exact:true}).click();
    await page.waitForFunction(()=>window.workflowProbe.engine().tools.getState().mode==='text');
    const id=await page.evaluate(()=>window.workflowProbe.location().pageId),canvas=page.locator(`canvas[data-rendered-page-id="${id}"][data-render-ready="true"]`);
    await canvas.waitFor({state:'visible'});await canvas.scrollIntoViewIfNeeded();
    checks.freeformClick=await canvas.evaluate(el=>({bounds:el.getBoundingClientRect().toJSON(),canvas:el.outerHTML,tool:window.workflowProbe.engine().tools.getState().mode}));
    await canvas.click({position:{x:250,y:220}});await settle();
    await page.waitForFunction(()=>window.workflowProbe.editor()?.view.dom.isConnected);
  };
  if(process.argv.includes('--freeform-only')){
    await createDocument('Freeform focused check','A4','freeform');await startFreeform();await paste(rust);const marked=await json();await page.keyboard.press('Control+a');await settle();await clearNotebookHighlight(page);await settle();const cleared=await json();assert.equal(JSON.stringify(cleared).includes('highlight'),false);await page.keyboard.press('Control+z');await settle();assert.deepEqual(await json(),marked);await page.keyboard.press('Control+y');await settle();assert.deepEqual(await json(),cleared);checks.freeformClearUndoRedo=true;
    await page.waitForFunction(async expected=>{const saved=await window.workflowProbe.saved();return saved.objects.some(o=>JSON.stringify(o.content)===JSON.stringify(expected));},cleared);checks.writes=await page.evaluate(()=>window.workflowProbe.writes());
    await page.reload();await page.waitForFunction(expected=>window.workflowProbe?.ready()&&JSON.stringify(window.workflowProbe.editor()?.getJSON())===JSON.stringify(expected),cleared);checks.freeformReopen=true;console.log(JSON.stringify({mode,checks}));return;
  }
  if(process.argv.includes('--handoff-only')){
    await createDocument('Before handoff');await paste(rust);await waitSaved(await json());
    await createDocument('After handoff','A4','freeform');await startFreeform();await paste('<p>Positioned content after handoff</p>');const content=await json();await page.waitForFunction(async expected=>{const saved=await window.workflowProbe.saved();return saved.objects.some(o=>JSON.stringify(o.content)===JSON.stringify(expected));},content);
    checks.beforeHandoffReload=await page.evaluate(async()=>({saved:await window.workflowProbe.saved(),snapshot:window.workflowProbe.snapshot(),writes:window.workflowProbe.writes()}));
    await page.reload();await page.waitForFunction(expected=>window.workflowProbe?.ready()&&JSON.stringify(window.workflowProbe.editor()?.getJSON())===JSON.stringify(expected),content);checks.handoffReopen=true;console.log(JSON.stringify({mode,checks}));return;
  }
  if(process.argv.includes('--persistence-only')){
    await createDocument('Typing persistence check','Infinite','document');await paste('<p>Baseline content</p>');const original=await json();await waitSaved(original);
    await page.reload();await page.waitForFunction(expected=>window.workflowProbe?.ready()&&JSON.stringify(window.workflowProbe.editor()?.getJSON())===JSON.stringify(expected),original);await settle();
    await page.getByTitle('Text (T)',{exact:true}).click();await page.waitForFunction(()=>window.workflowProbe.editor().isEditable);body=await activeBody();await body.locator('p').click();await page.waitForFunction(()=>window.workflowProbe.editor().isFocused);await page.keyboard.press('Control+End');await page.keyboard.type('checkpoint');await settle();const typed=await json();await waitSaved(typed);
    checks.persistenceBefore=await page.evaluate(async()=>({snapshot:window.workflowProbe.snapshot(),saved:await window.workflowProbe.saved(),writes:window.workflowProbe.writes()}));
    await page.reload();await page.waitForFunction(expected=>window.workflowProbe?.ready()&&JSON.stringify(window.workflowProbe.editor()?.getJSON())===JSON.stringify(expected),typed);checks.persistenceReopen=true;console.log(JSON.stringify({mode,checks}));return;
  }
  await createDocument('Formatting and block editing');body=await activeBody();
  await paste(rust);
  if(native&&!before){
    await app.evaluate(({clipboard},html)=>{globalThis.editingClipboard={text:clipboard.readText(),html:clipboard.readHTML(),rtf:clipboard.readRTF(),image:clipboard.readImage(),bookmark:clipboard.readBookmark()};clipboard.write({html,text:'Rust formatted reference'});},rust);
    try {await page.keyboard.press('Control+a');await page.keyboard.press('Control+v');await settle();checks.nativeHtmlClipboard=true;}
    finally{await app.evaluate(({clipboard})=>{const{bookmark,...data}=globalThis.editingClipboard;clipboard.write(data);if(bookmark.url)clipboard.writeBookmark(bookmark.title,bookmark.url);delete globalThis.editingClipboard;});}
  }
  const imported=await json();
  await body.locator('h2').click();await page.keyboard.press('Control+Home');await settle();
  checks.importedBlack = await body.locator('mark').first().evaluate(el=>getComputedStyle(el).backgroundColor);
  assert.equal(checks.importedBlack,'rgb(0, 0, 0)');
  await page.screenshot({path:`${out}/${phase}-${mode}-black-unselected.png`});
  await page.keyboard.press('Control+a');await settle();
  if(before){checks.visibleNoBackground=await page.getByRole('button',{name:'No background',exact:true}).count();}
  else {
    await select('rustup');await clearNotebookHighlight(page);await settle();
    assert.equal(await page.evaluate(()=>{const e=window.workflowProbe.editor();return e.state.doc.rangeHasMark(e.state.selection.from,e.state.selection.to,e.schema.marks.highlight);}),false);
    assert.ok(JSON.stringify(await json()).includes('highlight'));await page.keyboard.press('Control+z');await settle();assert.deepEqual(await json(),imported);checks.singleWordHighlightRemoval=true;
    await page.keyboard.press('Control+a');await settle();
    await workload('clear-multiline-highlight',async()=>{await clearNotebookHighlight(page);await settle();});
    const cleared=await json();assert.equal(JSON.stringify(cleared).includes('highlight'),false);assert.ok(JSON.stringify(cleared).includes('bold'));assert.ok(JSON.stringify(cleared).includes('link'));assert.equal(cleared.content[0].type,'heading');
    await page.keyboard.press('Control+z');await settle();assert.deepEqual(await json(),imported);
    await page.keyboard.press('Control+y');await settle();assert.deepEqual(await json(),cleared);checks.clearHighlightUndoRedo=true;
    await page.getByRole('button',{name:'More text formatting',exact:true}).click();
    const menu=page.getByRole('dialog',{name:'Text formatting options',exact:true});
    await menu.getByRole('status').filter({hasText:'Low contrast'}).waitFor();checks.lowContrastHint=true;
    await menu.getByRole('button',{name:'Reset text color',exact:true}).click();await page.keyboard.press('Escape');await settle();
    const natural=await json();assert.equal(JSON.stringify(natural).includes('"color":"rgb(204, 204, 204)"'),false);assert.ok(JSON.stringify(natural).includes('italic'));assert.ok(JSON.stringify(natural).includes('link'));checks.resetColorPreservesSemantics=true;
    await body.locator('h2').click();await settle();await page.screenshot({path:`${out}/${phase}-${mode}-formatting-cleared.png`});
    await waitSaved(natural);await page.reload();await page.waitForFunction(()=>window.workflowProbe?.ready()&&Boolean(window.workflowProbe.editor()));await settle();assert.deepEqual(await json(),natural);checks.formattingReopen=true;
    await page.getByTitle('Text (T)',{exact:true}).click();await page.waitForFunction(()=>window.workflowProbe.editor().isEditable);
  }
  await set({type:'doc',content:[p('Neighbor before'),toggle('Toggle summary',[p('Nested content'),toggle('Inner title',[p('Deep content')])]),p('Neighbor after')]});
  let menu=await blockMenu(body.locator('summary').first());
  await menu.getByRole('button',{name:'Duplicate block',exact:true}).click();await settle();
  checks.duplicateToggleCount=(await json()).content.filter(n=>n.type==='details').length;
  await page.screenshot({path:`${out}/${phase}-${mode}-toggle-duplicate.png`});await page.keyboard.press('Escape');
  if(before){
    menu=await blockMenu(body.locator('summary').first());await menu.getByRole('button',{name:'Delete block',exact:true}).click();await settle();
    checks.deleteToggleCount=(await json()).content.filter(n=>n.type==='details').length;checks.deleteError=await menu.innerText();await page.screenshot({path:`${out}/${phase}-${mode}-stuck-toggle.png`});await page.keyboard.press('Escape');
    menu=await blockMenu(body.locator('summary').first());await menu.getByRole('button',{name:'Turn into…',exact:true}).click();await menu.getByRole('option',{name:'Text',exact:true}).click();await settle();checks.convertedToggleCount=(await json()).content.filter(n=>n.type==='details').length;
    console.log(JSON.stringify({mode,checks}));return;
  }
  assert.equal(checks.duplicateToggleCount,2);
  for(let i=0;i<2;i++){menu=await blockMenu(body.locator('summary').first());await menu.getByRole('button',{name:'Delete block',exact:true}).click();await page.keyboard.press('Escape');await settle();}
  assert.deepEqual((await json()).content.map(n=>n.content?.[0]?.text),['Neighbor before','Neighbor after']);checks.deleteBothCopies=true;
  await page.keyboard.press('Control+z');await settle();assert.equal((await json()).content.filter(n=>n.type==='details').length,1);checks.deleteToggleUndo=true;
  menu=await blockMenu(body.locator('summary').first());await menu.getByRole('button',{name:'Turn into…',exact:true}).click();await menu.getByRole('option',{name:'Text',exact:true}).click();await settle();
  const unwrapped=await json();assert.equal(JSON.stringify(unwrapped).includes('details'),false);assert.deepEqual(unwrapped.content.map(n=>n.content?.[0]?.text),['Neighbor before','Toggle summary','Nested content','Inner title','Deep content','Neighbor after']);checks.nestedToggleToText=true;
  await page.screenshot({path:`${out}/${phase}-${mode}-toggle-unwrapped.png`});
  await page.keyboard.press('Control+z');await settle();assert.equal((await json()).content.filter(n=>n.type==='details').length,1);checks.convertToggleUndo=true;
  await set({type:'doc',content:[p('Before empty'),toggle(),p('After empty')]});await body.locator('summary').click({position:{x:15,y:8}});await page.keyboard.press('Home');await page.keyboard.press('Backspace');await settle();
  assert.equal(JSON.stringify(await json()).includes('details'),false);assert.ok(JSON.stringify(await json()).includes('After empty'));checks.emptyToggleBackspace=true;
  await page.keyboard.press('Control+z');await settle();assert.equal((await json()).content.filter(n=>n.type==='details').length,1);checks.emptyToggleUndo=true;
  for(const open of [true,false]){
    await set({type:'doc',content:[p('Left neighbor'),toggle('Closed or open',[p('Retained body')],open),p('Right neighbor')]});
    const original=await json();menu=await blockMenu(body.locator('summary'));
    await menu.getByRole('button',{name:'Turn into…',exact:true}).click();assert.equal(await menu.getByRole('option',{name:'Code',exact:true}).isDisabled(),true);
    await menu.getByRole('option',{name:'Text',exact:true}).click();await settle();assert.equal(JSON.stringify(await json()).includes('details'),false);assert.ok(JSON.stringify(await json()).includes('Retained body'));
    await page.keyboard.press('Control+z');await settle();assert.deepEqual(await json(),original);
    menu=await blockMenu(body.locator('summary'));await menu.getByRole('button',{name:'Delete block',exact:true}).click();await page.keyboard.press('Escape');await settle();assert.deepEqual((await json()).content.map(n=>n.content?.[0]?.text),['Left neighbor','Right neighbor']);
    await page.keyboard.press('Control+z');await settle();assert.deepEqual(await json(),original);
  }checks.collapsedExpandedConversionDeletionUndo=true;
  // Body cursor resolves the nearest toggle, not its required content wrapper.
  await set({type:'doc',content:[p('Before body'),toggle('Body target',[p('Cursor inside body')]),p('After body')]});
  menu=await blockMenu(body.locator('p').filter({hasText:'Cursor inside body'}));await menu.getByRole('button',{name:'Delete block',exact:true}).click();await page.keyboard.press('Escape');await settle();assert.equal(JSON.stringify(await json()).includes('details'),false);checks.bodyContextDeletesToggle=true;
  await page.keyboard.press('Control+z');await settle();await body.locator('p').filter({hasText:'Cursor inside body'}).click();await page.keyboard.press('Control+Enter');await page.keyboard.type('Exited with keyboard');await settle();
  assert.ok((await json()).content.some(n=>n.type==='paragraph'&&n.content?.[0]?.text==='Exited with keyboard'));checks.keyboardExit=true;
  const blocks=[
    ['paragraph',p('Ordinary target'),'p'],
    ['heading',{type:'heading',attrs:{level:2},content:[{type:'text',text:'Heading target'}]},'h2'],
    ['empty',p(),'p'],
    ['code',{type:'codeBlock',attrs:{language:'rust'},content:[{type:'text',text:'fn main() {}'}]},'pre'],
    ['callout',{type:'callout',content:[p('Callout target')]},'aside p'],
    ['list',{type:'bulletList',content:[{type:'listItem',content:[p('List target')]}]},'li p'],
    ['equation',{type:'blockMath',attrs:{latex:'x^2+y^2'}},'[data-type="block-math"]'],
  ];
  for(const[name,node,selector]of blocks){
    await set({type:'doc',content:[p('Safe before'),node,p('Safe after')]});const original=await json();
    const target=name==='paragraph'||name==='empty'?body.locator('p').nth(1):body.locator(selector).first();
    menu=await blockMenu(target);await menu.getByRole('button',{name:'Delete block',exact:true}).click();await page.keyboard.press('Escape');await settle();
    assert.deepEqual((await json()).content.map(n=>n.content?.[0]?.text),['Safe before','Safe after'],name);await page.keyboard.press('Control+z');await settle();assert.deepEqual(await json(),original,name);checks['deleteUndo-'+name]=true;
    if(['code','callout','list','equation'].includes(name)){
      await page.evaluate(()=>{const e=window.workflowProbe.editor();e.commands.setNodeSelection(e.state.doc.firstChild.nodeSize);e.view.focus();});await page.keyboard.press('Delete');await settle();assert.deepEqual((await json()).content.map(n=>n.content?.[0]?.text),['Safe before','Safe after']);await page.keyboard.press('Control+z');await settle();assert.deepEqual(await json(),original);checks['keyboardDeleteUndo-'+name]=true;
    }
  }
  await set({type:'doc',content:[p('One selected line'),{type:'paragraph',content:[{type:'text',text:'Second selected line',marks:[{type:'bold'}]}]},p('Unselected neighbor')]});
  await select('One selected line','Second selected line');
  const strip=page.getByLabel('Text formatting',{exact:true});assert.equal(await strip.getByRole('button',{name:'Bold (Ctrl+B)',exact:true}).getAttribute('aria-pressed'),'false');
  await strip.getByRole('button',{name:'Bold (Ctrl+B)',exact:true}).click();await settle();assert.equal(await strip.getByRole('button',{name:'Bold (Ctrl+B)',exact:true}).getAttribute('aria-pressed'),'true');
  await strip.getByRole('button',{name:'Bold (Ctrl+B)',exact:true}).click();await settle();assert.equal(JSON.stringify(await json()).includes('bold'),false);checks.mixedMultilineMarks=true;
  await page.keyboard.press('Backspace');await settle();assert.ok(JSON.stringify(await json()).includes('Unselected neighbor'));assert.equal(JSON.stringify(await json()).includes('selected line'),false);await page.keyboard.press('Control+z');await settle();assert.ok(JSON.stringify(await json()).includes('Second selected line'));checks.spanningBackspaceUndo=true;
  await set({type:'doc',content:[p('Move before'),toggle('Move title',[p('Move body')]),p('Move after')]});const movedOriginal=await json();
  menu=await blockMenu(body.locator('summary'));await menu.getByRole('button',{name:'Move block down',exact:true}).click();await page.keyboard.press('Escape');await settle();assert.equal((await json()).content.at(-1).type,'details');await page.keyboard.press('Control+z');await settle();assert.deepEqual(await json(),movedOriginal);checks.moveToggleUndo=true;
  await body.locator('summary').click();await select('Move title');
  await chooseNotebookTextColor(page,'textStyle','#00aa00');await chooseNotebookTextColor(page,'highlight','#ff0000');await settle();
  const inlineColors=await json();assert.ok(JSON.stringify(inlineColors).includes('#00aa00'));assert.ok(JSON.stringify(inlineColors).includes('#ff0000'));
  menu=await blockMenu(body.locator('summary'));await menu.getByLabel('Block background color',{exact:true}).fill('#ffff00');assert.equal(await menu.getByLabel('Block background color',{exact:true}).inputValue(),'#ffff00');await menu.getByRole('button',{name:'Reset block colors',exact:true}).click();await page.keyboard.press('Escape');await settle();
  assert.equal((await json()).content[1].attrs.blockBackground,null);assert.ok(JSON.stringify(await json()).includes('#ff0000'));checks.blockResetPreservesInlineColors=true;
  await select('Move title');await strip.getByRole('button',{name:'More text formatting',exact:true}).click();const formatting=page.getByRole('dialog',{name:'Text formatting options',exact:true});await formatting.getByRole('button',{name:'Reset text formatting',exact:true}).click();await page.keyboard.press('Escape');await settle();assert.equal(JSON.stringify(await json()).includes('highlight'),false);assert.equal((await json()).content[1].type,'details');checks.inlineResetKeepsStructure=true;
  await set({type:'doc',content:[p('One selected line'),p('Second selected line'),p('Unselected neighbor')]});
  // The integrated row owns layout space; legacy snapshots used a page overlay.
  for(const width of (native?[1440,780,680]:[1440,780,460])){
    if(native) await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,1100),width);else await page.setViewportSize({width,height:1100});
    await body.locator('p').first().scrollIntoViewIfNeeded();await settle();
    await page.evaluate(()=>{const e=window.workflowProbe.editor(),scroller=e.view.dom.closest('.notebook-viewport');const block=e.view.dom.querySelector('p');scroller.scrollTop+=block.getBoundingClientRect().top-145;});
    await select('One selected line');
    const rect=await strip.boundingBox(),bounds=await page.evaluate(()=>{const v=document.querySelector('.notebook-viewport').getBoundingClientRect(),toolbar=document.querySelector('.panvas-floating-toolbar').getBoundingClientRect(),above=toolbar.top<innerHeight/2,integrated=Boolean(document.querySelector('[aria-label="Text formatting"]').closest('.panvas-floating-toolbar'));return{left:v.left,right:v.right,top:above?toolbar.bottom:v.top,bottom:above?v.bottom:toolbar.top,viewportTop:v.top,viewportBottom:v.bottom,integrated,width:innerWidth,height:innerHeight};});
    assert.ok(rect.x>=Math.max(0,bounds.left)&&rect.x+rect.width<=Math.min(bounds.right,bounds.width)+1,JSON.stringify({width,rect,bounds}));
    assert.ok(bounds.integrated?(rect.y>=0&&rect.y+rect.height<=bounds.height&&(rect.y+rect.height<=bounds.viewportTop||rect.y>=bounds.viewportBottom)):(rect.y>=bounds.top&&rect.y+rect.height<=bounds.bottom),JSON.stringify({width,rect,bounds}));checks['toolbarBounds-'+width]={rect,bounds};await page.screenshot({path:`${out}/${phase}-${mode}-toolbar-${width}.png`});
  }
  if(native)await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1100));else await page.setViewportSize({width:1440,height:1100});await settle();
  const showLibrary=page.getByRole('button',{name:'Show library',exact:true});if(await showLibrary.count())await showLibrary.click();
  for(const key of ['Control+-','Control+=']){
    await select('One selected line');await page.keyboard.press(key);await settle();
    const rect=await strip.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=1441&&rect.y>=0&&rect.y+rect.height<=1100);checks['toolbarZoom-'+key]=true;
  }
  if(process.argv.includes('--core-only')){console.log(JSON.stringify({mode,checks:Object.keys(checks)}));return;}
  for(const[paper,writing]of [['A4','freeform'],['Infinite','document']]){
    await createDocument(`${paper} ${writing} editing`,paper,writing);
    if(writing==='freeform'){
      await startFreeform();
    }
    await paste(rust);await page.keyboard.press('Control+a');await settle();await clearNotebookHighlight(page);await settle();assert.equal(JSON.stringify(await json()).includes('highlight'),false);
    const original=await json();if(writing==='document')await waitSaved(original);else await page.waitForFunction(async expected=>{const saved=await window.workflowProbe.saved();return saved.objects.some(o=>JSON.stringify(o.content)===JSON.stringify(expected));},original);
    await page.reload();await page.waitForFunction(()=>window.workflowProbe?.ready()&&Boolean(window.workflowProbe.editor()));await settle();assert.deepEqual(await json(),original);checks[`${paper}-${writing}-reopen`]=true;
    await page.getByTitle('Text (T)',{exact:true}).click();await page.waitForFunction(()=>window.workflowProbe.editor().isEditable);
    const pageId=await page.evaluate(()=>window.workflowProbe.location().pageId);
    await page.locator(`#page-${pageId} .ProseMirror[contenteditable="true"]`).locator('p').last().click({position:{x:10,y:10}});await page.waitForFunction(()=>window.workflowProbe.editor().isFocused);await page.keyboard.press('Control+End');await settle();
    await workload(`${writing}-typing`,async()=>{for(const key of 'checkpoint'){await page.keyboard.type(key);await settle(2);}});
    assert.ok(JSON.stringify(await json()).includes('checkpoint'));await page.screenshot({path:`${out}/${phase}-${mode}-${writing}-editing.png`});
    const typed=await json();await page.waitForFunction(async expected=>{const saved=await window.workflowProbe.saved();return saved.objects.some(o=>JSON.stringify(o.content)===JSON.stringify(expected));},typed);
    checks[`${paper}-${writing}-typed-before-reopen`]=await page.evaluate(async()=>({json:window.workflowProbe.editor().getJSON(),texts:window.workflowProbe.snapshot().texts,saved:await window.workflowProbe.saved(),owner:window.workflowProbe.snapshot().editorOwner,writes:window.workflowProbe.writes()}));
    await page.reload();await page.waitForFunction(expected=>window.workflowProbe?.ready()&&JSON.stringify(window.workflowProbe.editor()?.getJSON())===JSON.stringify(expected),typed);await settle();assert.deepEqual(await json(),typed);checks[`${paper}-${writing}-typed-reopen`]=true;
  }
  console.log(JSON.stringify({mode,checks}));
}
