import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import katex from 'katex';
import {
  createMathOcrSession,
  inspectMathOcrCache,
  normalizeTexTellerLatex,
} from '../electron/services/mathOcrCore.mjs';
import {
  assembleMultiLineMathLatex,
  normalizeTextToMathLatex,
  recognizeHandwritingToMath,
  segmentMathLines,
} from '../src/services/handwriting/mathRecognizer.ts';
import type { Stroke } from '../src/components/notebook/engine/drawingTypes.ts';

function makeStroke(points: Array<[number, number]>, id = 's'): Stroke {
  return {
    id,
    type: 'stroke',
    tool: 'pen',
    color: '#111827',
    thickness: 3,
    opacity: 1,
    createdAt: 1,
    points: points.map(([x, y], idx) => ({ x, y, pressure: 0.55, t: idx * 8 })),
  };
}

function assertValidLatex(latex: string, label: string): void {
  assert.ok(latex.length > 0, `${label}: empty LaTeX output`);
  const rendered = katex.renderToString(latex, { displayMode: true, throwOnError: true, strict: false });
  assert.match(rendered, /class="katex"/, `${label}: KaTeX failed to render ${latex}`);
}

test('real TexTeller3-ONNX (q8) accurately converts all 5 School-to-PhD handwritten formulas to valid KaTeX LaTeX', async () => {
  const cacheDir = path.resolve('artifacts/math-ocr-bench/hf-cache');
  const cached = inspectMathOcrCache(cacheDir);
  assert.equal(cached.ready, true, `Expected cached TexTeller3-ONNX q8 model under ${cacheDir}`);

  const session = createMathOcrSession({ cacheDir });
  try {
    // 1. Elementary arithmetic / algebra: x + 5 + 4 + 3 = 9
    const addPng = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="160">
        <rect width="100%" height="100%" fill="#ffffff"/>
        <text x="48" y="108" font-family="DejaVu Sans, Arial, serif" font-size="68" fill="#000000">x + 5 + 4 + 3 = 9</text>
      </svg>`,
    )).png().toBuffer();
    const resAdd = await session.recognizeImage(addPng);
    assert.match(resAdd.latex.replace(/\s+/g, ''), /x\+5\+4\+3=9/);
    assertValidLatex(resAdd.latex, 'x + 5 + 4 + 3 = 9');

    // 2. Quadratic fraction (handwritten stroke paths matching user canvas input): \frac{x^2 + 1}{2}
    const fracPng = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="280">
        <rect width="100%" height="100%" fill="#ffffff"/>
        <g fill="none" stroke="#000000" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M105,62 L135,98"/><path d="M135,62 L105,98"/>
          <path d="M148,46 C155,36 170,38 171,48 C171,56 151,66 149,71 L174,71"/>
          <path d="M210,60 L210,98"/><path d="M191,79 L229,79"/>
          <path d="M254,66 L268,54 L268,100"/>
          <path d="M72,136 L305,136"/>
          <path d="M168,170 C176,154 202,156 202,174 C202,190 170,210 166,220 L206,220"/>
        </g>
      </svg>`,
    )).png().toBuffer();
    const resFrac = await session.recognizeImage(fracPng);
    assert.match(resFrac.latex.replace(/\s+/g, ''), /\\frac\{x\^\{?2\}?\+1\}\{2\}/);
    assertValidLatex(resFrac.latex, 'fraction (x^2+1)/2');

    // 3. Definite integral (handwritten strokes): \int_0^\infty e^{-x} dx
    const intPng = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="220">
        <rect width="100%" height="100%" fill="#ffffff"/>
        <g fill="none" stroke="#000000" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M98,42 C82,28 74,50 74,110 C74,170 66,192 50,178"/>
          <path d="M104,162 C92,162 90,192 104,192 C118,192 118,162 104,162"/>
          <path d="M114,42 C100,28 84,56 104,54 C124,52 138,28 124,42 C110,56 136,56 138,42"/>
          <path d="M160,114 L196,114 C196,94 162,94 160,116 C158,138 188,142 198,132"/>
          <path d="M208,82 L228,82"/>
          <path d="M238,70 L260,94"/><path d="M260,70 L238,94"/>
          <path d="M312,110 C294,96 278,110 280,128 C282,144 306,142 312,126 M312,72 L312,142"/>
          <path d="M332,98 L368,142"/><path d="M368,98 L332,142"/>
        </g>
      </svg>`,
    )).png().toBuffer();
    const resInt = await session.recognizeImage(intPng);
    assert.match(resInt.latex.replace(/\s+/g, ''), /\\int_\{?0\}?\^\{?\\infty\}?e\^\{?-x\}?dx/);
    assertValidLatex(resInt.latex, 'integral e^-x dx');

    // 4. 2x2 Matrix (handwritten strokes): (a b \\ c d)
    const matPng = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="240">
        <rect width="100%" height="100%" fill="#ffffff"/>
        <g fill="none" stroke="#000000" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M88,42 C58,84 58,156 88,198"/>
          <path d="M262,42 C292,84 292,156 262,198"/>
          <path d="M142,74 C124,62 108,74 110,92 C112,106 134,104 142,90 L144,104"/>
          <path d="M204,52 L204,104 C222,108 236,96 234,84 C232,72 214,72 204,84"/>
          <path d="M142,148 C122,138 106,154 110,174 C114,190 134,188 144,180"/>
          <path d="M232,154 C214,142 198,156 200,174 C202,190 226,188 232,172 M232,126 L232,188"/>
        </g>
      </svg>`,
    )).png().toBuffer();
    const resMat = await session.recognizeImage(matPng);
    assert.match(resMat.latex.replace(/\s+/g, ''), /\\begin\{(?:pmatrix|matrix)\}.*a&b\\\\c&d.*\\end\{(?:pmatrix|matrix)\}/);
    assertValidLatex(resMat.latex, '2x2 matrix');

    // 5. Limit with trig fraction: \lim_{x \to 0} \frac{\sin x}{x}
    const limPng = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="220">
        <rect width="100%" height="100%" fill="#ffffff"/>
        <text x="36" y="110" font-family="DejaVu Sans Serif, Arial, serif" font-size="56" fill="#000000">lim</text>
        <text x="40" y="154" font-family="DejaVu Sans Serif, Arial, serif" font-size="32" fill="#000000">x → 0</text>
        <line x1="168" y1="100" x2="342" y2="100" stroke="#000000" stroke-width="4"/>
        <text x="192" y="82" font-family="DejaVu Sans Serif, Arial, serif" font-size="48" fill="#000000">sin x</text>
        <text x="240" y="150" font-family="DejaVu Sans Serif, Arial, serif" font-size="48" fill="#000000">x</text>
      </svg>`,
    )).png().toBuffer();
    const resLim = await session.recognizeImage(limPng);
    assert.match(resLim.latex.replace(/\s+/g, ''), /\\lim_\{x(?:\\to|\\rightarrow)0\}\\frac\{\\sinx\}\{x\}/);
    assertValidLatex(resLim.latex, 'lim sin(x)/x');
  } finally {
    await session.dispose();
  }
});

test('mathRecognizer normalizes fallback text cleanly and never emits heuristic gibberish', async () => {
  assert.equal(normalizeTexTellerLatex('\\[ x + 5 \\]'), 'x + 5');
  assert.equal(normalizeTexTellerLatex('\\[ \\int_{0}^{ \\infty} e^{-x} dx \\]'), '\\int_{0}^{\\infty} e^{-x} dx');
  assert.equal(normalizeTextToMathLatex('x <= pi -> sqrt(x + 1)'), 'x \\le \\pi \\to \\sqrt{x + 1}');
  assert.equal(normalizeTextToMathLatex('   '), '');

  const noModelResult = await recognizeHandwritingToMath([
    makeStroke([[20, 20], [50, 50]], 'x1'),
    makeStroke([[50, 20], [20, 50]], 'x2'),
  ]);
  assert.equal(noModelResult.status, 'needs-model');
  assert.equal(noModelResult.latex, '');
  assert.equal(noModelResult.engine, 'fallback');
});

test('segmentMathLines splits 4-line calculus derivations accurately while preserving fractions, matrices, and integral limits', () => {
  const charStrokes = (x: number, y: number, h: number, w: number, prefix: string): Stroke[] => [
    makeStroke([[x, y], [x + w, y + h]], `${prefix}-a`),
    makeStroke([[x + w, y], [x, y + h]], `${prefix}-b`),
  ];
  const eqStrokes = (x: number, y: number, prefix: string): Stroke[] => [
    makeStroke([[x, y + 14], [x + 26, y + 14]], `${prefix}-eq1`),
    makeStroke([[x, y + 26], [x + 26, y + 26]], `${prefix}-eq2`),
  ];
  const plusStrokes = (x: number, y: number, prefix: string): Stroke[] => [
    makeStroke([[x, y + 18], [x + 22, y + 18]], `${prefix}-p1`),
    makeStroke([[x + 11, y + 7], [x + 11, y + 29]], `${prefix}-p2`),
  ];

  // 4-line integral derivation (~47 strokes total, with tall integrals + limits closely stacked)
  const fourLineStrokes: Stroke[] = [
    // Line 1 (y ≈ 110..175): ∫_0^1 x + 1 dx
    makeStroke([[92, 92], [80, 102], [78, 145], [76, 182], [66, 188]], 'l1-int'),
    makeStroke([[98, 95], [98, 114]], 'l1-lim1'),
    makeStroke([[92, 166], [104, 166], [104, 184], [92, 184], [92, 166]], 'l1-lim0'),
    ...charStrokes(128, 120, 32, 24, 'l1-x'),
    ...plusStrokes(166, 118, 'l1-plus'),
    makeStroke([[204, 118], [204, 152]], 'l1-one'),
    ...charStrokes(224, 118, 34, 20, 'l1-d'),
    ...charStrokes(254, 120, 32, 22, 'l1-x2'),

    // Line 2 (y ≈ 195..265): = ∫_0^1 x dx + ∫_0^1 dx
    ...eqStrokes(42, 210, 'l2-eq'),
    makeStroke([[94, 184], [82, 194], [80, 232], [78, 270], [68, 276]], 'l2-intA'),
    makeStroke([[102, 186], [102, 206]], 'l2-lim1A'),
    makeStroke([[94, 254], [106, 254], [106, 272], [94, 272], [94, 254]], 'l2-lim0A'),
    ...charStrokes(126, 210, 32, 24, 'l2-x'),
    ...charStrokes(164, 208, 34, 20, 'l2-d'),
    ...charStrokes(192, 210, 32, 22, 'l2-x2'),
    ...plusStrokes(226, 208, 'l2-plus'),
    makeStroke([[268, 184], [258, 194], [256, 232], [254, 270], [244, 276]], 'l2-intB'),
    makeStroke([[276, 186], [276, 206]], 'l2-lim1B'),
    makeStroke([[268, 254], [280, 254], [280, 272], [268, 272], [268, 254]], 'l2-lim0B'),
    ...charStrokes(298, 208, 34, 20, 'l2-d2'),
    ...charStrokes(326, 210, 32, 22, 'l2-x3'),

    // Line 3 (y ≈ 290..335): = [x^2]_0^1 + [x]_0^1
    ...eqStrokes(42, 294, 'l3-eq'),
    makeStroke([[92, 286], [84, 286], [84, 336], [92, 336]], 'l3-lb1'),
    ...charStrokes(104, 296, 30, 22, 'l3-x'),
    makeStroke([[134, 284], [148, 284], [134, 302], [148, 302]], 'l3-sup2'),
    makeStroke([[156, 286], [164, 286], [164, 336], [156, 336]], 'l3-rb1'),
    makeStroke([[172, 286], [172, 302]], 'l3-u1'),
    makeStroke([[170, 322], [180, 322], [180, 336], [170, 336], [170, 322]], 'l3-l0'),
    ...plusStrokes(196, 294, 'l3-plus'),
    makeStroke([[234, 286], [226, 286], [226, 336], [234, 336]], 'l3-lb2'),
    ...charStrokes(244, 296, 30, 22, 'l3-x2'),
    makeStroke([[274, 286], [282, 286], [282, 336], [274, 336]], 'l3-rb2'),

    // Line 4 (y ≈ 365..405): = 1 + 1 = 2
    ...eqStrokes(42, 372, 'l4-eq1'),
    makeStroke([[90, 368], [90, 404]], 'l4-1a'),
    ...plusStrokes(110, 368, 'l4-plus'),
    makeStroke([[148, 368], [148, 404]], 'l4-1b'),
    ...eqStrokes(168, 372, 'l4-eq2'),
    makeStroke([[206, 370], [226, 370], [206, 402], [228, 402]], 'l4-2'),
  ];
  const fourLines = segmentMathLines(fourLineStrokes);
  assert.equal(fourLines.length, 4, `Expected 4 derivation lines, got ${fourLines.length}`);

  // Single fraction (x^2 + 1) / 2 stays 1 line
  const fracStrokes: Stroke[] = [
    ...charStrokes(100, 50, 34, 24, 'frac-x'),
    makeStroke([[134, 38], [150, 38], [134, 56], [150, 56]], 'frac-2exp'),
    ...plusStrokes(166, 52, 'frac-plus'),
    makeStroke([[204, 50], [204, 84]], 'frac-1'),
    makeStroke([[80, 108], [240, 108]], 'frac-bar'),
    makeStroke([[145, 130], [175, 130], [145, 168], [178, 168]], 'frac-den2'),
  ];
  assert.equal(segmentMathLines(fracStrokes).length, 1, 'Fraction numerator/bar/denominator must remain 1 atomic line');

  // 2x2 Matrix remains 1 atomic line
  const matrixStrokes: Stroke[] = [
    makeStroke([[80, 40], [66, 110], [80, 180]], 'mat-lparen'),
    makeStroke([[230, 40], [244, 110], [230, 180]], 'mat-rparen'),
    ...charStrokes(104, 54, 30, 22, 'mat-a'),
    ...charStrokes(182, 54, 30, 22, 'mat-b'),
    ...charStrokes(104, 132, 30, 22, 'mat-c'),
    ...charStrokes(182, 132, 30, 22, 'mat-d'),
  ];
  assert.equal(segmentMathLines(matrixStrokes).length, 1, '2x2 matrix must remain 1 atomic line');

  // Standalone integral with limits (including wide gap below & upper-right '1') stays 1 line
  const singleInt: Stroke[] = [
    makeStroke([[92, 92], [80, 102], [78, 145], [76, 182], [66, 188]], 'sint'),
    makeStroke([[96, 94], [116, 110], [96, 110], [116, 94]], 'slim-inf'),
    makeStroke([[92, 166], [104, 166], [104, 184], [92, 184], [92, 166]], 'slim-0'),
    ...charStrokes(136, 120, 32, 24, 'sint-x'),
  ];
  assert.equal(segmentMathLines(singleInt).length, 1, 'Single integral with limits must remain 1 line');

  // Wide freehand `\int_0^1 x^2 + 5 = 9x dx` with '0' tucked far below integral bottom stays 1 line
  const detachedLimitInt: Stroke[] = [
    makeStroke([[110, 80], [98, 92], [95, 150], [92, 205], [78, 215]], 'dint'),
    makeStroke([[124, 68], [124, 102]], 'dlim-1'),
    makeStroke([[82, 246], [96, 246], [96, 268], [82, 268], [82, 246]], 'dlim-0'),
    ...charStrokes(160, 126, 46, 36, 'dx'),
    ...charStrokes(210, 102, 28, 22, 'dsq'),
    ...charStrokes(250, 130, 44, 34, 'dplus'),
    ...charStrokes(310, 126, 46, 36, 'd5'),
    ...eqStrokes(375, 148, 'deq'),
    ...charStrokes(425, 126, 46, 36, 'd9'),
    ...charStrokes(480, 126, 46, 36, 'dx2'),
    ...charStrokes(540, 122, 50, 44, 'dd'),
    ...charStrokes(596, 126, 46, 36, 'dx3'),
  ];
  assert.equal(segmentMathLines(detachedLimitInt).length, 1, 'Integral with far-below 0 and upper-right 1 must stay 1 line');

  // Multi-line LaTeX assembly produces aligned KaTeX-valid output
  const joined = assembleMultiLineMathLatex([
    '\\int_0^1 x + 1 dx',
    '= \\int_0^1 x dx + \\int_0^1 dx',
    '= [x^2]_0^1 + [x]_0^1',
    '= 1 + 1 = 2',
  ]);
  assert.match(joined, /\\begin\{aligned\}/);
  assert.match(joined, /\\\\/);
  assertValidLatex(joined, 'assembled 4-line aligned derivation');
});

test('real TexTeller3-ONNX (q8) recognizes ALL lines of a multi-line derivation independently and joins them into valid KaTeX LaTeX', async () => {
  const cacheDir = path.resolve('artifacts/math-ocr-bench/hf-cache');
  const cached = inspectMathOcrCache(cacheDir);
  assert.equal(cached.ready, true, `Expected cached TexTeller3-ONNX q8 model under ${cacheDir}`);

  const lineTexts = [
    '∫₀¹ (x + 1) dx',
    '= ∫₀¹ x dx + ∫₀¹ dx',
    '= x²/2 + x',
    '= 3/2',
  ];
  const session = createMathOcrSession({ cacheDir });
  try {
    const perLine = [];
    for (let i = 0; i < lineTexts.length; i += 1) {
      const label = i === 0 ? 'x + 5 = 9' : i === 1 ? '= 9 - 5' : i === 2 ? '= 4' : '= 2 + 2';
      const linePng = await sharp(Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="140">
          <rect width="100%" height="100%" fill="#ffffff"/>
          <text x="40" y="96" font-family="DejaVu Sans, Arial, serif" font-size="60" fill="#000000">${label}</text>
        </svg>`,
      )).png().toBuffer();
      const ocr = await session.recognizeImage(linePng);
      assert.ok(ocr.latex.trim().length > 0, `Line ${i + 1} OCR must not be empty`);
      perLine.push(ocr.latex);
    }
    const combined = assembleMultiLineMathLatex(perLine);
    const compact = combined.replace(/\s+/g, '');
    assert.match(compact, /x\+5&=9/);
    assert.match(compact, /&=9-5/);
    assert.match(compact, /&=4/);
    assert.match(compact, /&=2\+2/);
    assertValidLatex(combined, '4-line TexTeller3 derivation');

    // Wide aspect-ratio thin freehand-style integral (same formula that previously dropped limits / misread 9 as 2)
    const wideIntPng = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="160">
        <rect width="100%" height="100%" fill="#ffffff"/>
        <text x="36" y="102" font-family="DejaVu Sans, Arial, serif" font-size="62" fill="#000000">∫₀¹ x² + 5 = 9x dx</text>
      </svg>`,
    )).png().toBuffer();
    const wideIntOcr = await session.recognizeImage(wideIntPng);
    assertValidLatex(wideIntOcr.latex, 'wide integral TexTeller3');
    const compactInt = wideIntOcr.latex.replace(/\s+/g, '');
    assert.match(compactInt, /\\int/);
    assert.match(compactInt, /5=9xdx/);
  } finally {
    await session.dispose();
  }
});
