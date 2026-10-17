import { Node } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    documentPageBreak: { insertDocumentPageBreak: () => ReturnType };
  }
}

export const DocumentPageBreak = Node.create({
  name: 'documentPageBreak', group: 'block', atom: true, selectable: true,
  parseHTML: () => [{ tag: 'div[data-type="panvas-page-break"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { ...HTMLAttributes, 'data-type': 'panvas-page-break', class: 'panvas-document-page-break' }],
  addCommands() {
    return { insertDocumentPageBreak: () => ({ tr, commands, dispatch }) => {
      // Cell pagination follows source table tracks. A deliberate break belongs
      // between document blocks, never inside one of those tracks.
      for (let depth = tr.selection.$from.depth; depth > 0; depth--) {
        if (tr.selection.$from.node(depth).type.name === 'table') return false;
      }
      if (dispatch) closeHistory(tr);
      return commands.insertContent([{ type: this.name }, { type: 'paragraph' }]);
    } };
  },
});
