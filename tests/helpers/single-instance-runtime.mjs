import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// Actual native two-instance lifecycle, outside node:test's async context.
const disposableTemp = await mkdtemp(path.join(os.tmpdir(), 'panvas-single-instance-test-'));
const electronExe = process.platform === 'win32'
  ? path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
  : 'npx';

const baseEnv = {
  ...process.env,
  PANVAS_GATE0_PROFILE: '1',
  PANVAS_GATE0_USER_DATA: disposableTemp,
  PANVAS_GATE0_WORKSPACE_ROOT: path.join(disposableTemp, 'workspaces'),
  PANVAS_GATE0_DEBUG_PORT: '9876',
};
delete baseEnv.ELECTRON_RUN_AS_NODE;
delete baseEnv.NODE_TEST_CONTEXT;
delete baseEnv.NODE_TEST_WORKER_ID;

const instanceAArgs = process.platform === 'win32' ? ['.'] : ['electron', '.'];

const procA = spawn(electronExe, instanceAArgs, {
  cwd: process.cwd(),
  env: baseEnv,
  stdio: 'ignore',
});

let procB;
const stop = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Owned Electron process did not exit.')), 15000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill();
  });
};
try {
  // Wait for instance A to initialize and acquire single instance lock
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(procA.exitCode, null, 'Instance A should still be running');

  // Launch instance B pointing to the exact same disposable user data directory
  const envB = {
    ...baseEnv,
    PANVAS_GATE0_DEBUG_PORT: '9877',
  };

  procB = spawn(electronExe, instanceAArgs, {
    cwd: process.cwd(),
    env: envB,
    stdio: 'ignore',
  });

  // Instance B must exit cleanly on its own because single instance lock is held by A
  const bExitPromise = new Promise((resolve) => {
    procB.on('exit', (code, signal) => resolve({ code, signal }));
  });

  let exitTimeout;
  const bTimeout = new Promise((resolve) => { exitTimeout = setTimeout(() => resolve('timeout'), 10000); });
  const result = await Promise.race([bExitPromise, bTimeout]);
  clearTimeout(exitTimeout);

  assert.notEqual(result, 'timeout', 'Instance B should have exited cleanly within timeout');
  if (result !== 'timeout') {
    assert.equal(result.code, 0, 'Instance B should exit with code 0 after app.quit()');
  }

  // Instance A must still be running and uncompromised
  assert.equal(procA.exitCode, null, 'Instance A must remain alive after Instance B exit');
} finally {
  await stop(procB);
  await stop(procA);
  assert.ok(path.isAbsolute(disposableTemp) && disposableTemp.startsWith(path.join(os.tmpdir(), 'panvas-single-instance-test-')));
  try {
    await rm(disposableTemp, { recursive: true, force: true });
  } catch {
    // Ignore cleanup lock if any
  }
}
console.log('PASS: native instance B exits cleanly while instance A retains the lock.');
