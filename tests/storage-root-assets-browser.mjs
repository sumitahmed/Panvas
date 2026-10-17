import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { _electron } from 'playwright';

// Real sandbox/preload/IPC, isolated filesystem. Never changes the owner's root.
const root = await mkdtemp(path.join(tmpdir(), 'panvas-root-assets-'));
const executable=process.argv.find(arg=>arg.startsWith('--executable='))?.slice(13);
const out = path.resolve(process.argv.find(arg=>arg.startsWith('--out='))?.slice(6) ?? 'artifacts/production-readiness-20261017/storage-root-assets');
await mkdir(out, { recursive: true });
for (const [entry, name] of [['electron/ipc/domain-handlers.ts', 'domain.cjs'], ['electron/preload.ts', 'preload.cjs']]) {
  await build({ entryPoints: [entry], outfile: path.join(root, name), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
}
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Storage root regression</title><h1>Disposable storage audit</h1>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
await writeFile(path.join(root, 'boot.cjs'), `const {app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));process.env.PANVAS_GATE0_PROFILE='1';process.env.PANVAS_GATE0_WORKSPACE_ROOT=path.join(__dirname,'original');process.env.VITE_DEV_SERVER_URL=${JSON.stringify(url)};app.whenReady().then(()=>{require('./domain.cjs').registerDomainHandlers();new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}}).loadURL(${JSON.stringify(url)});});`);
const env = { ...process.env, PANVAS_GATE0_PROFILE:'1',PANVAS_GATE0_WORKSPACE_ROOT:path.join(root,'original'),PANVAS_GATE0_USER_DATA:path.join(root,'profile') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete env[key];
let app, page;
const evidence = { root, checks: [], before: process.argv.includes('--expect-missing'),packaged:Boolean(executable) };
const launch = async () => {
  app = await _electron.launch({ executablePath:executable?path.resolve(executable):undefined,args:executable?[`--user-data-dir=${path.join(root,'profile')}`]:[path.join(root, 'boot.cjs')], env });
  assert.ok((await app.evaluate(({app})=>app.getPath('userData'))).startsWith(root+path.sep));
  page = await app.firstWindow();await page.waitForFunction(() => window.panvas);
  if(executable){assert.equal(await app.evaluate(({app})=>app.isPackaged),true);await page.getByRole('button',{name:'New item',exact:true}).waitFor();}
};
const assets = {
  Pdf: { id: 'pdf-root-a', name: 'source.pdf', bytes: [...await readFile('tests/fixtures/diag.pdf')] },
  Image: { id: 'image-root-a', name: 'source.png', mime: 'image/png', bytes: [...await readFile('tests/fixtures/integrity-test.png')] },
  Audio: { id: 'audio-root-a', name: 'source.wav', mime: 'audio/wav', bytes: [...await readFile('tests/fixtures/browser-note.wav')] },
};
const store = async (kind, value) => page.evaluate(async ({kind,value}) => {
  const data = new Uint8Array(value.bytes).buffer;
  return kind === 'Pdf' ? window.panvas.binary.storePdf(value.id,value.name,data) : window.panvas.binary['store'+kind](value.id,value.name,value.mime,data);
}, {kind,value});
const read = async (kind, id) => page.evaluate(async ({kind,id}) => { const value = await window.panvas.binary['get'+kind](id); return value && {name:value.fileName,bytes:[...new Uint8Array(value.data)]}; }, {kind,id});
try {
  await launch();
  for (const [kind,value] of Object.entries(assets)) { await store(kind,value); assert.deepEqual(await read(kind,value.id),{name:value.name,bytes:value.bytes}); }
  evidence.checks.push('three asset kinds readable before folder change');
  const second = path.join(root,'second'), third = path.join(root,'third');
  await mkdir(second); await mkdir(third);
  await page.evaluate(root => window.panvas.storage.setRoot(root), second);
  if (evidence.before) {
    evidence.missing = {};
    for (const [kind,value] of Object.entries(assets)) { evidence.missing[kind] = await read(kind,value.id); assert.equal(evidence.missing[kind],null); }
    evidence.checks.push('reproduced: root change hides original PDF, image and audio');
  } else {
    for (const [kind,value] of Object.entries(assets)) assert.deepEqual(await read(kind,value.id),{name:value.name,bytes:value.bytes});
    evidence.checks.push('folder change retains exact original bytes');
    const next = {...assets.Image,id:'image-root-b',name:'second.png'}; await store('Image',next);
    const offline=process.argv.includes('--legacy-offline'),unmounted=path.join(root,'unmounted');
    if(offline){
      await app.close();app=null;
      // Emulate an older profile whose configured removable root is offline.
      const file=path.join(root,'profile/panvas/settings.json'),settings=JSON.parse(await readFile(file,'utf8'));
      delete settings.assetStorageRoots;await writeFile(file,JSON.stringify(settings));
      for(const p of [second,unmounted])assert.ok(path.resolve(p).startsWith(root+path.sep));
      await rename(second,unmounted);await launch();
      assert.equal((await page.evaluate(()=>window.panvas.storage.getRoot())).available,false);
    }
    await page.evaluate(root => window.panvas.storage.setRoot(root), third);
    await app.close(); app = null;
    if(offline)await rename(unmounted,second);
    await launch();
    if(process.argv.includes('--expect-legacy-missing')){
      assert.equal(await read('Image',next.id),null);evidence.checks.push('reproduced: changing a legacy offline custom root loses its media lookup path');
    }else{
    for (const [kind,value] of Object.entries(assets)) assert.deepEqual(await read(kind,value.id),{name:value.name,bytes:value.bytes});
    assert.deepEqual(await read('Image',next.id),{name:next.name,bytes:next.bytes});
    evidence.checks.push('two changes and full restart retain both roots');
    for (const [kind,value] of Object.entries(assets)) assert.deepEqual([...await readFile(path.join(root,'original','Assets',kind.toLowerCase()+'-store',value.id+'.bin'))],value.bytes);
    await store('Image',{...next,name:'current.png'});
    assert.equal((await read('Image',next.id)).name,'current.png');
    assert.deepEqual(await read('Image','missing-asset'),null);
    await assert.rejects(page.evaluate(() => window.panvas.binary.getImage('../escape')));
    evidence.checks.push('new-root writes take precedence; old files unchanged; missing and unsafe IDs handled');
    if(offline)evidence.checks.push('legacy unavailable root is retained and media returns after reconnection');
    }
  }
  evidence.passed = true;
} catch (error) { evidence.failure = error.stack; throw error; }
finally { await writeFile(path.join(out,process.argv.includes('--legacy-offline')?(process.argv.includes('--expect-legacy-missing')?'legacy-offline-before.json':'legacy-offline-after.json'):evidence.before?'before.json':'after.json'),JSON.stringify(evidence,null,2)); await app?.close(); await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify(evidence));
