import { ReactRenderer } from '@tiptap/react';
import { exitSuggestion } from '@tiptap/suggestion';
import type { ChainedCommands, Editor } from '@tiptap/core';
import tippy from 'tippy.js';
import SlashMenuList from './SlashMenuList';
import { Type, StickyNote } from 'lucide-react';
import React from 'react';
import { documentationBlockConversions } from './notebookBlockCommands';

type CommandTarget = { editor: Editor; range: { from: number; to: number } };
const titles: Record<string, string> = { bulletList: 'Bullet List', orderedList: 'Numbered List', taskList: 'To-do List', codeBlock: 'Code Block', details: 'Toggle Section', blockMath: 'Equation' };
export const getSuggestionItems = ({ query }: { query: string }) => {
  const conversions = documentationBlockConversions.map(item => ({
    value: item.value, title: titles[item.value] ?? item.label, keywords: item.label,
    icon: React.createElement(Type, { size: 14 }),
    command: ({ editor, range }: CommandTarget) => {
      const chain = editor.chain().focus().deleteRange(range);
      const command = item.type === 'paragraph' ? chain.setParagraph() : item.type === 'heading' ? chain.setHeading({ level: item.options!.level as 1 | 2 | 3 | 4 | 5 | 6 })
        : item.type === 'bulletList' ? chain.toggleBulletList() : item.type === 'orderedList' ? chain.toggleOrderedList()
        : item.type === 'taskList' ? chain.toggleTaskList() : item.type === 'blockquote' ? chain.toggleBlockquote()
        : item.type === 'codeBlock' ? chain.setCodeBlock() : item.type === 'blockMath' ? chain.insertBlockMath({ latex: 'E=mc^2' })
        : item.type === 'callout' ? chain.insertDocumentationBlock('callout') : item.type === 'details' && !item.options?.headingLevel ? chain.insertDocumentationBlock('details') : chain.turnDocumentationBlockInto(item.type, item.options);
      command.run(); editor.view.focus();
    },
  }));
  const insertions = [
    { title: 'Table', command: (chain: ChainedCommands) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
    { title: 'Divider', command: (chain: ChainedCommands) => chain.setHorizontalRule() },
    { title: 'Page Break', command: (chain: ChainedCommands) => chain.insertDocumentPageBreak() },
  ].map(item => ({ title: item.title, keywords: item.title, icon: React.createElement(Type, { size: 14 }), command: ({ editor, range }: CommandTarget) => { item.command(editor.chain().focus().deleteRange(range)).run(); editor.view.focus(); } }));
  return [...conversions, ...insertions, {
    title: 'Sticky Note', keywords: 'Sticky Note', icon: React.createElement(StickyNote, { size: 14 }),
    command: ({ editor, range }: CommandTarget) => { editor.chain().focus().deleteRange(range).run(); document.dispatchEvent(new CustomEvent('panvas:create-sticky-note')); },
  }].filter(item => `${item.title} ${item.keywords}`.toLowerCase().includes(query.toLowerCase().trim()));
};

export default {
  items: getSuggestionItems,
  render: () => {
    let component: ReactRenderer<any> | undefined, popup: ReturnType<typeof tippy> | undefined;
    let owner = '', closeOther: ((event: Event) => void) | undefined;
    return {
      onStart: (props: any) => {
        component = new ReactRenderer(SlashMenuList, { props, editor: props.editor });
        if (!props.clientRect) return;
        owner = `slash-${crypto.randomUUID()}`;
        document.dispatchEvent(new CustomEvent('panvas:documentation-menu', { detail: owner }));
        closeOther = (event: Event) => { if ((event as CustomEvent).detail !== owner) exitSuggestion(props.editor.view); };
        document.addEventListener('panvas:documentation-menu', closeOther);
        popup = tippy('body', { getReferenceClientRect: props.clientRect, appendTo: () => document.body, content: component.element,
          showOnCreate: true, interactive: true, trigger: 'manual', placement: 'bottom-start', animation: false, duration: 0,
          arrow: false, theme: 'panvas-blocks', maxWidth: 264, offset: [0, 6], zIndex: 60 });
      },
      onUpdate(props: any) { component?.updateProps(props); if (props.clientRect) (popup as any)?.[0]?.setProps({ getReferenceClientRect: props.clientRect }); },
      onKeyDown(props: any) { if (props.event.key === 'Escape') { exitSuggestion(props.view); return true; } return component?.ref?.onKeyDown(props) ?? false; },
      onExit() { if (closeOther) document.removeEventListener('panvas:documentation-menu', closeOther); (popup as any)?.[0]?.destroy(); component?.destroy(); popup = undefined; component = undefined; },
    };
  },
};
