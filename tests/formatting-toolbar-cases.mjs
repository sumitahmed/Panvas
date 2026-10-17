import assert from 'node:assert/strict';

export async function runToolbarUX({page,app,native,phase,mode,out,evidence,workload,createDocument,settle,waitSaved}) {
  const checks=evidence.toolbarUX={};
  const localPrompt=page.getByRole('button',{name:'Continue locally',exact:true});
  await createDocument('Stationary formatting');
  if(await localPrompt.count())await localPrompt.click();
  const id=await page.evaluate(()=>window.workflowProbe.location().pageId);
  const body=page.locator(`#page-${id} [data-document-body]`),strip=page.getByLabel('Text formatting',{exact:true});
  const json=()=>page.evaluate(()=>window.workflowProbe.editor().getJSON());
  const select=async index=>{await body.locator('p').nth(index).scrollIntoViewIfNeeded();await body.locator('p').nth(index).click({position:{x:12,y:10}});await page.keyboard.press('Home');await page.keyboard.press('Shift+End');await settle();};
  const source=Array.from({length:24},(_,i)=>`<p>${i===0?'<span style="background-color:#000000;color:#cccccc">':''}Paragraph ${String(i+1).padStart(2,'0')}. ${'Selection changes should update formatting state while the toolbar remains in its own region. '.repeat(3)}${i===0?'</span>':''}</p>`).join('');
  await page.evaluate(html=>{const e=window.workflowProbe.editor();const d=new DataTransfer();d.setData('text/html',html);d.setData('text/plain','Stationary formatting');e.view.dom.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));},source);await settle();
  for(const[index,name]of [[0,'top'],[11,'middle'],[23,'bottom']]){
    await select(index);checks[name]=await strip.boundingBox();await page.screenshot({path:`${out}/${phase}-${mode}-${name}.png`});
  }
  if(phase==='before'){checks.noneButtonCount=await page.getByRole('button',{name:'No background',exact:true}).count();console.log(JSON.stringify({mode,checks}));return;}
  for(const name of ['middle','bottom'])assert.deepEqual(checks[name],checks.top,`${name} selection moved the strip`);
  const stationary=async()=>assert.deepEqual(await strip.boundingBox(),checks.top);
  const selection=()=>page.evaluate(()=>{const s=window.workflowProbe.editor().state.selection;return{from:s.from,to:s.to};});
  assert.equal(await strip.getByRole('button').count(),8);assert.equal(await page.getByRole('button',{name:'No background',exact:true}).count(),0);checks.singlePrimaryRow=true;
  assert.equal(await strip.evaluate(el=>Boolean(el.parentElement.closest('.panvas-floating-toolbar'))),true);
  checks.reservedSpace=await page.evaluate(()=>{const v=document.querySelector('.notebook-viewport').getBoundingClientRect(),s=document.querySelector('[aria-label="Text formatting"]').getBoundingClientRect();return{viewportTop:v.top,toolbarBottom:s.bottom};});assert.ok(checks.reservedSpace.viewportTop>=checks.reservedSpace.toolbarBottom);
  const selectedBeforeScroll=await selection();await body.locator('p').last().hover();await page.mouse.wheel(0,-240);await settle();await stationary();assert.deepEqual(await selection(),selectedBeforeScroll);checks.selectedScrollStationary=true;
  await select(0);const imported=await json(),range=await selection();
  await strip.getByRole('button',{name:'Highlight color',exact:true}).click();let palette=page.getByRole('menu',{name:'Highlight color palette',exact:true});assert.equal(await palette.getByRole('menuitemradio',{name:'None',exact:true}).getAttribute('aria-checked'),'false');await page.screenshot({path:`${out}/${phase}-${mode}-highlight-palette.png`});
  await palette.getByRole('menuitemradio',{name:'None',exact:true}).click();await settle();await stationary();const cleared=await json();assert.notDeepEqual(cleared,imported);
  assert.equal(await page.evaluate(()=>{const e=window.workflowProbe.editor(),s=e.state.selection;return e.state.doc.rangeHasMark(s.from,s.to,e.schema.marks.highlight);}),false);assert.deepEqual(await selection(),range);
  await page.keyboard.press('Control+z');await settle();assert.deepEqual(await json(),imported);await page.keyboard.press('Control+y');await settle();assert.deepEqual(await json(),cleared);checks.importedNoneUndoRedo=true;
  await strip.getByRole('button',{name:'Highlight color',exact:true}).click();palette=page.getByRole('menu',{name:'Highlight color palette',exact:true});assert.equal(await palette.getByRole('menuitemradio',{name:'None',exact:true}).getAttribute('aria-checked'),'true');await page.screenshot({path:`${out}/${phase}-${mode}-none-selected.png`});
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await settle();assert.equal(await page.evaluate(()=>window.workflowProbe.editor().getAttributes('highlight').color),'#fff4b8');await stationary();checks.paletteKeyboard=true;
  await strip.getByRole('button',{name:'Highlight color',exact:true}).click();await page.getByRole('menuitemradio',{name:'None',exact:true}).click();await settle();
  await strip.getByRole('button',{name:'Text color',exact:true}).click();await page.getByRole('menu',{name:'Text color palette',exact:true}).getByRole('menuitemradio',{name:'Default',exact:true}).click();await settle();assert.deepEqual(await selection(),range);checks.foregroundResetRetainsSelection=true;
  await select(5);
  for(const label of ['Bold (Ctrl+B)','Italic (Ctrl+I)','Underline (Ctrl+U)','Strikethrough']){
    const control=strip.getByRole('button',{name:label,exact:true});await control.click();await settle();assert.equal(await control.getAttribute('aria-pressed'),'true');await stationary();await control.click();await settle();assert.equal(await control.getAttribute('aria-pressed'),'false');
  }checks.inlineToggleStates=true;
  const fontRange=await selection();await strip.getByRole('button',{name:'More text formatting',exact:true}).click();const menu=page.getByRole('dialog',{name:'Text formatting options',exact:true});
  assert.equal(await menu.getByRole('button',{name:'Bold (Ctrl+B)',exact:true}).count(),0);const aaBounds=await menu.boundingBox(),anchorBounds=await strip.getByRole('button',{name:'More text formatting',exact:true}).boundingBox();assert.ok(Math.abs(aaBounds.x+aaBounds.width-anchorBounds.x-anchorBounds.width)<1);await stationary();
  await menu.getByRole('button',{name:'Text font',exact:true}).click();const font=menu.getByRole('option',{name:/JetBrains Mono/});await page.waitForFunction(()=>[...document.querySelectorAll('[role="option"]')].some(el=>el.textContent.includes('JetBrains Mono')&&el.getAttribute('aria-disabled')==='false'));await font.click();await settle();assert.deepEqual(await selection(),fontRange);assert.match(await page.evaluate(()=>window.workflowProbe.editor().getAttributes('textStyle').fontFamily),/JetBrains Mono/);await stationary();
  await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});await page.waitForFunction(()=>window.workflowProbe.editor().isFocused);await stationary();checks.aaFontSelectionAndEscape=true;
  const selectedText=()=>page.evaluate(()=>{const e=window.workflowProbe.editor(),s=e.state.selection;return e.state.doc.textBetween(s.from,s.to);});const blockText=await selectedText();
  await strip.getByRole('button',{name:'More text formatting',exact:true}).click();await menu.getByRole('tab',{name:'Paragraph',exact:true}).click();
  for(const [label,type]of [['Heading 2','heading'],['Bullet List','bulletList']]){
    const control=menu.getByRole('button',{name:label,exact:true});await control.click();await settle();assert.equal(await page.evaluate(type=>window.workflowProbe.editor().isActive(type),type),true);assert.equal(await selectedText(),blockText);await stationary();await control.click();await settle();assert.equal(await selectedText(),blockText);await stationary();
  }await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});checks.blockOptionsRetainSelection=true;
  await strip.getByRole('button',{name:'Text color',exact:true}).click();await page.getByRole('menu',{name:'Text color palette',exact:true}).waitFor();await page.keyboard.press('Escape');await page.getByRole('menu',{name:'Text color palette',exact:true}).waitFor({state:'hidden'});await page.waitForFunction(()=>window.workflowProbe.editor().isFocused);checks.paletteEscape=true;
  // Context menus keep pointer ownership and collide against real panel size.
  await body.locator('p').nth(5).click({button:'right',position:{x:20,y:10}});const context=page.getByLabel('Document block menu',{exact:true});const contextBounds=await context.boundingBox();assert.ok(contextBounds.x>=0&&contextBounds.x+contextBounds.width<=1440&&contextBounds.y>=0&&contextBounds.y+contextBounds.height<=1100);await page.keyboard.press('Escape');await stationary();checks.contextCollision=true;
  const saved=await json();await waitSaved(saved);await page.reload();await page.waitForFunction(expected=>window.workflowProbe?.ready()&&JSON.stringify(window.workflowProbe.editor()?.getJSON())===JSON.stringify(expected),saved);await settle();checks.saveReopenExact=true;
  await page.getByTitle('Text (T)',{exact:true}).click();await page.waitForFunction(()=>window.workflowProbe.editor().isEditable);await select(5);const returned=await strip.boundingBox();
  await page.getByTitle('Hand (Space)',{exact:true}).click();await strip.waitFor({state:'hidden'});await page.getByTitle('Text (T)',{exact:true}).click();await select(5);assert.deepEqual(await strip.boundingBox(),returned);checks.toolSwitch=true;
  const initialZoom=await page.evaluate(()=>window.workflowProbe.engine().viewport.getState().scale);
  await page.keyboard.press('Control+=');await page.waitForFunction(expected=>Math.abs(window.workflowProbe.engine().viewport.getState().scale-expected)<.001,initialZoom*1.1);await settle();await stationaryFor(returned);
  await page.keyboard.press('Control+-');await page.waitForFunction(expected=>Math.abs(window.workflowProbe.engine().viewport.getState().scale-expected)<.001,initialZoom*1.1*.9);await settle();await stationaryFor(returned);checks.zoomStationary=true;
  await page.keyboard.press('ArrowRight');await settle();await workload('steady-formatting-typing',async()=>{for(const key of 'stable'){await page.keyboard.type(key);await settle(2);}});assert.deepEqual(await strip.boundingBox(),returned);
  for(const width of (native?[780,680]:[780,460,320])){
    if(native)await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,1100),width);else await page.setViewportSize({width,height:1100});await settle();await select(0);const first=await strip.boundingBox();await select(18);assert.deepEqual(await strip.boundingBox(),first);assert.ok(first.x>=0&&first.x+first.width<=width+1&&first.y>=0&&first.y+first.height<=1100);
    const v=await page.getByRole('main',{name:'Notebook pages',exact:true}).boundingBox();assert.ok(first.y+first.height<=v.y||first.y>=v.y+v.height);checks['responsive-'+width]=first;
    await body.locator('p').nth(18).click({button:'right',position:{x:40,y:10}});const edgeMenu=page.getByLabel('Document block menu',{exact:true});const edgeBounds=await edgeMenu.boundingBox();assert.ok(edgeBounds.x>=0&&edgeBounds.x+edgeBounds.width<=width+1&&edgeBounds.y>=0&&edgeBounds.y+edgeBounds.height<=1100);await page.keyboard.press('Escape');await stationaryFor(first);
    await strip.getByRole('button',{name:'More text formatting',exact:true}).click();const narrowMenu=page.getByRole('dialog',{name:'Text formatting options',exact:true});const bounds=await narrowMenu.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1&&bounds.y>=0&&bounds.y+bounds.height<=1100);assert.ok(bounds.y+bounds.height<=first.y||bounds.y>=first.y+first.height);await stationaryFor(first);await page.keyboard.press('Escape');
    if(width===(native?680:320)){
      const touch=await page.context().newCDPSession(page);await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});const range=await selection();
      const tap=async control=>{const box=await control.boundingBox();await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle();};
      await tap(strip.getByRole('button',{name:'Highlight color',exact:true}));await tap(page.getByRole('menuitemradio',{name:'Yellow',exact:true}));assert.equal(await page.evaluate(()=>window.workflowProbe.editor().getAttributes('highlight').color),'#fff4b8');assert.deepEqual(await selection(),range);
      await tap(strip.getByRole('button',{name:'Highlight color',exact:true}));await tap(page.getByRole('menuitemradio',{name:'None',exact:true}));assert.deepEqual(await selection(),range);assert.equal(await page.evaluate(()=>window.workflowProbe.editor().isActive('highlight')),false);await stationaryFor(first);await touch.send('Emulation.setTouchEmulationEnabled',{enabled:false});await touch.detach();checks.touchPaletteRetainsSelection=true;
    }
    await page.screenshot({path:`${out}/${phase}-${mode}-${width}.png`});
  }
  async function stationaryFor(expected){assert.deepEqual(await strip.boundingBox(),expected);}
  console.log(JSON.stringify({mode,checks}));
}
