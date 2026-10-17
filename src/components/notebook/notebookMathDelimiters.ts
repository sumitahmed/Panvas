/** Clipboard recognition only; the existing mathematics nodes retain and render the source. */
export interface NotebookMathMatch { from: number; to: number; latex: string; block: boolean }
const escaped = (source: string, at: number) => {
  let count = 0; while (at > 0 && source[--at] === '\\') count++;
  return count % 2 === 1;
};

export function notebookMathMatches(source: string): NotebookMathMatch[] {
  const matches: NotebookMathMatch[] = [];
  const code: Array<{from: number; to: number}> = [];
  for (let at = 0; at < source.length; at++) {
    if (source[at] !== '`' || escaped(source, at)) continue;
    let length = 1; while (source[at + length] === '`') length++;
    const end = source.indexOf('`'.repeat(length), at + length), to = end < 0 ? source.length : end + length;
    code.push({from: at, to}); at = to - 1;
  }
  for (let at = 0; at < source.length; at++) {
    // Literal Markdown code is protected even in a plain-text clipboard representation.
    const literal = code.find(range => range.from <= at && at < range.to);
    if (literal) { at = literal.to - 1; continue; }
    if (escaped(source, at)) continue;
    const open = source.startsWith('\\[', at) ? '\\[' : source.startsWith('\\(', at) ? '\\('
      : source.startsWith('$$', at) ? '$$' : source[at] === '$' ? '$' : '';
    if (!open) continue;
    const close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open;
    const block = open === '\\[' || open === '$$';
    let end = source.indexOf(close, at + open.length);
    while (end >= 0 && escaped(source, end)) end = source.indexOf(close, end + close.length);
    if (end < 0) continue;
    const latex = source.slice(at + open.length, end), to = end + close.length;
    if (!latex.trim() || latex.includes('\ufffc') || latex.includes(open) || code.some(range => range.from < to && range.to > at) || !block && /[\r\n]/.test(latex)) continue;
    if (open === '$' && (/^\s|\s$/.test(latex) || /\d/.test(source[to] ?? '') || /^\s*\d/.test(latex) && !/[=+*/^_\\{}]/.test(latex))) continue;
    // Display delimiters must occupy a whole line, rather than swallowing adjacent prose.
    if (block && (source.slice(source.lastIndexOf('\n', at - 1) + 1, at).trim()
      || source.slice(to, source.indexOf('\n', to) < 0 ? source.length : source.indexOf('\n', to)).trim())) { at = to - 1; continue; }
    matches.push({ from: at, to, latex, block }); at = to - 1;
  }
  return matches;
}
