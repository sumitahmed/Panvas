import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { createLowlight } from 'lowlight';

type Lowlight = Pick<ReturnType<typeof createLowlight>, 'highlight' | 'registered'>;
type Block = { node: ProseMirrorNode; pos: number };
type HighlightState = { decorations: DecorationSet; blocks: Block[] };

/** Existing Lowlight grammar and PM decorations; retain unchanged blocks across transactions. */
export function notebookCodeHighlight(name: string, lowlight: Lowlight, defaultLanguage?: string | null): Plugin<HighlightState> {
  const language = (node: ProseMirrorNode) => node.attrs.language || defaultLanguage || 'plaintext';
  const decorate = ({ node, pos }: Block): Decoration[] => {
    const source = language(node), result = lowlight.highlight(lowlight.registered(source) ? source : 'plaintext', node.textContent);
    const decorations: Decoration[] = []; let at = pos + 1;
    type Token = typeof result.children[number];
    const visit = (token: Token, inherited: string[] = []) => {
      if (token.type === 'element') {
        const own = token.properties.className;
        const classes = inherited.concat(Array.isArray(own) ? own.map(String) : typeof own === 'string' ? own.split(' ') : []);
        token.children.forEach(child => visit(child, classes));
      } else if (token.type === 'text') {
        const end = at + token.value.length;
        if (end > at && inherited.length) decorations.push(Decoration.inline(at, end, { class: inherited.join(' ') }));
        at = end;
      }
    };
    result.children.forEach(token => visit(token)); return decorations;
  };
  const build = (doc: ProseMirrorNode, previous?: HighlightState, transaction?: Transaction): HighlightState => {
    const blocks: Block[] = [];
    doc.descendants((node, pos) => { if (node.type.name === name) { blocks.push({ node, pos }); return false; } return true; });
    if (!previous || !transaction) return { blocks, decorations: DecorationSet.create(doc, blocks.flatMap(decorate)) };
    let decorations = previous.decorations.map(transaction.mapping, doc);
    const previousPositions = new Map(previous.blocks.map(block => [transaction.mapping.map(block.pos, 1), block]));
    const positions = new Set(blocks.map(block => block.pos));
    // Converting/deleting a code block must also remove its mapped syntax classes.
    for (const [mapped, block] of previousPositions) if (!positions.has(mapped)) {
      decorations = decorations.remove(decorations.find(transaction.mapping.map(block.pos + 1, -1), transaction.mapping.map(block.pos + block.node.nodeSize - 1, 1)));
    }
    for (const block of blocks) {
      const old = previousPositions.get(block.pos);
      const retained = old && transaction.mapping.map(old.pos + 1, 1) === block.pos + 1
        && transaction.mapping.map(old.pos + old.node.nodeSize - 1, -1) === block.pos + block.node.nodeSize - 1;
      if (old && retained && (old.node === block.node || old.node.content === block.node.content && language(old.node) === language(block.node))) continue;
      decorations = decorations.remove(decorations.find(block.pos + 1, block.pos + block.node.nodeSize - 1));
      decorations = decorations.add(doc, decorate(block));
    }
    return { blocks, decorations };
  };
  const key = new PluginKey<HighlightState>('notebookCodeHighlight');
  return new Plugin({ key, state: {
    init: (_config, state) => build(state.doc),
    apply: (transaction, previous) => transaction.docChanged ? build(transaction.doc, previous, transaction) : previous,
  }, props: { decorations: state => key.getState(state)?.decorations } });
}
