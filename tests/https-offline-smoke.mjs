import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp,readFile,mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chooseWritingLayout,closeNotebookProperties } from './helpers/notebook-properties.mjs';
const root=await mkdtemp(path.join(tmpdir(),'panvas-https-offline-'));
const out='artifacts/production-readiness-20261017/https-offline';await mkdir(out,{recursive:true});
const key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem');
execFileSync('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-keyout',key,'-out',cert,'-days','1','-nodes','-subj','/CN=panvas.localhost','-addext','subjectAltName=DNS:panvas.localhost'],{stdio:'ignore'});
const server=createServer({key:await readFile(key),cert:await readFile(cert)},(incoming,response)=>{
  const proxy=request({hostname:'127.0.0.1',port:8080,path:incoming.url,method:incoming.method,headers:{...incoming.headers,host:'127.0.0.1:8080'}},upstream=>{response.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(response);});
  proxy.on('error',()=>{response.writeHead(502);response.end();});incoming.pipe(proxy);
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`https://panvas.localhost:${server.address().port}`,evidence={url,root,certificate:'disposable self-signed test proxy; no public TLS or system certificate installation',errors:[],checks:[]};let browser,page;
try{
  browser=await chromium.launch({args:['--ignore-certificate-errors','--host-resolver-rules=MAP panvas.localhost 127.0.0.1']});const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:900}});page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>evidence.errors.push(e.message));
  await page.goto(url+'/');await page.locator('h1').waitFor();await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await page.reload();await page.locator('h1').waitFor();
  assert.equal(await page.evaluate(()=>isSecureContext),true);evidence.worker=await page.evaluate(()=>navigator.serviceWorker.controller.scriptURL);evidence.checks.push('actual HTTPS context installs and controls the production service worker');
  await page.goto(url+'/app');await page.getByRole('button',{name:'New item',exact:true}).waitFor();const local=page.getByRole('button',{name:'Continue locally',exact:true});if(await local.isVisible())await local.click({force:true});
  await page.getByRole('button',{name:'New item',exact:true}).click();await page.getByRole('button',{name:'New Notebook',exact:true}).click();await page.locator('#create-dialog-input').fill('HTTPS offline acceptance');await page.getByRole('button',{name:'Create',exact:true}).click();await page.locator('#create-dialog-input').waitFor({state:'hidden'});await page.locator('aside').getByText('HTTPS offline acceptance',{exact:true}).click();await chooseWritingLayout(page,'Document');await closeNotebookProperties(page);
  const marker='HTTPS cached shell restores this exact local document.';await page.getByRole('textbox',{name:'Document body',exact:true}).click();await page.keyboard.type(marker);
  await expect.poll(()=>page.evaluate(()=>new Promise(resolve=>{const req=indexedDB.open('panvas');req.onsuccess=()=>{const db=req.result,r=db.transaction('notebookPageDrawings').objectStore('notebookPageDrawings').getAll();r.onsuccess=()=>{resolve(JSON.stringify(r.result).includes('HTTPS cached shell restores this exact local document.'));db.close();};};}))).toBe(true);
  await page.waitForLoadState('networkidle');evidence.caches=await page.evaluate(()=>caches.keys());
  await context.setOffline(true);await page.reload();await expect(page.getByRole('textbox',{name:'Document body',exact:true})).toContainText(marker);await page.screenshot({path:out+'/offline-reloaded.png'});evidence.checks.push('network-offline full reload starts cached application and restores saved IndexedDB document');
  assert.deepEqual(evidence.errors,[]);evidence.passed=true;
}catch(error){evidence.failure=error.stack;await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});throw error;}
finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(out+'/results.json',JSON.stringify(evidence,null,2));}
console.log(JSON.stringify(evidence));
