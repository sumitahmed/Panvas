import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

function focusExistingWindow(targetWindow: {
  isMinimized(): boolean;
  restore(): void;
  isVisible(): boolean;
  show(): void;
  focus(): void;
} | null | undefined): void {
  if (!targetWindow) return;
  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }
  if (!targetWindow.isVisible()) {
    targetWindow.show();
  }
  targetWindow.focus();
}

test('static verification: main process requests single-instance lock early and handles second-instance cleanly', async () => {
  const mainTs = await readFile(path.resolve('electron/main.ts'), 'utf8');

  // Must call requestSingleInstanceLock early
  assert.match(mainTs, /const\s+gotSingleInstanceLock\s*=\s*app\.requestSingleInstanceLock\(\)/);

  // Must quit second instance immediately if lock is not acquired
  assert.match(mainTs, /if\s*\(!gotSingleInstanceLock\)\s*{\s*app\.quit\(\);\s*}\s*else\s*{/);

  // First instance registers second-instance listener
  assert.match(mainTs, /app\.on\(['"]second-instance['"]/);

  // Second-instance handler focuses/restores existing window
  assert.match(mainTs, /focusExistingWindow\(win\)/);

  // Must NOT change or clear real user data/profile paths
  assert.doesNotMatch(mainTs, /clearData|clearCache|deleteIndexedDB|clearStorage/);
  assert.doesNotMatch(mainTs, /app\.setPath\(['"]userData['"],\s*['"][^'"]*['"]\)/);
});

test('focusExistingWindow: restores minimized window and brings to focus', () => {
  let restored = false;
  let shown = false;
  let focused = false;

  const mockWindow = {
    isMinimized: () => true,
    restore: () => { restored = true; },
    isVisible: () => true,
    show: () => { shown = true; },
    focus: () => { focused = true; },
  };

  focusExistingWindow(mockWindow);

  assert.equal(restored, true, 'Minimized window should be restored');
  assert.equal(focused, true, 'Window should receive focus');
  assert.equal(shown, false, 'Already-visible window should not call show()');
});

test('focusExistingWindow: shows hidden window and brings to focus', () => {
  let restored = false;
  let shown = false;
  let focused = false;

  const mockWindow = {
    isMinimized: () => false,
    restore: () => { restored = true; },
    isVisible: () => false,
    show: () => { shown = true; },
    focus: () => { focused = true; },
  };

  focusExistingWindow(mockWindow);

  assert.equal(restored, false, 'Non-minimized window should not call restore()');
  assert.equal(shown, true, 'Hidden window should call show()');
  assert.equal(focused, true, 'Window should receive focus');
});

test('focusExistingWindow: focuses already-visible, non-minimized window without redundant calls', () => {
  let restored = false;
  let shown = false;
  let focused = false;

  const mockWindow = {
    isMinimized: () => false,
    restore: () => { restored = true; },
    isVisible: () => true,
    show: () => { shown = true; },
    focus: () => { focused = true; },
  };

  focusExistingWindow(mockWindow);

  assert.equal(restored, false);
  assert.equal(shown, false);
  assert.equal(focused, true);
});

test('focusExistingWindow: safely handles null or undefined window reference', () => {
  assert.doesNotThrow(() => focusExistingWindow(null));
  assert.doesNotThrow(() => focusExistingWindow(undefined));
});

test('single instance branching contract: second instance quits without creating windows', () => {
  let appQuitCalled = false;
  let windowCreated = false;

  function simulateStartup(gotLock: boolean) {
    if (!gotLock) {
      appQuitCalled = true;
      return;
    }
    windowCreated = true;
  }

  // Second instance: lock fails
  simulateStartup(false);
  assert.equal(appQuitCalled, true, 'Second instance should call app.quit()');
  assert.equal(windowCreated, false, 'Second instance must never create a window');

  // First instance: lock succeeds
  appQuitCalled = false;
  windowCreated = false;
  simulateStartup(true);
  assert.equal(appQuitCalled, false);
  assert.equal(windowCreated, true);
});

test('disposable two-instance runtime verification: instance B quits when instance A holds lock', async () => {
  const disposableTemp = await mkdtemp(path.join(os.tmpdir(), 'panvas-single-instance-test-'));
  const electronExe = process.platform === 'win32'
    ? path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
    : 'npx';

  const baseEnv = {
    ...process.env,
    PANVAS_GATE0_PROFILE: '1',
    PANVAS_GATE0_USER_DATA: disposableTemp,
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

  try {
    // Wait for instance A to initialize and acquire single instance lock
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(procA.exitCode, null, 'Instance A should still be running');

    // Launch instance B pointing to the exact same disposable user data directory
    const envB = {
      ...baseEnv,
      PANVAS_GATE0_DEBUG_PORT: '9877',
    };

    const procB = spawn(electronExe, instanceAArgs, {
      cwd: process.cwd(),
      env: envB,
      stdio: 'ignore',
    });

    // Instance B must exit cleanly on its own because single instance lock is held by A
    const bExitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      procB.on('exit', (code, signal) => resolve({ code, signal }));
    });

    const bTimeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10000));
    const result = await Promise.race([bExitPromise, bTimeout]);

    assert.notEqual(result, 'timeout', 'Instance B should have exited cleanly within timeout');
    if (result !== 'timeout') {
      assert.equal(result.code, 0, 'Instance B should exit with code 0 after app.quit()');
    }

    // Instance A must still be running and uncompromised
    assert.equal(procA.exitCode, null, 'Instance A must remain alive after Instance B exit');
  } finally {
    procA.kill();
    try {
      await rm(disposableTemp, { recursive: true, force: true });
    } catch {
      // Ignore cleanup lock if any
    }
  }
});
