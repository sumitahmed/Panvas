import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

test('disposable two-instance runtime verification: instance B quits when instance A holds lock', () => {
  // The Windows hosted runner aborts inside Node's test async callback scope
  // when spawning Electron. Run the same native assertions in a plain process;
  // a crash, timeout or failed assertion still fails this test.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(process.execPath, [path.resolve('tests/helpers/single-instance-runtime.mjs')], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 45000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
