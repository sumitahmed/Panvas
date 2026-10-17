import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const option=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const out=path.resolve(option('out')??'artifacts/production-readiness-20261017/web-smoke');await mkdir(out,{recursive:true});
const base=option('base')??'http://127.0.0.1:8080';
const version=JSON.parse(await readFile('package.json','utf8')).version;
const {PANVAS_RELEASE}=await import('../src/components/marketing/releaseMetadata.ts');
const profile=JSON.parse(await readFile(option('profile-results')??'artifacts/production-readiness-20261017/docker-code/results.json','utf8')).root;
const evidence={base,profile,checks:[],errors:[],consoleErrors:[],commands:[]};let context,page;
const pass=s=>{evidence.checks.push(s);console.log('PASS',s);};
const launch=async()=>{context=await chromium.launchPersistentContext(path.join(profile,'profile'),{headless:true,viewport:{width:1280,height:900}});page=context.pages()[0];page.on('pageerror',e=>evidence.errors.push(e.message));page.on('console',message=>{if(message.type()==='error')evidence.consoleErrors.push(message.text());});page.setDefaultTimeout(30000);await page.goto(base+'/app');await page.locator('.notebook-viewport').waitFor();await page.keyboard.press('t');await page.locator('[data-document-body] .tiptap[contenteditable="true"]').waitFor();};
const json=()=>page.evaluate(()=>document.querySelector('[data-document-body] .tiptap').editor.getJSON());
const saved=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const req=indexedDB.open('panvas');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const r=db.transaction('notebookPageDrawings').objectStore('notebookPageDrawings').getAll();r.onsuccess=()=>{resolve(r.result.flatMap(record=>record.data?.objects??[]).filter(o=>o.metadata?.documentRole==='body').map(o=>o.content));db.close();};r.onerror=()=>reject(r.error);};}));
try{
  await launch();
  const status=await page.getByText(`v${version}`,{exact:true}).count();assert.equal(status,1);pass('container serves the actual application version');
  await page.waitForLoadState('networkidle');await context.setOffline(true);await page.locator('[data-document-body] .tiptap').focus();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.type(' Offline restart checkpoint.');
  const expected=await json();await expect.poll(saved).toContainEqual(expected);await context.setOffline(false);pass('offline typing saves exact document JSON locally');
  const args=['compose','--env-file','.env.example','-p',option('compose-project')??'panvas-rc-audit','restart','web'];const r=spawnSync('docker',args,{encoding:'utf8'});evidence.commands.push({command:['docker',...args],exitCode:r.status,output:r.stdout+r.stderr});assert.equal(r.status,0);
  await expect.poll(async()=>{try{return(await fetch(base+'/healthz')).status;}catch{return 0;}},{timeout:30000}).toBe(200);
  await page.reload();await page.locator('.notebook-viewport').waitFor();await page.keyboard.press('t');await page.locator('[data-document-body] .tiptap').waitFor();assert.deepEqual(await json(),expected);pass('container restart and page refresh retain exact saved JSON');
  await context.close();context=null;await launch();assert.deepEqual(await json(),expected);pass('full browser-profile reopen retains the document');
  await page.screenshot({path:path.join(out,'reopened-document.png')});
  evidence.routes=[];
  for(const route of ['/','/landing','/download','/privacy','/terms','/security','/roadmap','/app/library']){
    const response=await page.goto(base+route);assert.equal(response.status(),200);await page.locator('main').first().waitFor();
    if(route==='/app/library'){
      await page.getByRole('heading',{name:/^(Recent|Favorites|Library|Trash|Cloud Sync)$/}).waitFor();
      assert.equal(await page.locator('.notebook-viewport').count(),0);
    }else await page.locator('h1').first().waitFor();
    await page.reload();await page.locator('main').first().waitFor();evidence.routes.push({route,status:response.status()});
  }
  pass('landing, public/legal/download and nested application routes survive direct navigation and refresh');
  await page.goto(base+'/');await page.locator('h1').waitFor();
  await page.locator('img').evaluateAll(images=>{for(const img of images)img.loading='eager';});
  await expect.poll(()=>page.locator('img').evaluateAll(images=>images.filter(img=>!img.complete||img.naturalWidth===0).map(img=>img.src)),{timeout:30000}).toEqual([]);
  assert.equal(await page.locator('a a').count(),0);
  assert.match(await page.locator('meta[property="og:image"]').getAttribute('content'),/^https:\/\//);
  const downloadLinks=await page.locator('a[href*="releases/download"]').evaluateAll(items=>items.map(a=>a.href));assert.ok(downloadLinks.length);assert.ok(downloadLinks.every(url=>url===PANVAS_RELEASE.windows.downloadUrl));evidence.downloadLinks=downloadLinks;
  for(const width of [1440,390]){await page.setViewportSize({width,height:900});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:path.join(out,`landing-${width}.png`)});}
  pass('landing images, existing published download CTAs, basic anchors, OG image and responsive widths');
  const home=await fetch(base+'/'),html=await home.text();const asset=/src="(\/assets\/[^" ]+\.js)"/.exec(html)[1];
  assert.equal(home.headers.get('x-frame-options'),'DENY');assert.equal(home.headers.get('x-content-type-options'),'nosniff');assert.ok(home.headers.get('content-security-policy').includes("object-src 'none'"));
  assert.equal(home.headers.get('cache-control'),'no-cache');assert.ok((await fetch(base+asset)).headers.get('cache-control').includes('immutable'));assert.equal((await fetch(base+'/service-worker.js')).headers.get('cache-control'),'no-store');assert.equal((await fetch(base+'/assets/definitely-missing.js')).status,404);assert.notEqual((await fetch(base+'/.env')).status,200);assert.equal((await fetch(base+'/excalidraw-assets/Virgil.woff2')).status,200);
  evidence.headers=Object.fromEntries(home.headers);pass('actual security/cache headers, vendor font and missing/sensitive asset handling');
  assert.deepEqual(evidence.errors,[]);assert.deepEqual(evidence.consoleErrors,[]);evidence.passed=true;
}catch(error){evidence.failure=error.stack;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
finally{await context?.close();await writeFile(path.join(out,'results.json'),JSON.stringify(evidence,null,2));}
