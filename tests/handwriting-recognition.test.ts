import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createEmptyDrawingData, type Stroke } from '../src/components/notebook/engine/drawingTypes.ts';
import type { SelectedElement, TextObject } from '../src/components/notebook/engine/drawingTypes.ts';
import { HistoryManager } from '../src/components/notebook/engine/HistoryManager.ts';
import { LayerManager } from '../src/components/notebook/engine/LayerManager.ts';
import { SelectionEngine } from '../src/components/notebook/engine/SelectionEngine.ts';
import { TextManager } from '../src/components/notebook/engine/TextManager.ts';
import { resolveDrawingStrokeContext, ToolManager } from '../src/components/notebook/engine/ToolManager.ts';
import {
  applyHandwritingInkPreferences,
  createBeautifiedTextPlacement,
  createHandwritingTipTapContent,
  HANDWRITING_FONT_FAMILIES,
  resolveHandwritingLinePlacement,
  sanitizeHandwritingToolPreferences,
  type ExistingHandwritingLinePlacement,
} from '../src/services/beautification/handwritingBeautification.ts';
import {
  aggregateWindowsInkRecognitionGroups,
  marshalWindowsInkRecognitionResults,
  parseWindowsInkWorkerResult,
  recognizeWindowsInkRequest,
  WINDOWS_INK_WORKER,
} from '../electron/ipc/windows-ink-worker.ts';
import { getHandwritingRecognitionProvider } from '../src/services/recognition/index.ts';
import { UnsupportedRecognitionProvider } from '../src/services/recognition/providers/UnsupportedRecognitionProvider.ts';
import { WindowsInkRecognitionProvider } from '../src/services/recognition/providers/WindowsInkRecognitionProvider.ts';
import { WebHandwritingRecognitionProvider } from '../src/services/recognition/providers/WebHandwritingRecognitionProvider.ts';
import { sanitizeRecognitionStrokes } from '../src/services/recognition/types.ts';
import {
  createHandwritingContinuationCommand,
  createHandwritingConversionCommand,
} from '../src/services/recognition/conversion.ts';
import {
  createBulkHandwritingLinePlacements,
  formatHandwritingReviewText,
  getEligibleSelectedHandwritingStrokes,
  recognizeHandwritingLines,
  segmentHandwritingStrokesIntoLines,
  type ReviewedHandwritingLine,
} from '../src/services/recognition/bulkConversion.ts';
import {
  anchorNewHandwritingLinePlacement,
  createExtendedHandwritingLine,
  findSameGeneratedHandwritingLine,
  getHandwritingText,
  hasMatchingHandwritingTypography,
} from '../src/services/recognition/handwritingLineContinuation.ts';
import {
  classifyHandwritingStroke,
  HANDWRITING_IDLE_DELAY_MS,
  RealTimeHandwritingSession,
  shouldGroupHandwritingStrokes,
  type HandwritingSessionScheduler,
} from '../src/services/recognition/RealTimeHandwritingSession.ts';
import type { HandwritingRecognitionProvider, RecognitionOptions, RecognitionResult } from '../src/services/recognition/types.ts';
import { extractPageSearchContent } from '../src/services/search/pageSearchContent.ts';

function stroke(id = 'stroke-1'): Stroke {
  return {
    id,
    type: 'stroke',
    tool: 'pen',
    color: '#112233',
    thickness: 2.5,
    opacity: 0.8,
    createdAt: 123,
    layerId: 'layer-default',
    metadata: { source: 'test' },
    points: [
      { x: 10, y: 20, pressure: 0.2, t: 4 },
      { x: 80, y: 30, pressure: 0.7, t: 18 },
    ],
  };
}

test('recognition payload is ordered, bounded, and does not mutate source strokes', () => {
  const original = [stroke('first'), stroke('second')];
  original[1].points[0].x = 9_000_000;
  original[1].points[0].pressure = 4;
  const snapshot = structuredClone(original);

  const payload = sanitizeRecognitionStrokes(original);

  assert.deepEqual(payload.map(item => item.id), ['first', 'second']);
  assert.equal(payload[1].points[0].x, 1_000_000);
  assert.equal(payload[1].points[0].pressure, 1);
  assert.deepEqual(original, snapshot);
});

test('Windows Ink worker closes AsTask with RecognizeAsync TResult and enumerates projected IReadOnlyList results', () => {
  assert.match(WINDOWS_INK_WORKER, /ReturnType\.GetGenericArguments\(\)\[0\]/);
  assert.match(WINDOWS_INK_WORKER, /System\.WindowsRuntimeSystemExtensions/);
  assert.match(WINDOWS_INK_WORKER, /MakeGenericMethod/);
  assert.match(WINDOWS_INK_WORKER, /\$task\.Wait\(4500\)/);
  assert.match(WINDOWS_INK_WORKER, /foreach \(\$result in \$results\)/);
  assert.match(WINDOWS_INK_WORKER, /foreach \(\$candidate in \$candidateView\)/);
  assert.match(WINDOWS_INK_WORKER, /\$stage = 'enumerating recognition results'/);
  assert.match(WINDOWS_INK_WORKER, /\$stage = 'enumerating text candidates'/);
  assert.match(WINDOWS_INK_WORKER, /status = 'error'/);
  assert.match(WINDOWS_INK_WORKER, /status = 'unavailable'/);
  assert.doesNotMatch(WINDOWS_INK_WORKER, /\$results\.(?:Size|Count)/);
  assert.doesNotMatch(WINDOWS_INK_WORKER, /\$results\[/);
  assert.doesNotMatch(WINDOWS_INK_WORKER, /\$candidateView\.(?:Size|Count)/);
  assert.doesNotMatch(WINDOWS_INK_WORKER, /\$candidateView\[/);
  assert.doesNotMatch(WINDOWS_INK_WORKER, /GetAt/);
  assert.doesNotMatch(WINDOWS_INK_WORKER, /GetMany/);
  assert.doesNotMatch(WINDOWS_INK_WORKER, /\$operation\.Status/);
  assert.doesNotMatch(WINDOWS_INK_WORKER, /\$operation\.GetResults/);
});

class MockProjectedReadOnlyList<T> implements Iterable<T> {
  readonly yielded: T[] = [];
  private readonly values: readonly T[];

  constructor(values: readonly T[]) {
    this.values = values;
  }

  get Count(): number {
    return this.values.length;
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (const value of this.values) {
      this.yielded.push(value);
      yield value;
    }
  }
}

function mockWindowsInkResults(groups: readonly (readonly string[])[]): {
  results: MockProjectedReadOnlyList<{ GetTextCandidates(): MockProjectedReadOnlyList<string> }>;
  candidateViews: MockProjectedReadOnlyList<string>[];
} {
  const candidateViews = groups.map(group => new MockProjectedReadOnlyList(group));
  return {
    results: new MockProjectedReadOnlyList(candidateViews.map(candidateView => ({
      GetTextCandidates: () => candidateView,
    }))),
    candidateViews,
  };
}

test('WinRT marshalling reads one projected IReadOnlyList result', () => {
  const mock = mockWindowsInkResults([['Hello']]);
  assert.deepEqual(marshalWindowsInkRecognitionResults(mock.results), {
    text: 'Hello', candidates: ['Hello'],
  });
  assert.equal(mock.results.Count, 1);
  assert.equal(mock.results.yielded.length, 1);
  assert.deepEqual(mock.candidateViews[0].yielded, ['Hello']);
});

test('WinRT marshalling reads three ordered word results as one phrase', () => {
  const mock = mockWindowsInkResults([['I'], ['love'], ['you']]);
  assert.equal(marshalWindowsInkRecognitionResults(mock.results).text, 'I love you');
  assert.equal(mock.results.yielded.length, 3);
});

test('WinRT marshalling preserves four-result reading order', () => {
  const mock = mockWindowsInkResults([['This'], ['is'], ['a'], ['test']]);
  assert.equal(marshalWindowsInkRecognitionResults(mock.results).text, 'This is a test');
});

test('WinRT marshalling preserves punctuation without inserting a bad space', () => {
  const mock = mockWindowsInkResults([['Hello'], ['world!']]);
  assert.equal(marshalWindowsInkRecognitionResults(mock.results).text, 'Hello world!');
});

test('WinRT marshalling uses only the top candidate from each result', () => {
  const mock = mockWindowsInkResults([['I'], ['love', 'live', 'lore'], ['you']]);
  assert.deepEqual(marshalWindowsInkRecognitionResults(mock.results), {
    text: 'I love you', candidates: ['I love you'],
  });
  assert.deepEqual(mock.candidateViews[1].yielded, ['love']);
});

test('WinRT marshalling skips an empty result among valid results', () => {
  const mock = mockWindowsInkResults([['I'], [], ['you']]);
  assert.equal(marshalWindowsInkRecognitionResults(mock.results).text, 'I you');
  assert.deepEqual(mock.candidateViews[1].yielded, []);
});

test('WinRT marshalling uses iteration rather than Object[] indices', () => {
  const mock = mockWindowsInkResults([['One'], ['two']]);
  marshalWindowsInkRecognitionResults(mock.results);
  assert.equal(mock.results.yielded.length, 2);
  assert.deepEqual(mock.candidateViews.map(view => view.yielded), [['One'], ['two']]);
});

test('Windows Ink result aggregation returns one native result unchanged', () => {
  assert.deepEqual(aggregateWindowsInkRecognitionGroups([['Hello', 'Hallo']]), {
    text: 'Hello',
    candidates: ['Hello', 'Hallo'],
  });
});

test('Windows Ink result aggregation preserves ordered multi-word result groups', () => {
  assert.deepEqual(aggregateWindowsInkRecognitionGroups([
    ['I'],
    ['love'],
    ['you'],
  ]), {
    text: 'I love you',
    candidates: ['I love you'],
  });
});

test('Windows Ink result aggregation applies sensible punctuation spacing', () => {
  assert.equal(aggregateWindowsInkRecognitionGroups([['Hello'], ['world'], ['!']]).text, 'Hello world!');
  assert.equal(aggregateWindowsInkRecognitionGroups([['what'], ['?']]).text, 'what?');
  assert.equal(aggregateWindowsInkRecognitionGroups([['hello'], [','], ['friend']]).text, 'hello, friend');
});

test('Windows Ink result aggregation skips empty groups and keeps alternatives as complete phrases', () => {
  assert.deepEqual(aggregateWindowsInkRecognitionGroups([
    [],
    ['I', 'Eye'],
    ['love', 'live'],
    ['you'],
  ]), {
    text: 'I love you',
    candidates: ['I love you', 'Eye live you'],
  });
});

test('Windows worker adapter aggregates resultGroups instead of flattening word alternatives', () => {
  const result = parseWindowsInkWorkerResult(JSON.stringify({
    status: 'success',
    text: '',
    candidates: [],
    resultGroups: [
      { candidates: ['Hello'] },
      { candidates: ['world'] },
      { candidates: ['!'] },
    ],
    isAvailable: true,
  }));
  assert.equal(result.text, 'Hello world!');
  assert.deepEqual(result.candidates, ['Hello world!']);
});

test('successful Windows worker result adapter returns recognition text, candidates, and language to IPC', async () => {
  const workerOutput = parseWindowsInkWorkerResult(JSON.stringify({
    status: 'success',
    text: 'Hello Windows',
    candidates: ['Hello Windows', 'Hallo Windows'],
    isAvailable: true,
  }));
  const result = await recognizeWindowsInkRequest(
    [stroke('windows-source')],
    { language: 'en-US' },
    async (payload, options) => {
      assert.deepEqual(payload.map(item => item.id), ['windows-source']);
      assert.deepEqual(options, { language: 'en-US' });
      return workerOutput;
    },
    'win32',
  );

  assert.deepEqual(result, {
    status: 'success',
    text: 'Hello Windows',
    candidates: ['Hello Windows', 'Hallo Windows'],
    isAvailable: true,
    error: undefined,
    language: 'en-US',
  });
});

test('Windows worker response contract keeps unavailable, bridge error, and empty distinct', () => {
  assert.deepEqual(parseWindowsInkWorkerResult(JSON.stringify({
    status: 'empty', text: '', candidates: [], isAvailable: true,
  })), {
    status: 'empty', text: '', candidates: [], isAvailable: true, error: undefined,
  });
  assert.deepEqual(parseWindowsInkWorkerResult(JSON.stringify({
    status: 'unavailable', text: '', candidates: [], isAvailable: false, error: 'No recognizer installed.',
  })), {
    status: 'unavailable', text: '', candidates: [], isAvailable: false, error: 'No recognizer installed.',
  });
  const bridgeError = parseWindowsInkWorkerResult(JSON.stringify({
    status: 'error', text: '', candidates: [], isAvailable: true, error: 'AsTask projection failed.',
  }));
  assert.equal(bridgeError.status, 'error');
  assert.equal(bridgeError.isAvailable, true);
});

test('Windows production provider and worker complete the real WinRT async path', {
  skip: process.platform !== 'win32' || process.env.PANVAS_RUN_WINDOWS_INK_INTEGRATION !== '1',
}, async () => {
  const handwriting = [
    {
      ...stroke('native-h-left'),
      points: [
        { x: 20, y: 15, pressure: 0.5, t: 0 },
        { x: 20, y: 70, pressure: 0.5, t: 120 },
      ],
    },
    {
      ...stroke('native-h-arch'),
      createdAt: 260,
      points: [
        { x: 20, y: 42, pressure: 0.5, t: 0 },
        { x: 35, y: 30, pressure: 0.5, t: 35 },
        { x: 48, y: 42, pressure: 0.5, t: 70 },
        { x: 48, y: 70, pressure: 0.5, t: 115 },
      ],
    },
    {
      ...stroke('native-i'),
      createdAt: 390,
      points: [
        { x: 64, y: 39, pressure: 0.5, t: 0 },
        { x: 64, y: 70, pressure: 0.5, t: 80 },
      ],
    },
    {
      ...stroke('native-i-dot'),
      createdAt: 480,
      points: [
        { x: 63, y: 25, pressure: 0.5, t: 0 },
        { x: 65, y: 25, pressure: 0.5, t: 20 },
      ],
    },
  ] satisfies Stroke[];
  const provider = new WindowsInkRecognitionProvider({
    recognize: (strokes, options) => recognizeWindowsInkRequest(strokes, options),
  });

  const result = await provider.recognize(handwriting, { language: 'en-US' });

  assert.ok(['success', 'empty', 'unavailable', 'error'].includes(result.status));
  if (result.status === 'error') assert.fail(result.error || 'The native bridge returned an internal error.');
  if (result.status === 'unavailable') {
    assert.match(result.error ?? '', /unavailable|install/i);
    assert.doesNotMatch(result.error ?? '', /AsTask|async contract|result collection|bridge failed/i);
  } else {
    assert.equal(result.isAvailable, true);
  }
  if (result.status === 'success') assert.ok(result.text.trim().length > 0);

  // A second separated word-shaped group makes the opt-in native test exercise
  // the multi-result marshalling path whenever Windows segments it that way.
  const phraseHandwriting = [
    ...handwriting,
    ...handwriting.map((source, index) => ({
      ...structuredClone(source),
      id: `native-second-word-${index}`,
      createdAt: source.createdAt + 700,
      points: source.points.map(point => ({ ...point, x: point.x + 110 })),
    })),
  ];
  const phraseResult = await provider.recognize(phraseHandwriting, { language: 'en-US' });
  if (phraseResult.status === 'error') {
    assert.fail(phraseResult.error || 'The native multi-word bridge returned an internal error.');
  }
  assert.doesNotMatch(phraseResult.error ?? '', /System\.Object\[\].*System\.Int32|marshalling recognition results/i);
});

test('provider factory selects Windows Ink only for a Windows Electron bridge', () => {
  assert.ok(getHandwritingRecognitionProvider({ platform: 'Win32', hasElectronBridge: true }) instanceof WindowsInkRecognitionProvider);
  assert.ok(getHandwritingRecognitionProvider({ platform: 'MacIntel', hasElectronBridge: true, hasWebHandwritingApi: true }) instanceof WebHandwritingRecognitionProvider);
  assert.ok(getHandwritingRecognitionProvider({ platform: 'Win32', hasElectronBridge: false, hasWebHandwritingApi: false }) instanceof UnsupportedRecognitionProvider);
});

test('unsupported provider is explicit and non-destructive', async () => {
  const provider = new UnsupportedRecognitionProvider();
  const strokes = [stroke()];
  const before = structuredClone(strokes);

  const result = await provider.recognize(strokes);

  assert.equal(await provider.isAvailable(), false);
  assert.equal(result.isAvailable, false);
  assert.match(result.error ?? '', /not supported/i);
  assert.deepEqual(strokes, before);
});

test('activation feedback is environment-correct: neutral for unsupported platforms, Windows guidance only for Windows Ink', async () => {
  const collectActivationFeedback = async (provider: HandwritingRecognitionProvider) => {
    const scheduler = new FakeScheduler();
    const feedback: Array<{ kind: string; message: string }> = [];
    const session = new RealTimeHandwritingSession(provider, () => true, () => true, scheduler);
    session.subscribeFeedback(event => feedback.push(event));
    session.setActive(true);
    await settleAsyncRecognition();
    return feedback;
  };

  const unsupportedFeedback = await collectActivationFeedback(new UnsupportedRecognitionProvider());
  assert.equal(unsupportedFeedback[0]?.kind, 'unavailable');
  assert.doesNotMatch(unsupportedFeedback[0]?.message ?? '', /windows/i);
  assert.match(unsupportedFeedback[0]?.message ?? '', /not supported on this platform/i);
  assert.match(unsupportedFeedback[0]?.message ?? '', /ink will be kept/i);

  const windowsProvider: HandwritingRecognitionProvider = {
    id: 'windows-ink',
    name: 'Windows Ink',
    isOffline: true,
    isAvailable: async () => false,
    recognize: async () => ({ status: 'unavailable', text: '', isAvailable: false }),
  };
  const windowsFeedback = await collectActivationFeedback(windowsProvider);
  assert.equal(windowsFeedback[0]?.kind, 'unavailable');
  assert.match(windowsFeedback[0]?.message ?? '', /Windows handwriting recognition is unavailable/);
  assert.match(windowsFeedback[0]?.message ?? '', /Windows handwriting language component/);
});

function withStubbedNavigator<T>(navigatorStub: unknown, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: navigatorStub, configurable: true });
  return run().finally(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
}

test('web provider capability reflects the browser query API with safe fallbacks', async () => {
  // The recognizer must never be constructed just to answer a capability check.
  const api = {
    HandwritingStroke: class {},
    createHandwritingRecognizer: async () => {
      throw new Error('createHandwritingRecognizer must not run during isAvailable');
    },
  };

  // No query API: the existing API-surface creation path stands.
  assert.equal(
    await withStubbedNavigator({ language: 'en-US' }, () => new WebHandwritingRecognitionProvider(api).isAvailable()),
    true,
  );

  // Query reports a recognizer/model for the language.
  assert.equal(
    await withStubbedNavigator(
      { language: 'en-US', queryHandwritingRecognizer: async () => ({}) },
      () => new WebHandwritingRecognitionProvider(api).isAvailable(),
    ),
    true,
  );

  // Query reports no model for the language: genuinely unsupported.
  assert.equal(
    await withStubbedNavigator(
      { language: 'en-US', queryHandwritingRecognizer: async () => null },
      () => new WebHandwritingRecognitionProvider(api).isAvailable(),
    ),
    false,
  );

  // A throwing query must never crash the capability check.
  assert.equal(
    await withStubbedNavigator(
      { language: 'en-US', queryHandwritingRecognizer: async () => { throw new Error('query failed'); } },
      () => new WebHandwritingRecognitionProvider(api).isAvailable(),
    ),
    true,
  );

  // Without the recognition API surface, capability stays false regardless of query.
  assert.equal(
    await withStubbedNavigator(
      { language: 'en-US', queryHandwritingRecognizer: async () => ({}) },
      () => new WebHandwritingRecognitionProvider(null).isAvailable(),
    ),
    false,
  );
});

test('beautification creates TipTap textStyle content for every supported handwriting font', () => {
  for (const fontFamily of HANDWRITING_FONT_FAMILIES) {
    const content = createHandwritingTipTapContent('Hello\nPanvas', { fontFamily, fontSize: 28, color: '#abcdef' });
    assert.equal(content.type, 'doc');
    assert.equal(content.content.length, 2);
    assert.deepEqual(content.content[0].content[0].marks[0].attrs, {
      fontFamily,
      fontSize: '28px',
      color: '#abcdef',
    });
  }
});

test('confirmed conversion is one atomic history command with exact undo and redo', () => {
  const original = stroke();
  let strokes = [structuredClone(original)];
  let texts: TextObject[] = [];
  let selection: SelectedElement[] = [{ type: 'stroke', id: original.id }];
  const replacement: TextObject = {
    id: 'text-1', type: 'text', x: 10, y: 20, width: 220, height: 72, createdAt: 456,
    content: createHandwritingTipTapContent('Recognized note', { fontFamily: "'Kalam', cursive", fontSize: 26, color: '#334455' }),
  };
  const history = new HistoryManager();
  history.push(createHandwritingConversionCommand({
    getStrokes: () => strokes,
    setStrokes: next => { strokes = next; },
    addText: next => { texts.push(next); },
    removeText: id => { texts = texts.filter(text => text.id !== id); },
    setSelection: next => { selection = next; },
    redraw: () => {},
  }, [original], replacement));

  assert.equal(strokes.length, 0);
  assert.equal(texts.length, 1);
  assert.equal(selection[0].type, 'text');
  history.undo();
  assert.deepEqual(strokes, [original]);
  assert.equal(texts.length, 0);
  history.redo();
  assert.equal(strokes.length, 0);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].content.content[0].content[0].text, 'Recognized note');
});

test('I love you becomes one editable TextObject and restores every exact source stroke on undo', () => {
  const phrase = [
    geometricStroke('i-source', 10, 20),
    geometricStroke('love-source', 70, 20),
    geometricStroke('you-source', 170, 20),
  ];
  let strokes = structuredClone(phrase);
  let texts: TextObject[] = [];
  const replacement: TextObject = {
    id: 'phrase-text', type: 'text', x: 10, y: 20, width: 280, height: 72, createdAt: 789,
    content: createHandwritingTipTapContent('I love you'),
  };
  const history = new HistoryManager();
  history.push(createHandwritingConversionCommand({
    getStrokes: () => strokes,
    setStrokes: next => { strokes = next; },
    addText: next => { texts.push(next); },
    removeText: id => { texts = texts.filter(text => text.id !== id); },
    setSelection: () => {},
    redraw: () => {},
  }, phrase, replacement, { updateSelection: false }));

  assert.deepEqual(strokes, []);
  assert.equal(texts.length, 1);
  assert.equal(texts[0].content.content[0].content[0].text, 'I love you');
  history.undo();
  assert.deepEqual(strokes, phrase);
  history.redo();
  assert.deepEqual(strokes, []);
  assert.equal(texts.length, 1);
});

test('sequential phrase conversions undo and redo one complete line at a time without clobbering later ink', () => {
  const lines = [
    [geometricStroke('line-1-a', 10, 20), geometricStroke('line-1-b', 80, 20)],
    [geometricStroke('line-2-a', 10, 90), geometricStroke('line-2-b', 80, 90)],
    [geometricStroke('line-3-a', 10, 160), geometricStroke('line-3-b', 80, 160)],
  ];
  let strokes = structuredClone(lines.flat());
  let texts: TextObject[] = [];
  const history = new HistoryManager();
  for (const source of lines.flat()) {
    history.pushExecuted({
      description: 'Draw handwriting stroke',
      createdObjectIds: [source.id],
      execute: () => { if (!strokes.some(item => item.id === source.id)) strokes.push(structuredClone(source)); },
      undo: () => { strokes = strokes.filter(item => item.id !== source.id); },
    });
  }

  lines.forEach((line, lineIndex) => {
    const replacement: TextObject = {
      id: `text-line-${lineIndex + 1}`,
      type: 'text',
      x: 10,
      y: 20 + lineIndex * 70,
      width: 240,
      height: 72,
      createdAt: 1_000 + lineIndex,
      content: createHandwritingTipTapContent(`Line ${lineIndex + 1}`),
    };
    history.pushReplacingCreations(createHandwritingConversionCommand({
      getStrokes: () => strokes,
      setStrokes: next => { strokes = next; },
      addText: next => { texts.push(next); },
      removeText: id => { texts = texts.filter(text => text.id !== id); },
      setSelection: () => {},
      redraw: () => {},
    }, line, replacement, { updateSelection: false }), line.map(source => source.id));
  });

  assert.deepEqual(strokes, []);
  assert.deepEqual(texts.map(text => text.id), ['text-line-1', 'text-line-2', 'text-line-3']);
  history.undo();
  assert.deepEqual(strokes.map(source => source.id), ['line-3-a', 'line-3-b']);
  assert.deepEqual(texts.map(text => text.id), ['text-line-1', 'text-line-2']);
  history.undo();
  assert.deepEqual(strokes.map(source => source.id), ['line-2-a', 'line-2-b', 'line-3-a', 'line-3-b']);
  assert.deepEqual(texts.map(text => text.id), ['text-line-1']);

  history.redo();
  history.redo();
  assert.deepEqual(strokes, []);
  assert.deepEqual(texts.map(text => text.id), ['text-line-1', 'text-line-2', 'text-line-3']);
});

class FakeScheduler implements HandwritingSessionScheduler {
  private nextId = 0;
  private tasks = new Map<number, { callback: () => void; delayMs: number }>();
  readonly scheduledDelays: number[] = [];

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.nextId;
    this.tasks.set(id, { callback, delayMs });
    this.scheduledDelays.push(delayMs);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  runAll(): void {
    const tasks = [...this.tasks.entries()].sort(([left], [right]) => left - right);
    this.tasks.clear();
    for (const [, task] of tasks) task.callback();
  }

  get size(): number {
    return this.tasks.size;
  }
}

class FakeProvider implements HandwritingRecognitionProvider {
  readonly id = 'fake-digital-ink';
  readonly name = 'Fake';
  readonly isOffline = true as const;
  calls: Stroke[][] = [];
  options: RecognitionOptions[] = [];
  private readonly result: RecognitionResult;

  constructor(result: RecognitionResult = { status: 'success', text: 'Hello', isAvailable: true }) { this.result = result; }
  async isAvailable(): Promise<boolean> { return this.result.isAvailable; }
  async recognize(strokes: Stroke[], options: RecognitionOptions = {}): Promise<RecognitionResult> {
    this.calls.push(structuredClone(strokes));
    this.options.push(options);
    return this.result;
  }
}

function shiftedStroke(id: string, x: number, y: number): Stroke {
  const value = stroke(id);
  value.createdAt += x + y;
  value.points = value.points.map(point => ({ ...point, x: point.x + x, y: point.y + y }));
  return value;
}

function geometricStroke(id: string, x: number, y: number, width = 28, height = 42): Stroke {
  const value = stroke(id);
  value.createdAt += x + y;
  value.points = [
    { x, y, pressure: 0.45, t: 0 },
    { x: x + width, y: y + height, pressure: 0.65, t: 80 },
  ];
  return value;
}

function scaleStroke(source: Stroke, scale: number): Stroke {
  return {
    ...structuredClone(source),
    points: source.points.map(point => ({ ...point, x: point.x * scale, y: point.y * scale })),
  };
}

async function settleAsyncRecognition(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

test('Handwriting to Text is an independent toggle that never replaces Pen or Pencil', () => {
  const tools = new ToolManager();
  tools.setDrawingTool('pen');
  tools.setHandwritingToTextEnabled(true);
  assert.equal(tools.getState().mode, 'draw');
  assert.equal(tools.getState().drawingTool, 'pen');
  assert.equal(tools.getState().handwritingToTextEnabled, true);

  tools.setDrawingTool('pencil');
  assert.equal(tools.getState().mode, 'draw');
  assert.equal(tools.getState().drawingTool, 'pencil');
  assert.equal(tools.getState().handwritingToTextEnabled, true);

  tools.toggleHandwritingToText();
  assert.equal(tools.getState().mode, 'draw');
  assert.equal(tools.getState().drawingTool, 'pencil');
  assert.equal(tools.getState().handwritingToTextEnabled, false);
});

test('canonical input eligibility admits only Pen/Pencil strokes completed while the mode is enabled', async () => {
  const tools = new ToolManager();
  const scheduler = new FakeScheduler();
  const provider = new FakeProvider();
  const session = new RealTimeHandwritingSession(provider, () => true, () => true, scheduler);
  tools.subscribe(state => session.setActive(state.handwritingToTextEnabled));

  const submit = (source: Stroke) => {
    const context = resolveDrawingStrokeContext(tools.getState());
    if (!context.recognitionEligible) return;
    source.tool = context.tool;
    source.color = context.color;
    source.thickness = context.thickness;
    session.beginStroke();
    session.completeStroke(source);
  };

  tools.setDrawingTool('pen');
  submit(stroke('off-pen'));
  tools.setHandwritingInkStyle('#4a5b6c', 3.6);
  tools.setHandwritingToTextEnabled(true);
  submit(stroke('on-pen'));
  tools.setDrawingTool('pencil');
  submit(shiftedStroke('on-pencil', 70, 0));
  assert.equal(tools.getState().handwritingToTextEnabled, true);

  tools.setDrawingTool('highlighter');
  submit(shiftedStroke('highlighter', 140, 0));
  tools.setMode('erase');
  submit(shiftedStroke('eraser', 210, 0));
  tools.setMode('text');
  submit(shiftedStroke('text', 280, 0));
  tools.setMode('select');
  submit(shiftedStroke('select', 350, 0));

  scheduler.runAll();
  await settleAsyncRecognition();
  assert.deepEqual(provider.calls.flat().map(item => item.id), ['on-pen', 'on-pencil']);
  assert.deepEqual(provider.calls.flat().map(item => item.tool), ['pen', 'pencil']);
  assert.ok(provider.calls.flat().every(item => item.color === '#4a5b6c' && item.thickness === 3.6));
});

test('recognition receives captured physical points while conversion and stale checks retain exact visual ink', async () => {
  const scheduler = new FakeScheduler();
  const provider = new FakeProvider();
  const visual = stroke('stabilized');
  const physical = visual.points.map(point => ({ ...point, x: point.x + .8, y: point.y - .6 }));
  const expectedPhysical = structuredClone(physical);
  const expectedVisual = structuredClone(visual);
  const checks: Stroke[][] = [], commits: Stroke[][] = [];
  const session = new RealTimeHandwritingSession(provider, conversion => {
    commits.push(conversion.strokes);
    return true;
  }, strokes => { checks.push(structuredClone(strokes)); return true; }, scheduler);
  session.setActive(true);
  session.beginStroke();
  session.completeStroke(visual, physical);
  visual.points[0].x = 999;
  physical[0].x = 999;
  scheduler.runAll();
  await settleAsyncRecognition();
  assert.deepEqual(provider.calls[0][0].points, expectedPhysical, 'provider input is neither stabilized nor caller-mutable');
  assert.deepEqual(checks, [[expectedVisual]], 'ownership compares saved visual geometry');
  assert.deepEqual(commits, [[expectedVisual]], 'undo restores exactly what was displayed');

  session.completeStroke(stroke('discarded'), expectedPhysical);
  session.setPageId('next-page');
  session.completeStroke(stroke('next-page'));
  scheduler.runAll();
  await settleAsyncRecognition();
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(provider.calls[1][0], stroke('next-page'), 'page invalidation discards transient capture');
  session.destroy();
});

test('tool off never queues or recognizes strokes; active mode owns only newly completed strokes', async () => {
  const scheduler = new FakeScheduler();
  const provider = new FakeProvider();
  const commits: string[][] = [];
  const session = new RealTimeHandwritingSession(provider, conversion => {
    commits.push(conversion.strokes.map(item => item.id));
    return true;
  }, () => true, scheduler);

  session.completeStroke(stroke('ordinary-before'));
  scheduler.runAll();
  assert.equal(provider.calls.length, 0);

  session.setActive(true);
  session.beginStroke();
  session.completeStroke(stroke('active-only'));
  assert.equal(scheduler.size, 1);
  scheduler.runAll();
  await settleAsyncRecognition();
  assert.deepEqual(provider.calls[0].map(item => item.id), ['active-only']);
  assert.deepEqual(commits, [['active-only']]);
});

test('same-line word spacing stays in one pending phrase and every stroke restarts the 650ms debounce', async () => {
  const scheduler = new FakeScheduler();
  const provider = new FakeProvider();
  const session = new RealTimeHandwritingSession(provider, () => true, () => true, scheduler);
  session.setActive(true);

  const first = geometricStroke('first-word', 10, 20);
  const second = geometricStroke('second-word', 112, 22);
  const nextLine = geometricStroke('next-line', 12, 92);
  assert.equal(shouldGroupHandwritingStrokes([first], second), true);
  assert.equal(classifyHandwritingStroke([first, second], nextLine), 'new-line');
  assert.equal(shouldGroupHandwritingStrokes([first, second], nextLine), false);

  session.completeStroke(first);
  assert.equal(scheduler.size, 1);
  session.completeStroke(second);
  assert.equal(scheduler.size, 1);
  assert.deepEqual(scheduler.scheduledDelays, [HANDWRITING_IDLE_DELAY_MS, HANDWRITING_IDLE_DELAY_MS]);
  assert.equal(HANDWRITING_IDLE_DELAY_MS, 650);
  assert.equal(provider.calls.length, 0);
  session.completeStroke(nextLine);
  assert.deepEqual(provider.calls[0].map(item => item.id), ['first-word', 'second-word']);
  scheduler.runAll();
  await settleAsyncRecognition();
  assert.deepEqual(provider.calls[1].map(item => item.id), ['next-line']);
});

test('ordinary same-line gaps are scale-relative while new lines and unrelated writing are separated', () => {
  const first = geometricStroke('geometry-first', 10, 20);
  const nextWord = geometricStroke('geometry-word', 130, 22);
  const nextLine = geometricStroke('geometry-line', 12, 94);
  const unrelated = geometricStroke('geometry-unrelated', 700, 20);
  assert.equal(classifyHandwritingStroke([first], nextWord), 'same-line');
  assert.equal(classifyHandwritingStroke([first, nextWord], nextLine), 'new-line');
  assert.equal(classifyHandwritingStroke([first], unrelated), 'unrelated');

  assert.equal(
    classifyHandwritingStroke([scaleStroke(first, 2)], scaleStroke(nextWord, 2)),
    'same-line',
  );
  assert.equal(
    classifyHandwritingStroke([scaleStroke(first, 2), scaleStroke(nextWord, 2)], scaleStroke(nextLine, 2)),
    'new-line',
  );
});

test('recognition does not start while a new stroke is down', async () => {
  const scheduler = new FakeScheduler();
  const provider = new FakeProvider();
  const session = new RealTimeHandwritingSession(provider, () => true, () => true, scheduler);
  session.setActive(true);
  session.completeStroke(geometricStroke('down-one', 10, 20));
  session.beginStroke();
  assert.equal(scheduler.size, 0);
  scheduler.runAll();
  await settleAsyncRecognition();
  assert.equal(provider.calls.length, 0);

  session.completeStroke(geometricStroke('down-two', 100, 22));
  scheduler.runAll();
  await settleAsyncRecognition();
  assert.deepEqual(provider.calls[0].map(item => item.id), ['down-one', 'down-two']);
});

test('sealed Phrase A stays valid and immutable when Phrase B begins', async () => {
  const scheduler = new FakeScheduler();
  const resolvers: Array<(result: RecognitionResult) => void> = [];
  const calls: string[][] = [];
  const provider: HandwritingRecognitionProvider = {
    id: 'deferred', name: 'Deferred', isOffline: true,
    isAvailable: async () => true,
    recognize: async strokes => {
      calls.push(strokes.map(item => item.id));
      return new Promise(resolve => resolvers.push(resolve));
    },
  };
  const commits: Array<{ ids: string[]; pageId: string | null; batchId: string }> = [];
  const session = new RealTimeHandwritingSession(provider, conversion => {
    commits.push({
      ids: conversion.strokes.map(item => item.id),
      pageId: conversion.pageId,
      batchId: conversion.batchId,
    });
    return true;
  }, () => true, scheduler);
  session.setPageId('page-a');
  session.setActive(true);
  session.completeStroke(geometricStroke('phrase-a', 10, 20));
  scheduler.runAll();
  assert.deepEqual(calls, [['phrase-a']]);

  session.beginStroke();
  session.completeStroke(geometricStroke('phrase-b', 10, 100));
  scheduler.runAll();
  assert.deepEqual(calls, [['phrase-a']]);
  resolvers[0]({ status: 'success', text: 'Phrase A', isAvailable: true });
  await settleAsyncRecognition();
  assert.deepEqual(calls, [['phrase-a'], ['phrase-b']]);
  assert.deepEqual(commits[0].ids, ['phrase-a']);
  assert.equal(commits[0].pageId, 'page-a');
  assert.match(commits[0].batchId, /^handwriting-/);

  resolvers[1]({ status: 'success', text: 'Phrase B', isAvailable: true });
  await settleAsyncRecognition();
  assert.deepEqual(commits.map(commit => commit.ids), [['phrase-a'], ['phrase-b']]);
  assert.notEqual(commits[0].batchId, commits[1].batchId);
});

test('a clear new-line stroke seals the previous line and each batch keeps only exact source IDs', async () => {
  const scheduler = new FakeScheduler();
  const resolvers: Array<(result: RecognitionResult) => void> = [];
  const calls: string[][] = [];
  const provider: HandwritingRecognitionProvider = {
    id: 'deferred-lines', name: 'Deferred lines', isOffline: true,
    isAvailable: async () => true,
    recognize: async strokes => {
      calls.push(strokes.map(item => item.id));
      return new Promise(resolve => resolvers.push(resolve));
    },
  };
  const commits: string[][] = [];
  const session = new RealTimeHandwritingSession(provider, conversion => {
    commits.push(conversion.strokes.map(item => item.id));
    return true;
  }, () => true, scheduler);
  session.setActive(true);
  session.completeStroke(geometricStroke('line-one-a', 10, 20));
  session.completeStroke(geometricStroke('line-one-b', 100, 22));
  session.beginStroke();
  session.completeStroke(geometricStroke('line-two-a', 12, 100));
  assert.deepEqual(calls, [['line-one-a', 'line-one-b']]);
  session.completeStroke(geometricStroke('line-two-b', 105, 102));
  scheduler.runAll();
  assert.deepEqual(calls, [['line-one-a', 'line-one-b']]);
  resolvers[0]({ status: 'success', text: 'Line one', isAvailable: true });
  await settleAsyncRecognition();
  assert.deepEqual(calls, [
    ['line-one-a', 'line-one-b'],
    ['line-two-a', 'line-two-b'],
  ]);
  resolvers[1]({ status: 'success', text: 'Line two', isAvailable: true });
  await settleAsyncRecognition();
  assert.deepEqual(commits, [
    ['line-one-a', 'line-one-b'],
    ['line-two-a', 'line-two-b'],
  ]);
});

test('page switch invalidates an unsafe old result while failed or unsupported recognition preserves raw ink', async () => {
  let resolveRecognition!: (result: RecognitionResult) => void;
  const provider: HandwritingRecognitionProvider = {
    id: 'deferred', name: 'Deferred', isOffline: true,
    isAvailable: async () => true,
    recognize: async () => new Promise(resolve => { resolveRecognition = resolve; }),
  };
  const scheduler = new FakeScheduler();
  const source = stroke('page-a');
  const rawInk = [structuredClone(source)];
  let commits = 0;
  const session = new RealTimeHandwritingSession(provider, () => { commits += 1; return true; }, () => true, scheduler);
  session.setPageId('page-a');
  session.setActive(true);
  session.completeStroke(source);
  scheduler.runAll();
  session.setPageId('page-b');
  resolveRecognition({ status: 'success', text: 'wrong page', isAvailable: true });
  await settleAsyncRecognition();
  assert.equal(commits, 0);
  assert.deepEqual(rawInk, [source]);

  const unavailable = new FakeProvider({ status: 'unavailable', text: '', isAvailable: false, error: 'unsupported' });
  const failedSession = new RealTimeHandwritingSession(unavailable, () => { commits += 1; return true; }, () => true, scheduler);
  failedSession.setActive(true);
  failedSession.completeStroke(source);
  scheduler.runAll();
  await settleAsyncRecognition();
  assert.equal(commits, 0);
  assert.deepEqual(rawInk, [source]);
});

test('removed or changed source strokes and engine destruction reject stale success safely', async () => {
  const scheduler = new FakeScheduler();
  const resolvers: Array<(result: RecognitionResult) => void> = [];
  let sourceStillExists = false;
  let commits = 0;
  const provider: HandwritingRecognitionProvider = {
    id: 'stale-source', name: 'Stale source', isOffline: true,
    isAvailable: async () => true,
    recognize: async () => new Promise(resolve => resolvers.push(resolve)),
  };
  const session = new RealTimeHandwritingSession(
    provider,
    () => { commits += 1; return true; },
    () => sourceStillExists,
    scheduler,
  );
  session.setActive(true);
  session.completeStroke(stroke('removed-before-apply'));
  scheduler.runAll();
  resolvers[0]({ status: 'success', text: 'Must not apply', isAvailable: true });
  await settleAsyncRecognition();
  assert.equal(commits, 0);

  sourceStillExists = true;
  session.completeStroke(stroke('destroyed-before-apply'));
  scheduler.runAll();
  session.destroy();
  resolvers[1]({ status: 'success', text: 'Also stale', isAvailable: true });
  await settleAsyncRecognition();
  assert.equal(commits, 0);
});

test('a destroyed handwriting session can be safely re-armed by its owning engine', async () => {
  const scheduler = new FakeScheduler();
  const commits: string[] = [];
  const session = new RealTimeHandwritingSession(
    new FakeProvider({ status: 'success', text: 'back', isAvailable: true }),
    conversion => { commits.push(conversion.result.text); return true; },
    () => true,
    scheduler,
  );
  session.setActive(true);
  session.destroy();
  session.revive();
  session.setActive(true);
  session.completeStroke(stroke('after-remount'));
  scheduler.runAll();
  await settleAsyncRecognition();
  assert.deepEqual(commits, ['back']);
});

test('empty, unavailable, and bridge-error outcomes preserve ink and remain distinguishable', async () => {
  const source = stroke('outcome-source');
  const rawInk = [structuredClone(source)];
  let commits = 0;

  const runOutcome = async (result: RecognitionResult) => {
    const scheduler = new FakeScheduler();
    const feedback: Array<{ kind: string; message: string }> = [];
    const session = new RealTimeHandwritingSession(
      new FakeProvider(result),
      () => { commits += 1; return true; },
      () => true,
      scheduler,
    );
    session.subscribeFeedback(event => feedback.push(event));
    session.setActive(true);
    session.completeStroke(source);
    scheduler.runAll();
    await settleAsyncRecognition();
    return feedback;
  };

  const emptyFeedback = await runOutcome({ status: 'empty', text: '', isAvailable: true });
  const unavailableFeedback = await runOutcome({
    status: 'unavailable', text: '', isAvailable: false,
    error: 'Windows handwriting recognition is unavailable for English (US).',
  });
  const errorFeedback = await runOutcome({
    status: 'error', text: '', isAvailable: true,
    error: 'Windows handwriting bridge failed while awaiting RecognizeAsync.',
  });

  assert.equal(commits, 0);
  assert.deepEqual(rawInk, [source]);
  assert.deepEqual(emptyFeedback, []);
  assert.equal(unavailableFeedback[0]?.kind, 'unavailable');
  assert.equal(errorFeedback[0]?.kind, 'error');
});

test('worker errors never commit destructive conversion and notify only once per active session', async () => {
  const scheduler = new FakeScheduler();
  const sourceInk = [stroke('worker-error-one'), shiftedStroke('worker-error-two', 0, 120)];
  const before = structuredClone(sourceInk);
  let commits = 0;
  const feedback: string[] = [];
  const provider: HandwritingRecognitionProvider = {
    id: 'throwing-worker', name: 'Throwing worker', isOffline: true,
    isAvailable: async () => true,
    recognize: async () => { throw new Error('PowerShell worker failed.'); },
  };
  const session = new RealTimeHandwritingSession(
    provider,
    () => { commits += 1; return true; },
    () => true,
    scheduler,
  );
  session.subscribeFeedback(event => feedback.push(event.message));
  session.setActive(true);

  session.completeStroke(sourceInk[0]);
  scheduler.runAll();
  await settleAsyncRecognition();
  session.completeStroke(sourceInk[1]);
  scheduler.runAll();
  await settleAsyncRecognition();

  assert.equal(commits, 0);
  assert.deepEqual(sourceInk, before);
  assert.equal(feedback.length, 1);
  assert.match(feedback[0], /ink was kept/i);

  session.setActive(false);
  session.setActive(true);
  session.completeStroke(shiftedStroke('worker-error-three', 0, 240));
  scheduler.runAll();
  await settleAsyncRecognition();
  assert.equal(feedback.length, 2);
});

test('successful real-time conversion replaces exact IDs, leaves old nearby ink, indexes metadata, and is one-step undoable', async () => {
  const oldNearby = shiftedStroke('old-nearby', -4, 1);
  const source = stroke('active-source');
  let strokes = [structuredClone(oldNearby), structuredClone(source)];
  let texts: TextObject[] = [];
  let selection: SelectedElement[] = [];
  const history = new HistoryManager();
  const provider = new FakeProvider({ status: 'success', text: 'Searchable hello', candidates: ['Searchable hello'], isAvailable: true, language: 'en-US' });
  const scheduler = new FakeScheduler();
  const preferences = sanitizeHandwritingToolPreferences({ fontFamily: "'Kalam', cursive", fontSize: 'auto', color: '#445566', language: 'en-US' });
  const session = new RealTimeHandwritingSession(provider, conversion => {
    const placement = createBeautifiedTextPlacement(conversion.result.text, conversion.strokes, conversion.preferences)!;
    const replacement: TextObject = {
      id: 'recognized-text', type: 'text', x: placement.x, y: placement.y,
      width: placement.width, height: placement.height, createdAt: 999,
      content: createHandwritingTipTapContent(conversion.result.text, {
        fontFamily: conversion.preferences.fontFamily,
        fontSize: placement.fontSize,
        color: conversion.preferences.color,
      }),
      metadata: { generatedFrom: 'handwriting-recognition', sourceStrokeIds: conversion.strokes.map(item => item.id) },
    };
    history.push(createHandwritingConversionCommand({
      getStrokes: () => strokes,
      setStrokes: next => { strokes = next; },
      addText: next => { texts.push(next); },
      removeText: id => { texts = texts.filter(text => text.id !== id); },
      setSelection: next => { selection = next; },
      redraw: () => {},
    }, conversion.strokes, replacement, { updateSelection: false }));
    return true;
  }, requested => requested.every(item => strokes.some(existing => existing.id === item.id)), scheduler);
  session.setPreferences(preferences);
  session.setActive(true);
  session.completeStroke(source);
  scheduler.runAll();
  await settleAsyncRecognition();

  assert.deepEqual(strokes.map(item => item.id), ['old-nearby']);
  assert.equal(texts[0].metadata?.generatedFrom, 'handwriting-recognition');
  assert.deepEqual(texts[0].metadata?.sourceStrokeIds, ['active-source']);
  assert.deepEqual(texts[0].content.content[0].content[0].marks[0].attrs.color, '#445566');
  assert.match(texts[0].content.content[0].content[0].marks[0].attrs.fontFamily, /Kalam/);
  assert.deepEqual(selection, []);
  const search = extractPageSearchContent(undefined, { version: 3, objects: texts, properties: {} as any });
  assert.equal(search.handwritingText, 'Searchable hello');

  history.undo();
  assert.deepEqual(strokes, [oldNearby, source]);
  assert.equal(texts.length, 0);
  history.redo();
  assert.deepEqual(strokes.map(item => item.id), ['old-nearby']);
  assert.equal(texts.length, 1);
});

test('web provider feature adapter preserves page coordinates, temporal order, language, and alternatives', async () => {
  const received: Array<Array<{ x: number; y: number; t: number }>> = [];
  class NativeStroke {
    points: Array<{ x: number; y: number; t: number }> = [];
    addPoint(point: { x: number; y: number; t: number }): void { this.points.push(point); }
  }
  const provider = new WebHandwritingRecognitionProvider({
    HandwritingStroke: NativeStroke,
    createHandwritingRecognizer: async constraint => {
      assert.deepEqual(constraint, { languages: ['hi-IN'] });
      return {
        startDrawing: hints => {
          assert.equal(hints?.alternatives, 5);
          return {
            addStroke: native => { received.push((native as NativeStroke).points); },
            getPrediction: async () => [{ text: 'नमस्ते' }, { text: 'नमस्कार' }],
          };
        },
        finish: () => {},
      };
    },
  });
  const first = stroke('web-first');
  first.createdAt = 1_000;
  const second = shiftedStroke('web-second', 100, 40);
  second.createdAt = 1_100;
  const result = await provider.recognize([first, second], { language: 'hi-IN' });
  assert.equal(result.text, 'नमस्ते');
  assert.deepEqual(result.candidates, ['नमस्ते', 'नमस्कार']);
  assert.deepEqual(received[0][0], { x: 10, y: 20, t: 4 });
  assert.deepEqual(received[1][0], { x: 110, y: 60, t: 104 });
});

test('auto placement is page-coordinate based and preference persistence keeps font and color', async () => {
  const source = shiftedStroke('zoom-independent', 250, 300);
  const preferences = sanitizeHandwritingToolPreferences({ fontFamily: "'Times New Roman', serif", fontSize: 32, color: '#123abc', language: 'fr-FR' });
  const placement = createBeautifiedTextPlacement('Bonjour', [source], preferences)!;
  assert.equal(placement.x, 260);
  assert.equal(placement.fontSize, 32);
  assert.ok(placement.y >= 0);
  assert.ok(placement.width >= 160);
  assert.deepEqual(sanitizeHandwritingToolPreferences(JSON.parse(JSON.stringify(preferences))), preferences);

  const toolbar = await readFile(new URL('../src/components/notebook/NotebookFloatingToolbar.tsx', import.meta.url), 'utf8');
  assert.match(toolbar, /handwritingSettings/);
  assert.match(toolbar, /toolbar\.presets\.v1/);
  assert.match(toolbar, /HandwritingSettingsStrip/);
  assert.match(toolbar, /applyHandwritingInkPreferences\(engine\.tools, handwritingSettings\)/);
  assert.match(toolbar, /active=\{toolState\.handwritingToTextEnabled\}/);
  assert.match(toolbar, /engine\.tools\.toggleHandwritingToText\(\)/);
  const handwritingToolBranch = toolbar.match(/if \(toolId === 'handwriting-to-text'\) \{([\s\S]*?)\n    \} else if \(toolId === 'select'\)/)?.[1] ?? '';
  assert.match(handwritingToolBranch, /engine\.tools\.setDrawingTool\(toolState\.drawingTool === 'pencil' \? 'pencil' : 'pen'\)/);
  assert.doesNotMatch(handwritingToolBranch, /selection|setMode\('select'\)/);
  assert.match(toolbar, /showHandwritingSettings = !compactTools && toolState\.handwritingToTextEnabled\s*&& toolState\.mode === 'draw'/);
  assert.match(toolbar, /compactTools && toolState\.handwritingToTextEnabled && <HandwritingSettingsStrip\s+settings=\{handwritingSettings\}\s+onChange=\{updateHandwritingSettings\}/);
  assert.doesNotMatch(toolbar, /setHandwritingToTextTool/);
  assert.doesNotMatch(toolbar, /activeTool === 'handwriting-to-text'/);
  assert.match(toolbar, /recentColors=\{settings\.recentColors\}/);
  assert.match(toolbar, /HANDWRITING_THICKNESS_PRESETS/);
});

test('four sequential converted lines preserve source order, shared margin, and non-overlapping glyph bands', () => {
  const existing: ExistingHandwritingLinePlacement[] = [];
  const resolved = [
    { text: 'Panvas fixed multi-word sentence handwriting conversion', x: 100, y: 80, fontSize: 24 },
    { text: 'Use correct working tree', x: 103, y: 108, fontSize: 32 },
    { text: 'This is a focused repair only', x: 98, y: 136, fontSize: 20 },
    { text: 'Do not launch Panvas', x: 102, y: 164, fontSize: 36 },
  ].map((line, index) => {
    const source = geometricStroke(`placement-${index}`, line.x, line.y, 180, 30);
    const preferences = sanitizeHandwritingToolPreferences({ fontSize: line.fontSize, color: '#4433aa' });
    const initial = createBeautifiedTextPlacement(line.text, [source], preferences)!;
    const placement = resolveHandwritingLinePlacement(initial, existing);
    existing.push({
      x: placement.x,
      y: placement.y,
      width: placement.width,
      lineHeight: placement.lineHeight,
      sourceBounds: placement.bounds,
      sourceBaseline: placement.baseline,
    });
    return placement;
  });

  assert.equal(resolved[0].x, 100);
  assert.ok(resolved.every(placement => placement.x === resolved[0].x));
  for (let index = 1; index < resolved.length; index += 1) {
    assert.ok(resolved[index].y > resolved[index - 1].y);
    assert.ok(resolved[index].y + 4 >= resolved[index - 1].y + 4 + resolved[index - 1].lineHeight);
  }
});

test('Auto font size preserves handwriting height for long sentences and expands width instead of shrinking text', () => {
  const source = geometricStroke('auto-sentence', 40, 60, 220, 44);
  const preferences = sanitizeHandwritingToolPreferences({ fontSize: 'auto' });
  const short = createBeautifiedTextPlacement('Hello', [source], preferences)!;
  const sentence = createBeautifiedTextPlacement(
    'Today I am testing Panvas handwriting conversion across a complete phrase',
    [source],
    preferences,
  )!;
  assert.equal(sentence.fontSize, short.fontSize);
  assert.ok(sentence.width > short.width);
  assert.equal(sentence.x, source.points[0].x);

  const small = createBeautifiedTextPlacement(
    'small',
    [geometricStroke('small-auto-size', 40, 140, 120, 16)],
    preferences,
  )!;
  const large = createBeautifiedTextPlacement(
    'large',
    [geometricStroke('large-auto-size', 40, 200, 240, 58)],
    preferences,
  )!;
  assert.ok(large.fontSize > small.fontSize);
});

function generatedHandwritingText(
  id: string,
  value: string,
  source: Stroke,
  preferences = sanitizeHandwritingToolPreferences({ fontFamily: "'Kalam', cursive", fontSize: 28, color: '#334455' }),
): TextObject {
  const placement = createBeautifiedTextPlacement(value, [source], preferences)!;
  return {
    id, type: 'text', x: placement.x, y: placement.y, width: placement.width,
    height: placement.height, createdAt: 500, layerId: source.layerId,
    content: createHandwritingTipTapContent(value, {
      fontFamily: preferences.fontFamily, fontSize: placement.fontSize, color: preferences.color,
    }),
    metadata: {
      generatedFrom: 'handwriting-recognition', recognitionBatchId: `${id}-batch`,
      handwritingLineId: `${id}-line`, sourcePageId: 'page-a', sourceStrokeIds: [source.id],
      sourceBounds: placement.bounds, sourceBaseline: placement.baseline,
      sourceLineHeight: placement.bounds.height, handwritingLineHeight: placement.lineHeight,
      handwritingFontSize: placement.fontSize,
    },
  };
}

test('same-line continuation appends into one formatted TextObject with atomic source-stroke undo and redo', () => {
  const preferences = sanitizeHandwritingToolPreferences({ fontFamily: "'Kalam', cursive", fontSize: 28, color: '#334455' });
  const originalSource = geometricStroke('old-phrase-source', 20, 100, 120, 30);
  const continuationSource = geometricStroke('continuation-3000', 180, 103, 70, 30);
  const originalText = generatedHandwritingText('generated-line', 'I love you', originalSource, preferences);
  const placement = createBeautifiedTextPlacement('3000', [continuationSource], preferences)!;
  const match = findSameGeneratedHandwritingLine([originalText], placement.bounds, originalText.layerId, 'page-a');

  assert.ok(match);
  assert.equal(match.side, 'append');
  assert.equal(hasMatchingHandwritingTypography(originalText, preferences, placement.fontSize), true);
  const extended = createExtendedHandwritingLine(match, '3000', placement, [continuationSource], 'continuation-batch')!;
  assert.equal(getHandwritingText(extended.content), 'I love you 3000');
  assert.equal(extended.y, originalText.y, 'same-line conversion cannot drift vertically');
  assert.deepEqual(
    extended.content.content[0].content[0].marks,
    originalText.content.content[0].content[0].marks,
  );
  assert.equal(extended.metadata?.handwritingLineId, originalText.metadata?.handwritingLineId);
  assert.deepEqual(extended.metadata?.sourceStrokeIds, ['old-phrase-source', 'continuation-3000']);

  let strokes = [structuredClone(continuationSource)];
  let texts = [structuredClone(originalText)];
  const history = new HistoryManager();
  let previousConversionUndone = false;
  history.pushExecuted({
    description: 'Earlier line conversion',
    execute: () => { previousConversionUndone = false; },
    undo: () => { previousConversionUndone = true; },
  });
  history.pushExecuted({
    description: 'Draw continuation source',
    createdObjectIds: [continuationSource.id],
    execute: () => {},
    undo: () => { strokes = []; },
  });
  history.pushReplacingCreations(createHandwritingContinuationCommand({
    getStrokes: () => strokes,
    setStrokes: next => { strokes = next; },
    replaceText: next => {
      const index = texts.findIndex(text => text.id === next.id);
      if (index < 0) return false;
      texts[index] = next;
      return true;
    },
    redraw: () => {},
  }, [continuationSource], originalText, extended), [continuationSource.id]);
  assert.deepEqual(strokes, []);
  assert.equal(getHandwritingText(texts[0].content), 'I love you 3000');
  history.undo();
  assert.deepEqual(strokes, [continuationSource]);
  assert.equal(getHandwritingText(texts[0].content), 'I love you');
  assert.equal(previousConversionUndone, false);
  history.undo();
  assert.equal(previousConversionUndone, true, 'earlier converted-line history remains intact');
  history.redo();
  history.redo();
  assert.deepEqual(strokes, []);
  assert.equal(getHandwritingText(texts[0].content), 'I love you 3000');
});

test('same-line continuation prepends by source X while a physical next line remains separate', () => {
  const preferences = sanitizeHandwritingToolPreferences({ fontFamily: "'Kalam', cursive", fontSize: 28, color: '#334455' });
  const existingSource = geometricStroke('existing-love-you', 100, 100, 120, 30);
  const existing = generatedHandwritingText('existing-line', 'love you', existingSource, preferences);
  const beforeSource = geometricStroke('prefix-i', 45, 102, 20, 30);
  const beforePlacement = createBeautifiedTextPlacement('I', [beforeSource], preferences)!;
  const beforeMatch = findSameGeneratedHandwritingLine([existing], beforePlacement.bounds, existing.layerId, 'page-a');
  assert.ok(beforeMatch);
  assert.equal(beforeMatch.side, 'prepend');
  assert.equal(getHandwritingText(createExtendedHandwritingLine(
    beforeMatch, 'I', beforePlacement, [beforeSource], 'prefix-batch',
  )!.content), 'I love you');

  const nextLineSource = geometricStroke('next-physical-line', 100, 145, 160, 30);
  const nextPlacement = createBeautifiedTextPlacement('This is Panvas', [nextLineSource], preferences)!;
  assert.equal(findSameGeneratedHandwritingLine([existing], nextPlacement.bounds, existing.layerId, 'page-a'), null);
  const anchored = anchorNewHandwritingLinePlacement(nextPlacement, [{
    x: existing.x, y: existing.y, width: existing.width,
    lineHeight: existing.metadata?.handwritingLineHeight,
    sourceBounds: existing.metadata?.sourceBounds,
    sourceBaseline: existing.metadata?.sourceBaseline,
  }]);
  assert.equal(anchored.y, nextPlacement.y, 'new-line source Y remains authoritative');
  assert.equal(anchored.x, existing.x, 'nearby left margins align without changing line height');
});

test('same-line continuation rejects distant ink even after an earlier source union grew tall', () => {
  const preferences = sanitizeHandwritingToolPreferences({ fontFamily: "'Kalam', cursive", fontSize: 28, color: '#334455' });
  const existingSource = geometricStroke('existing-source', 20, 100, 120, 30);
  const existing = generatedHandwritingText('existing-line', 'top line', existingSource, preferences);
  existing.metadata!.sourceBounds = { x: 20, y: 100, width: 220, height: 500 };

  const lowerSource = geometricStroke('lower-source', 40, 500, 120, 30);
  const farRightSource = geometricStroke('far-right-source', 900, 102, 80, 30);
  assert.equal(findSameGeneratedHandwritingLine(
    [existing], createBeautifiedTextPlacement('lower line', [lowerSource], preferences)!.bounds,
    existing.layerId, 'page-a',
  ), null, 'an accumulated union box must not pull lower writing onto the old line');
  assert.equal(findSameGeneratedHandwritingLine(
    [existing], createBeautifiedTextPlacement('far away', [farRightSource], preferences)!.bounds,
    existing.layerId, 'page-a',
  ), null, 'same-baseline ink must still be spatially near the generated run');
});

test('three sequential physical lines keep their source baselines without cumulative drift', () => {
  const preferences = sanitizeHandwritingToolPreferences({ fontSize: 28 });
  const existing: ExistingHandwritingLinePlacement[] = [];
  const placements = [100, 145, 190].map((sourceY, index) => {
    const source = geometricStroke(`sequential-source-${index}`, 100 + index * 2, sourceY, 150, 30);
    const initial = createBeautifiedTextPlacement(`Line ${index + 1}`, [source], preferences)!;
    const anchored = anchorNewHandwritingLinePlacement(initial, existing);
    existing.push({
      x: anchored.x,
      y: anchored.y,
      width: anchored.width,
      lineHeight: anchored.lineHeight,
      sourceBounds: anchored.bounds,
      sourceBaseline: anchored.baseline,
    });
    return anchored;
  });

  assert.deepEqual(placements.map(placement => placement.baseline), [124.6, 169.6, 214.6]);
  assert.deepEqual(placements.map(placement => placement.x), [100, 100, 100]);
  assert.deepEqual(
    placements.slice(1).map((placement, index) => placement.y - placements[index].y),
    [45, 45],
    'each generated line keeps the natural source-line interval',
  );
});

test('same-line decision is independent of viewport zoom and scales with document geometry', () => {
  const preferences = sanitizeHandwritingToolPreferences({ fontSize: 28 });
  const existingSource = geometricStroke('zoom-existing', 20, 100, 120, 30);
  const continuation = geometricStroke('zoom-continuation', 180, 103, 70, 30);
  const existing = generatedHandwritingText('zoom-line', 'I love you', existingSource, preferences);
  const normal = findSameGeneratedHandwritingLine(
    [existing], createBeautifiedTextPlacement('3000', [continuation], preferences)!.bounds, existing.layerId, 'page-a',
  );
  const scale = 3;
  const scaledExistingSource = scaleStroke(existingSource, scale);
  const scaledExisting = generatedHandwritingText('zoom-line-scaled', 'I love you', scaledExistingSource, preferences);
  const scaled = findSameGeneratedHandwritingLine(
    [scaledExisting], createBeautifiedTextPlacement('3000', [scaleStroke(continuation, scale)], preferences)!.bounds,
    scaledExisting.layerId, 'page-a',
  );
  assert.equal(normal?.side, 'append');
  assert.equal(scaled?.side, 'append');
});

test('Auto continuation tolerates small source-height metric variation but preserves deliberate formatting changes', () => {
  const source = geometricStroke('auto-format-source', 20, 100, 120, 30);
  const autoPreferences = sanitizeHandwritingToolPreferences({
    fontFamily: "'Kalam', cursive", fontSize: 'auto', color: '#334455',
  });
  const existing = generatedHandwritingText(
    'auto-format-line', 'I love you', source,
    sanitizeHandwritingToolPreferences({ ...autoPreferences, fontSize: 28 }),
  );
  assert.equal(hasMatchingHandwritingTypography(existing, autoPreferences, 30), true);
  assert.equal(hasMatchingHandwritingTypography(existing, autoPreferences, 40), false);
  assert.equal(hasMatchingHandwritingTypography(
    existing,
    sanitizeHandwritingToolPreferences({ ...autoPreferences, color: '#ff0000' }),
    28,
  ), false);
});

test('handwriting color history is unique and capped at five', () => {
  const preferences = sanitizeHandwritingToolPreferences({
    color: '#abcdef',
    recentColors: ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#ABCDEF'],
  });
  assert.deepEqual(preferences.recentColors, ['#abcdef', '#111111', '#222222', '#333333', '#444444']);
});

test('selected handwriting color and thickness drive raw ink and converted text without changing Pen preferences', () => {
  const penPreferences = { color: '#101010', thickness: 1.2 };
  const originalPenPreferences = { ...penPreferences };
  const inputStyle = { ...penPreferences };
  const preferences = sanitizeHandwritingToolPreferences({
    color: '#4a5b6c',
    thickness: 3.6,
    recentColors: ['#4a5b6c'],
  });

  applyHandwritingInkPreferences({
    setHandwritingInkStyle: (color, thickness) => {
      inputStyle.color = color;
      inputStyle.thickness = thickness;
    },
  }, preferences);
  const rawInk = stroke('styled-handwriting');
  rawInk.color = inputStyle.color;
  rawInk.thickness = inputStyle.thickness;
  const content = createHandwritingTipTapContent('Styled', {
    color: preferences.color,
    fontFamily: preferences.fontFamily,
    fontSize: 24,
  });

  assert.equal(rawInk.color, '#4a5b6c');
  assert.equal(rawInk.thickness, 3.6);
  assert.equal(content.content[0].content[0].marks[0].attrs.color, '#4a5b6c');
  assert.deepEqual(penPreferences, originalPenPreferences);
});

test('bulk selection eligibility includes only exact editable selected Pen and Pencil strokes', () => {
  const pen = geometricStroke('selected-pen', 10, 20);
  const pencil = { ...geometricStroke('selected-pencil', 50, 20), tool: 'pencil' as const };
  const marker = { ...geometricStroke('selected-marker', 90, 20), tool: 'marker' as const };
  const unselected = geometricStroke('unselected-pen', 130, 20);
  const locked = { ...geometricStroke('locked-pen', 170, 20), layerId: 'locked' };
  const selectedIds = new Set([pen.id, pencil.id, marker.id, locked.id]);

  const eligible = getEligibleSelectedHandwritingStrokes(
    [pen, marker, unselected, pencil, locked],
    selectedIds,
    candidate => candidate.layerId !== 'locked',
  );

  assert.deepEqual(eligible.map(candidate => candidate.id), ['selected-pen', 'selected-pencil']);
  assert.deepEqual(getEligibleSelectedHandwritingStrokes([marker], new Set([marker.id])), []);
});

test('bulk line segmentation keeps same-line strokes together and returns three top-to-bottom page-coordinate batches', () => {
  const source = [
    geometricStroke('line-3-b', 100, 140, 24, 30),
    geometricStroke('line-1-b', 90, 20, 24, 30),
    geometricStroke('line-2-a', 20, 80, 24, 30),
    geometricStroke('line-1-a', 20, 22, 24, 28),
    geometricStroke('line-3-a', 20, 142, 24, 28),
    geometricStroke('line-2-b', 100, 78, 24, 32),
  ];

  const lines = segmentHandwritingStrokesIntoLines(source);

  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(line => line.strokes.map(item => item.id)), [
    ['line-1-a', 'line-1-b'],
    ['line-2-a', 'line-2-b'],
    ['line-3-a', 'line-3-b'],
  ]);
  assert.ok(lines[0].baseline < lines[1].baseline && lines[1].baseline < lines[2].baseline);
});

test('bulk line segmentation attaches dots and crossbars without bridging neighboring baselines', () => {
  const lineOneStem = geometricStroke('line-1-stem', 40, 20, 8, 30);
  const lineOneDot = geometricStroke('line-1-dot', 42, 8, 2, 2);
  const lineTwoStem = geometricStroke('line-2-stem', 40, 78, 8, 30);
  const lineTwoCrossbar = geometricStroke('line-2-crossbar', 32, 88, 20, 1);

  const lines = segmentHandwritingStrokesIntoLines([
    lineTwoCrossbar, lineOneDot, lineTwoStem, lineOneStem,
  ]);

  assert.equal(lines.length, 2);
  assert.deepEqual(new Set(lines[0].strokes.map(item => item.id)), new Set(['line-1-dot', 'line-1-stem']));
  assert.deepEqual(new Set(lines[1].strokes.map(item => item.id)), new Set(['line-2-crossbar', 'line-2-stem']));
});

test('bulk segmentation is scale invariant and preserves clearly intentional blank-line spacing', () => {
  const source = [
    geometricStroke('first', 30, 20, 30, 30),
    geometricStroke('second', 30, 75, 30, 30),
    geometricStroke('after-blank', 30, 190, 30, 30),
  ];
  const original = segmentHandwritingStrokesIntoLines(source);
  const scaled = segmentHandwritingStrokesIntoLines(source.map(item => scaleStroke(item, 2.5)));

  assert.deepEqual(scaled.map(line => line.strokes.map(item => item.id)), original.map(line => line.strokes.map(item => item.id)));
  assert.equal(original.length, 3);
  assert.equal(original[1].blankLinesBefore, 0);
  assert.ok(original[2].blankLinesBefore >= 1);
});

test('ten physical numbered handwriting lines remain ten ordered logical lines with a blank gap', () => {
  const sources = Array.from({ length: 10 }, (_, index) => {
    const blankGap = index >= 5 ? 60 : 0;
    const indentation = index % 3 === 1 ? 24 : 0;
    return geometricStroke(`numbered-line-${index + 1}`, 30 + indentation, 20 + index * 55 + blankGap, 150, 30);
  });
  const lines = segmentHandwritingStrokesIntoLines(sources);
  const reviewed: ReviewedHandwritingLine[] = lines.map((line, index) => ({
    ...line, text: `${index + 1}. item ${index + 1}`, candidates: [], status: 'success',
  }));

  assert.equal(lines.length, 10);
  assert.deepEqual(lines.map(line => line.strokes[0].id), sources.map(source => source.id));
  assert.ok(lines[5].blankLinesBefore >= 1);
  assert.equal(formatHandwritingReviewText(reviewed).split('\n').filter(Boolean).length, 10);
  assert.ok(lines[1].bounds.x > lines[0].bounds.x);
});

test('bulk recognition sends one ordered request per detected line, preserves punctuation, and isolates failures', async () => {
  const source = [
    geometricStroke('first-a', 20, 20), geometricStroke('first-b', 80, 20),
    geometricStroke('second-a', 20, 90), geometricStroke('second-b', 80, 90),
    geometricStroke('third-a', 20, 160), geometricStroke('third-b', 80, 160),
  ];
  const snapshot = structuredClone(source);
  const batches = segmentHandwritingStrokesIntoLines(source);
  const responses: RecognitionResult[] = [
    { status: 'success', text: 'Today I studied algorithms', candidates: ['Today I studied algorithms'], isAvailable: true },
    { status: 'success', text: 'Dynamic programming was difficult.', candidates: ['Dynamic programming was difficult.'], isAvailable: true },
    { status: 'error', text: '', candidates: [], isAvailable: true, error: 'line failed' },
  ];
  const calls: string[][] = [];
  const provider: HandwritingRecognitionProvider = {
    id: 'sequence-provider', name: 'Sequence', isOffline: true,
    isAvailable: async () => true,
    recognize: async strokes => {
      calls.push(strokes.map(item => item.id));
      return responses[calls.length - 1];
    },
  };

  const reviewed = await recognizeHandwritingLines(provider, batches, { language: 'en-US' });

  assert.deepEqual(calls, batches.map(line => line.strokes.map(item => item.id)));
  assert.deepEqual(reviewed.map(line => line.text), ['Today I studied algorithms', 'Dynamic programming was difficult.', '']);
  assert.equal(reviewed[2].status, 'error');
  assert.deepEqual(source, snapshot);
});

test('bulk review and placement preserve line breaks, blank spacing, indentation, and non-overlapping order', () => {
  const batches = segmentHandwritingStrokesIntoLines([
    geometricStroke('placement-1', 40, 20, 180, 32),
    geometricStroke('placement-2', 112, 78, 180, 32),
    geometricStroke('placement-3', 40, 194, 180, 32),
  ]);
  const reviewed: ReviewedHandwritingLine[] = batches.map((line, index) => ({
    ...line,
    text: ['1. architecture reused', '2. selection changes', '3. line segmentation'][index],
    candidates: [], status: 'success', language: 'en-US',
  }));
  const placements = createBulkHandwritingLinePlacements(
    reviewed,
    sanitizeHandwritingToolPreferences({ fontFamily: "'Kalam', cursive", fontSize: 'auto', color: '#445566' }),
  );

  assert.equal(formatHandwritingReviewText(reviewed), '1. architecture reused\n2. selection changes\n\n3. line segmentation');
  assert.equal(placements.length, 3);
  assert.ok(placements[0].placement.x < placements[1].placement.x);
  assert.ok(placements[0].placement.y < placements[1].placement.y && placements[1].placement.y < placements[2].placement.y);
  for (let index = 1; index < placements.length; index += 1) {
    assert.ok(placements[index].placement.y >= placements[index - 1].placement.y + placements[index - 1].placement.lineHeight);
  }
});

test('bulk conversion is one atomic history entry and leaves unselected strokes and mixed selected objects unchanged', () => {
  const untouched = geometricStroke('unselected-source', 300, 20);
  const selected = [
    geometricStroke('bulk-1-a', 20, 20), geometricStroke('bulk-1-b', 80, 20),
    geometricStroke('bulk-2-a', 20, 90), geometricStroke('bulk-2-b', 80, 90),
    geometricStroke('bulk-3-a', 20, 160), geometricStroke('bulk-3-b', 80, 160),
  ];
  const original = [untouched, ...selected];
  let strokes = structuredClone(original);
  let texts: TextObject[] = [];
  let selection: SelectedElement[] = [
    { type: 'image', id: 'selected-image' },
    ...selected.map(item => ({ type: 'stroke' as const, id: item.id })),
  ];
  const replacements: TextObject[] = ['First line', 'Second line', 'Third line'].map((text, index) => ({
    id: `bulk-text-${index + 1}`, type: 'text', x: 20, y: 20 + index * 70,
    width: 220, height: 48, createdAt: 1_000 + index,
    content: createHandwritingTipTapContent(text),
    metadata: { generatedFrom: 'handwriting-recognition', bulkLineIndex: index },
  }));
  const history = new HistoryManager();
  history.push(createHandwritingConversionCommand({
    getStrokes: () => strokes,
    setStrokes: next => { strokes = next; },
    addText: next => { texts.push(next); },
    removeText: id => { texts = texts.filter(text => text.id !== id); },
    setSelection: next => { selection = next; },
    redraw: () => {},
  }, selected, replacements, {
    sourceSelection: structuredClone(selection),
    replacementSelection: [
      { type: 'image', id: 'selected-image' },
      ...replacements.map(text => ({ type: 'text' as const, id: text.id })),
    ],
  }));

  assert.deepEqual(strokes, [untouched]);
  assert.deepEqual(texts.map(text => text.id), ['bulk-text-1', 'bulk-text-2', 'bulk-text-3']);
  assert.deepEqual(selection[0], { type: 'image', id: 'selected-image' });
  history.undo();
  assert.deepEqual(strokes, original);
  assert.deepEqual(texts, []);
  assert.equal(selection.filter(item => item.type === 'stroke').length, 6);
  history.undo();
  assert.deepEqual(strokes, original);
  history.redo();
  assert.deepEqual(strokes, [untouched]);
  assert.equal(texts.length, 3);

  const search = extractPageSearchContent(undefined, { version: 3, objects: texts, properties: {} as any });
  assert.equal(search.handwritingText, 'First line Second line Third line');
  assert.ok(texts.every(text => text.metadata?.generatedFrom === 'handwriting-recognition'));
});

test('dialog-owned handwriting snapshot survives modal selection clearing and remains undoable', () => {
  const selected = [
    geometricStroke('dialog-line-1', 20, 20),
    { ...geometricStroke('dialog-line-2', 20, 100), tool: 'pencil' as const, color: '#dc2626' },
  ];
  let strokes = [...selected, ...Array.from({ length: 20 }, (_, index) => geometricStroke(`unrelated-${index}`, 400, 20 + index * 5))];
  const layers = new LayerManager();
  const history = new HistoryManager();
  const texts = new TextManager(layers);
  const drawing = {
    getStrokes: () => strokes,
    setStrokes: (next: Stroke[]) => { strokes = next; },
    redraw: () => {},
  };
  const selection = new SelectionEngine(
    drawing as any,
    { getShapes: () => [] } as any,
    history,
    {} as any,
    texts,
    { getImages: () => [] } as any,
    layers,
  );
  selected.forEach(source => selection.select(source.id, 'stroke', true));
  const cancelledSnapshot = selection.getSelectedStrokes();
  selection.clearSelection();
  assert.deepEqual(cancelledSnapshot, selected);
  assert.ok(selected.every(source => strokes.some(current => current.id === source.id)));
  assert.deepEqual(texts.getTexts(), []);

  // Reopening the dialog must capture a fresh stable snapshot after cancel.
  selected.forEach(source => selection.select(source.id, 'stroke', true));
  const dialogSnapshot = selection.getSelectedStrokes();
  selection.clearSelection(); // Modal focus/dialog interaction may clear the visual selection.

  const replacements: TextObject[] = ['First reviewed line', 'Second reviewed line'].map((text, index) => ({
    id: `dialog-text-${index + 1}`,
    type: 'text',
    x: 20,
    y: 20 + index * 80,
    width: 240,
    height: 48,
    createdAt: 2_000 + index,
    content: createHandwritingTipTapContent(text, { fontFamily: "'Sacramento', cursive", color: '#123456', fontSize: 28 }),
  }));

  assert.equal(selection.replaceSelectedStrokesWithTexts(dialogSnapshot, replacements), true);
  assert.deepEqual(strokes.map(source => source.id), Array.from({ length: 20 }, (_, index) => `unrelated-${index}`));
  assert.deepEqual(texts.getTexts().map(text => text.id), ['dialog-text-1', 'dialog-text-2']);
  const savedDrawing = createEmptyDrawingData();
  savedDrawing.objects = structuredClone([...strokes, ...texts.getTexts()]);
  const reopenedDrawing = structuredClone(savedDrawing);
  const reopenedTexts = reopenedDrawing.objects?.filter(object => object.type === 'text') ?? [];
  assert.deepEqual(reopenedTexts.map(text => text.id), ['dialog-text-1', 'dialog-text-2']);
  assert.equal(reopenedTexts[0]?.content.content[0].content[0].marks[0].attrs.fontFamily, "'Sacramento', cursive");
  history.undo();
  assert.ok(selected.every(source => strokes.some(current => current.id === source.id)));
  assert.deepEqual(texts.getTexts(), []);
  history.redo();
  assert.ok(selected.every(source => !strokes.some(current => current.id === source.id)));
  assert.deepEqual(texts.getTexts().map(text => text.id), ['dialog-text-1', 'dialog-text-2']);
});

test('dialog-owned handwriting snapshot is rejected after a genuine source-stroke edit', () => {
  const source = geometricStroke('changed-after-dialog-open', 20, 20);
  let strokes = [source];
  const layers = new LayerManager();
  const selection = new SelectionEngine(
    { getStrokes: () => strokes, setStrokes: (next: Stroke[]) => { strokes = next; }, redraw: () => {} } as any,
    { getShapes: () => [] } as any,
    new HistoryManager(),
    {} as any,
    new TextManager(layers),
    { getImages: () => [] } as any,
    layers,
  );
  selection.select(source.id, 'stroke');
  const dialogSnapshot = selection.getSelectedStrokes();
  selection.clearSelection();
  strokes = [{ ...source, color: '#ffffff' }];
  assert.equal(selection.replaceSelectedStrokesWithTexts(dialogSnapshot, [{
    id: 'must-not-exist', type: 'text', x: 0, y: 0, width: 100, height: 30, createdAt: 1,
    content: createHandwritingTipTapContent('stale'),
  }]), false);
  assert.deepEqual(strokes, [{ ...source, color: '#ffffff' }]);
});

test('manual selected-ink conversion dialog remains available as the correction workflow', async () => {
  const [dialog, renderer, menu, toolbar, selection, engine] = await Promise.all([
    readFile(new URL('../src/components/notebook/HandwritingConversionDialog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/notebook/NotebookRenderer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/notebook/NotebookContextMenu.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/notebook/NotebookFloatingToolbar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/notebook/engine/SelectionEngine.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/notebook/engine/NotebookEngine.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(dialog, /Recognition alternatives/);
  assert.match(dialog, /Recognized handwriting lines/);
  assert.match(dialog, /<TextFontPicker/);
  assert.doesNotMatch(dialog, /<optgroup label="(?:Standard|Handwriting)"/);
  assert.match(dialog, /onConfirm\(lines, preferences, providerId\)/);
  assert.match(renderer, /<HandwritingConversionDialog/);
  assert.match(renderer, /initialPreferences=\{notebookEngine\.handwriting\.getPreferences\(\)\}/);
  assert.match(renderer, /convertSelectedHandwritingLinesToText/);
  assert.doesNotMatch(renderer, /autoOpenedHandwritingSelectionRef/);
  assert.match(menu, /Convert to Text/);
  assert.match(toolbar, /Convert to Text/);
  assert.match(selection, /getEligibleSelectedHandwritingStrokes/);
  assert.match(engine, /generatedFrom: 'handwriting-recognition'/);
  assert.match(engine, /bulkConversionId/);
  assert.match(engine, /bulkLineIndex/);
  assert.match(engine, /sourceStrokeIds/);
});
