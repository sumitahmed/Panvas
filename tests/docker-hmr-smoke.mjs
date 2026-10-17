import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const out='artifacts/production-readiness-20261017/docker-hmr';await mkdir(out,{recursive:true});
const file='src/styles/index.css',before=await readFile(file),marker='\n/* Disposable Docker HMR audit */\n:root { --panvas-docker-hmr-audit: ready; }\n',changed=Buffer.concat([before,Buffer.from(marker)]);
let browser,page,modified=false;const evidence={checks:[]};
try{
  browser=await chromium.launch();page=await browser.newPage();await page.goto('http://127.0.0.1:3017/app');await page.getByRole('button',{name:'New item',exact:true}).waitFor();
  const initial=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--panvas-docker-hmr-audit').trim());assert.equal(initial,'');
  await writeFile(file,changed);modified=true;
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--panvas-docker-hmr-audit').trim()),{timeout:30000}).toBe('ready');evidence.checks.push('host CSS edit reaches the unprivileged container and updates the real browser');
  await page.screenshot({path:out+'/hot-reload.png'});
}catch(error){evidence.failure=error.stack;throw error;}
finally{
  if(modified){const current=await readFile(file);if(current.equals(changed))await writeFile(file,before);else if(current.subarray(-Buffer.byteLength(marker)).equals(Buffer.from(marker)))await writeFile(file,current.subarray(0,-Buffer.byteLength(marker)));else throw Error('Concurrent source edit detected; refusing to overwrite it.');}
  const after=await readFile(file);evidence.sourceRestoredExactly=after.equals(before);evidence.sourceSha256=createHash('sha256').update(after).digest('hex');assert.equal(evidence.sourceRestoredExactly,true);
  if(page)await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--panvas-docker-hmr-audit').trim()),{timeout:30000}).toBe('');
  await browser?.close();evidence.passed=!evidence.failure;await writeFile(out+'/results.json',JSON.stringify(evidence,null,2));
}
console.log(JSON.stringify(evidence));
