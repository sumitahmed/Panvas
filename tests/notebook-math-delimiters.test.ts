import test from 'node:test';
import assert from 'node:assert/strict';
import { notebookMathMatches } from '../src/components/notebook/notebookMathDelimiters.ts';

test('clipboard math recognizes the exact supplied expressions without changing their sources', () => {
  const source = String.raw`Inline \(n\).
\[ T(n)=3n^2+5n+10 \]
\[ \boxed{T(n)=O(n^2)} \]`;
  assert.deepEqual(notebookMathMatches(source).map(({latex,block})=>({latex,block})), [
    {latex:'n',block:false}, {latex:' T(n)=3n^2+5n+10 ',block:true}, {latex:String.raw` \boxed{T(n)=O(n^2)} `,block:true},
  ]);
});
test('currency and literal dollars remain text while explicit algebra is recognized', () => {
  assert.deepEqual(notebookMathMatches('Costs $5 and $10; $x^2$ and $2+2$.' ).map(match=>match.latex), ['x^2','2+2']);
  assert.equal(notebookMathMatches('An ordinary $ sign and a price of $20').length, 0);
});
test('escaped delimiters and inline or fenced code remain literal', () => {
  for (const source of [String.raw`\\(n\\)`, String.raw`\$x\$`, '`\\(n\\)`', '```latex\n\\[x^2\\]\n```']) assert.deepEqual(notebookMathMatches(source), []);
  const source = String.raw`Costs $5 and $10. Ordinary $ sign. Unmatched \(n. Inline code `+'`'+String.raw`\(x\) $y$`+'`';
  assert.deepEqual(notebookMathMatches(source), []);
});
test('multiline display math is recognized only on independent lines', () => {
  assert.equal(notebookMathMatches('Before\n$$\nx+y\n$$\nAfter')[0].latex, '\nx+y\n');
  assert.deepEqual(notebookMathMatches('Before $$ x $$ after'), []);
});
