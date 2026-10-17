import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chooseWritingLayout, closeNotebookProperties } from './helpers/notebook-properties.mjs';
const root=await mkdtemp(path.join(tmpdir(),'panvas-portable-acceptance-'));
const version=JSON.parse(await readFile('package.json','utf8')).version;
const out=path.resolve(process.argv.find(arg=>arg.startsWith('--out='))?.slice(6)??'artifacts/production-readiness-20261017/portable');await mkdir(out,{recursive:true});
const exe=path.resolve(`release/Panvas-${version}-Portable.exe`);
const evidence={root,executable:exe,checks:[],errors:[]};let browser,page,child,ownedPid;
const marker='Portable executable saves and reopens this exact document.';
const launch=async()=>{
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const env={...process.env,PANVAS_GATE0_PROFILE:'1',PANVAS_GATE0_WORKSPACE_ROOT:path.join(root,'workspaces'),VITE_DEV_SERVER_URL:'http://127.0.0.1:1',PANVAS_TEST_WINDOW:'1280x900'};
  for(const key of ['ELECTRON_RUN_AS_NODE','NODE_TEST_CONTEXT','NODE_TEST_WORKER_ID'])delete env[key];
  child=spawn(exe,[`--user-data-dir=${path.join(root,'profile')}`,`--remote-debugging-port=${port}`],{env,stdio:'ignore'});
  await expect.poll(async()=>{try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});return true;}catch{return false;}},{timeout:90000,intervals:[500,1000,2000]}).toBe(true);
  page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>evidence.errors.push(e.message));page.setDefaultTimeout(30000);
  await page.getByRole('button',{name:'New item',exact:true}).waitFor();assert.ok(page.url().startsWith('file:'));
  const rootInfo=await page.evaluate(()=>window.panvas.storage.getRoot());assert.ok(rootInfo.path.startsWith(root+path.sep));
  const cdp=await browser.newBrowserCDPSession();ownedPid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser').id;
  evidence.appInfo=await page.evaluate(()=>window.panvas.appInfo());assert.equal(evidence.appInfo.version,version);
  const local=page.getByRole('button',{name:'Continue locally',exact:true});if(await local.isVisible())await local.click({force:true});
};
const close=async()=>{if(browser){
  await page.evaluate(()=>window.close()).catch(()=>{});
  await expect.poll(()=>browser.isConnected(),{timeout:25000}).toBe(false);browser=null;
  // CDP disconnect precedes native shutdown and portable-wrapper cleanup.
  // Relaunch only after both owned processes have actually exited.
  await expect.poll(()=>{try{process.kill(ownedPid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}},{timeout:30000}).toBe(true);
  await expect.poll(()=>child.exitCode!==null||child.signalCode!==null,{timeout:30000}).toBe(true);
}ownedPid=null;};
try{
  await launch();
  await page.getByRole('button',{name:'New item',exact:true}).click();await page.getByRole('button',{name:'New Notebook',exact:true}).click();await page.locator('#create-dialog-input').fill('Portable acceptance');await page.getByRole('button',{name:'Create',exact:true}).click();await page.locator('#create-dialog-input').waitFor({state:'hidden'});await page.locator('aside').getByText('Portable acceptance',{exact:true}).click();
  await chooseWritingLayout(page,'Document');await closeNotebookProperties(page);const body=page.getByRole('textbox',{name:'Document body',exact:true});await body.click();await page.keyboard.type(marker);
  await expect.poll(()=>page.evaluate(async()=>{for(const ws of await window.panvas.workspace.getAll()){const nb=(await window.panvas.notebook.getAll(ws.id)).find(n=>n.name==='Portable acceptance');if(!nb)continue;const p=(await window.panvas.notebookPage.getAll(ws.id)).find(p=>p.notebookId===nb.id);return (await window.panvas.notebook.loadDrawing(ws.id,nb.id,p.id))?.objects?.find(o=>o.metadata?.documentRole==='body')?.content?.content?.[0]?.content?.[0]?.text;}return null;}),{timeout:30000}).toBe(marker);
  await page.screenshot({path:path.join(out,'saved.png')});evidence.checks.push('actual portable executable starts with isolated data, ignores inherited dev URL and saves typed text');
  await close();await launch();await page.locator('aside').getByText('Portable acceptance',{exact:true}).click();await page.keyboard.press('t');await expect(page.getByRole('textbox',{name:'Document body',exact:true})).toContainText(marker);await page.screenshot({path:path.join(out,'reopened.png')});evidence.checks.push('portable executable exits and fully relaunches with exact saved content');
  assert.deepEqual(evidence.errors,[]);evidence.passed=true;
}catch(error){evidence.failure=error.stack;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
finally{await close().catch(()=>{});if(ownedPid&&process.platform==='win32'){try{execFileSync('taskkill',['/PID',String(ownedPid),'/T','/F'],{stdio:'ignore'});}catch{}}await browser?.close().catch(()=>{});await writeFile(path.join(out,'results.json'),JSON.stringify(evidence,null,2));}
