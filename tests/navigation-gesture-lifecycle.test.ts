import assert from 'node:assert/strict';
import test from 'node:test';
import { NavigationGestureLifecycle } from '../src/components/notebook/engine/NavigationGestureLifecycle.ts';
import { InputManager } from '../src/components/notebook/engine/InputManager.ts';
import { ToolManager } from '../src/components/notebook/engine/ToolManager.ts';
import { ViewportManager } from '../src/components/notebook/engine/ViewportManager.ts';
import { attachTwoFingerViewportGesture } from '../src/components/notebook/engine/touchViewportGesture.ts';

class Surface extends EventTarget {
  scrollTop = 0;
  scrollLeft = 0;
  style = { touchAction: '', removeProperty() {} };
  captures = new Set<number>();
  getBoundingClientRect() { return { left: 0, top: 0, width: 390, height: 844 }; }
  closest() { return this; }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) {
    if (this.captures.delete(id)) pointer(this, 'lostpointercapture', id);
  }
}

function pointer(surface: EventTarget, type: string, id: number, y = 400) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerType: 'touch', pointerId: id, clientX: id * 50, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
  surface.dispatchEvent(event);
}

function harness() {
  const canvas = new Surface();
  const tools = new ToolManager();
  tools.setMode('hand');
  const input = new InputManager(tools, new ViewportManager(),
    { redraw() {}, endLiveStroke() {} } as any,
    { setRulerManager() {}, setHistoryChangeCallback() {} } as any,
    {} as any, {} as any, {} as any, {} as any,
    { setEnabled() { return false; } } as any, { clear() {} } as any);
  input.attach(canvas as any);
  return { input, canvas, tools };
}

test('navigation owners overlap on promotion and release idempotently', () => {
  const lifecycle = new NavigationGestureLifecycle();
  let idle = 0;
  const unsubscribe = lifecycle.onIdle(() => idle++);
  const first = lifecycle.begin();
  const second = lifecycle.begin();
  first(); first();
  assert.equal(lifecycle.active, true);
  assert.equal(idle, 0);
  second(); second();
  assert.equal(lifecycle.active, false);
  assert.equal(idle, 1);
  unsubscribe();
  lifecycle.begin()();
  assert.equal(idle, 1);
});

for (const termination of ['pointerup', 'pointercancel', 'lostpointercapture', 'detach', 'tool', 'transient', 'blur', 'visibility'] as const) {
  test(`InputManager Hand navigation terminates exactly once on ${termination}`, () => withDom(() => {
    const { input, canvas, tools } = harness();
    let idle = 0;
    input.navigationGestures.onIdle(() => idle++);
    pointer(canvas, 'pointerdown', 17);
    assert.equal(input.navigationGestures.active, true);
    pointer(canvas, 'pointerup', 99);
    assert.equal(input.navigationGestures.active, true, 'unrelated pointers cannot end the pan');
    pointer(canvas, 'pointermove', 17, 300);
    assert.equal(canvas.scrollTop, 100);
    if (termination === 'detach') input.detach();
    else if (termination === 'tool') tools.setMode('select');
    else if (termination === 'transient') input.cancelActivePointerInteraction();
    else if (termination === 'blur') window.dispatchEvent(new Event('blur'));
    else if (termination === 'visibility') {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    }
    else pointer(canvas, termination, 17);
    assert.equal(input.navigationGestures.active, false);
    assert.equal(idle, 1);
    pointer(canvas, 'pointerup', 17);
    input.detach();
    assert.equal(idle, 1);
  }));
}

function withDom(run: () => void) {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'document', { value: Object.assign(new EventTarget(), { visibilityState: 'visible' }), configurable: true });
  try { run(); } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else delete (globalThis as any).window;
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument); else delete (globalThis as any).document;
  }
}

test('pinch coalesces a pointer pair and applies its final layout before releasing ownership', () => withDom(() => {
  const priorFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const priorCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  let queued: (() => void) | null = null;
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: () => void) => { queued = callback; return 1; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => { queued = null; } });
  const target = new Surface();
  const lifecycle = new NavigationGestureLifecycle();
  const updates: number[] = [];
  const detach = attachTwoFingerViewportGesture({ target: target as any, getScale: () => 1,
    setScale: scale => { assert.ok(lifecycle.active); updates.push(scale); },
    cancelActivePointerInteraction() {}, navigationGestures: lifecycle });
  try {
    pointer(target, 'pointerdown', 1, 400); pointer(target, 'pointerdown', 2, 400);
    pointer(target, 'pointermove', 1, 350); pointer(target, 'pointermove', 2, 450);
    assert.equal(updates.length, 0, 'both fingers wait for the same frame');
    queued!();
    assert.equal(updates.length, 1);
    const firstScroll = target.scrollTop;
    pointer(target, 'pointermove', 1, 300); pointer(target, 'pointermove', 2, 500);
    let idle = 0;
    lifecycle.onIdle(() => { idle++; assert.equal(updates.length, 2); assert.notEqual(target.scrollTop, firstScroll); });
    pointer(target, 'pointerup', 1); pointer(target, 'pointerup', 2);
    assert.equal(idle, 1);
    assert.equal(queued, null, 'release cancels the stale scheduled frame');
  } finally {
    detach();
    for (const [name, descriptor] of [['requestAnimationFrame', priorFrame], ['cancelAnimationFrame', priorCancel]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name];
    }
  }
}));

for (const termination of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'tool', 'teardown'] as const) {
  test(`promoted two-finger navigation terminates exactly once on ${termination}`, () => withDom(() => {
    const { input, canvas } = harness();
    const target = new Surface();
    const navigation = input.navigationGestures;
    let idle = 0;
    navigation.onIdle(() => idle++);
    let cancelFromTool = () => {};
    const detach = attachTwoFingerViewportGesture({
      target: target as any,
      getScale: () => 1,
      setScale() {},
      navigationGestures: navigation,
      cancelActivePointerInteraction: () => {
        input.cancelActivePointerInteraction();
        assert.equal(navigation.active, true, 'promotion must never expose idle between owners');
      },
      subscribeCancellation: cancel => { cancelFromTool = cancel; return () => {}; },
    });
    pointer(target, 'pointerdown', 17);
    pointer(canvas, 'pointerdown', 17);
    pointer(target, 'pointerdown', 18);
    assert.equal(idle, 0);
    if (termination === 'pointerup') {
      pointer(target, 'pointerup', 17);
      assert.equal(navigation.active, true, 'hold ownership until the remaining finger lifts');
      // A second finger can rejoin without acquiring/leaking another owner.
      pointer(target, 'pointerdown', 19);
      pointer(target, 'pointerup', 18);
      assert.equal(navigation.active, true);
      pointer(target, 'pointerup', 19);
    } else if (termination === 'blur') window.dispatchEvent(new Event('blur'));
    else if (termination === 'tool') cancelFromTool();
    else if (termination === 'teardown') detach();
    else pointer(target, termination, 17);
    assert.equal(navigation.active, false);
    assert.equal(idle, 1);
    detach(); input.detach();
    assert.equal(idle, 1);
  }));
}

for (const termination of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  test(`one-finger ${termination} outside the viewport cannot leave a stale promotion candidate`, () => withDom(() => {
    const target = new Surface();
    const navigation = new NavigationGestureLifecycle();
    let promotions = 0;
    const detach = attachTwoFingerViewportGesture({
      target: target as any, getScale: () => 1, setScale() {}, navigationGestures: navigation,
      cancelActivePointerInteraction: () => promotions++,
    });
    pointer(target, 'pointerdown', 17);
    pointer(window, termination, 17);
    pointer(target, 'pointerdown', 18);
    assert.equal(promotions, 0);
    assert.equal(navigation.active, false);
    detach();
  }));
}
