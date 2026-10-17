import React, { useEffect, useId, useState, useRef } from 'react';
import type { Editor, ChainedCommands } from '@tiptap/core';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { documentationBlockAt, documentationBlockConversions } from './notebookBlockCommands';
import { requestDocumentationLink } from './notebookLinkEditing';
import { requestDocumentationMarkdown } from './DocumentationMarkdownDialog';
import SlashMenuList from './SlashMenuList';
import { formattingColorValue } from './textFormatting';
import { ArrowLeft, ChevronRight, Type } from 'lucide-react';

export type DocumentationSection = 'text' | 'paragraph' | 'insert' | 'block' | 'table';
export function DocumentationTabs({ value, onChange, panelId, includeText = false, table = false }: {
  value: DocumentationSection; onChange: (value: DocumentationSection) => void; panelId: string; includeText?: boolean; table?: boolean;
}) {
  const tabs: Array<{ value: DocumentationSection; label: string }> = [
    ...(includeText ? [{ value: 'text' as const, label: 'Text' }, { value: 'paragraph' as const, label: 'Paragraph' }] : []), { value: 'insert', label: 'Insert' }, { value: 'block', label: 'Block' },
    ...(table ? [{ value: 'table' as const, label: 'Table' }] : []),
  ];
  return <div role="tablist" aria-label="Formatting sections" className="mx-2 mb-2 flex gap-1 border-b border-panvas-border-subtle pb-2">
    {tabs.map((tab, index) => <button key={tab.value} id={`${panelId}-${tab.value}`} type="button" role="tab" aria-selected={value === tab.value} aria-controls={panelId} tabIndex={value === tab.value ? 0 : -1}
      className={`min-h-8 flex-1 rounded-md px-2 text-xs font-medium focus-ring ${value === tab.value ? 'bg-panvas-bg-active text-panvas-text-primary' : 'text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary'}`}
      onMouseDown={event => event.preventDefault()} onClick={() => onChange(tab.value)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        onChange(tabs[next].value); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
      }}>{tab.label}</button>)}
  </div>;
}

/** Toolbar and right click share commands; only the requested section is shown. */
export function DocumentationControls({ editor, blockId, section: requestedSection, onDismiss }: { editor: Editor | null; blockId?: string; section?: DocumentationSection; onDismiss?: () => void }) {
  const [localSection, setLocalSection] = useState<DocumentationSection>('block');
  const section = requestedSection ?? localSection, panelId = useId();
  const [insertTool, setInsertTool] = useState<'equation' | 'reference' | null>(null);
  const [transformOpen, setTransformOpen] = useState(false), [query, setQuery] = useState('');
  const transformations = useRef<{ onKeyDown: (props: { event: React.KeyboardEvent }) => boolean }>(null);
  const [latex, setLatex] = useState('E=mc^2'), [targetPage, setTargetPage] = useState(''), [message, setMessage] = useState('');
  const [, refreshAfterCommand] = useState(0);
  const inTable = editor?.isActive('table') ?? false;
  useEffect(() => { setInsertTool(null); setTransformOpen(false); setQuery(''); }, [section]);
  useEffect(() => {
    const result = (event: Event) => setMessage((event as CustomEvent).detail?.message ?? '');
    document.addEventListener('panvas:document-command-result', result);
    return () => document.removeEventListener('panvas:document-command-result', result);
  }, []);
  const allPages = useWorkspaceStore(state => state.notebookPages);
  const notebookId = useWorkspaceStore(state => state.activeNotebookId), pageId = useWorkspaceStore(state => state.activePageId);
  const pages = allPages.filter(page => !page.deletedAt && page.notebookId === notebookId);
  const run = (command: (chain: ChainedCommands) => ChainedCommands) => {
    if (!editor || editor.isDestroyed || !editor.isEditable || !editor.view.dom.isConnected) return;
    const applied = command(editor.chain().focus()).run();
    editor.view.focus();
    if (applied) refreshAfterCommand(version => version + 1);
    setMessage(applied ? '' : 'This operation is unavailable for the selected block.');
  };
  const control = 'min-h-8 rounded-md px-2 py-1.5 text-left text-xs text-panvas-text-primary hover:bg-panvas-bg-hover focus-ring';
  const field = 'mt-1 h-8 w-full rounded-md border border-panvas-border-default bg-panvas-bg-secondary px-2 text-panvas-text-primary focus-ring';
  const button = (label: string, command: (chain: ChainedCommands) => ChainedCommands) => {
    const available = Boolean(editor && command(editor.can().chain()).run());
    return <button key={label} type="button" className={`${control} disabled:opacity-40 disabled:cursor-not-allowed`} disabled={!available} title={available ? undefined : `${label} is unavailable at this block boundary.`} onMouseDown={event => event.preventDefault()} onClick={() => run(command)}>{label}</button>;
  };
  const target = editor && !editor.isDestroyed ? documentationBlockAt({ tr: editor.state.tr }, blockId)?.node : null;
  const owner = editor && !editor.isDestroyed ? editor.view.dom.closest<HTMLElement>('[data-document-body],[data-text-object-id]') : null;
  return <div aria-label="Documentation blocks" data-document-editor={owner?.dataset.documentBody ?? owner?.dataset.textObjectId}>
    {!requestedSection && <DocumentationTabs value={section} onChange={setLocalSection} panelId={panelId} table={inTable} />}
    <div {...(!requestedSection ? { role: 'tabpanel', id: panelId, 'aria-labelledby': `${panelId}-${section}` } : {})} className="px-3 pb-2 text-xs text-panvas-text-secondary">
      {section === 'block' && (transformOpen ? <>
        <button type="button" className={`${control} mb-1 flex items-center gap-1 -ml-2`} onClick={() => { setTransformOpen(false); editor?.view.focus(); }}><ArrowLeft size={12} /> Block actions</button>
        <input autoFocus type="search" aria-label="Search block types" placeholder="Search block types…" className={`${field} mb-1`} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (transformations.current?.onKeyDown({ event })) { event.preventDefault(); event.stopPropagation(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setTransformOpen(false); editor?.view.focus(); }
        }} />
        <SlashMenuList ref={transformations} embedded title="Turn into" items={documentationBlockConversions.filter(item => item.label.toLowerCase().includes(query.toLowerCase())).map(item => ({ ...item, title: item.label, icon: <Type size={14} />,
          disabled: !editor?.can().turnDocumentationBlockInto(item.type, { ...item.options, id: blockId }),
          disabledReason: `This block cannot become ${item.label.toLowerCase()} here while preserving its content.` }))}
          command={(item: (typeof documentationBlockConversions)[number]) => { run(chain => chain.turnDocumentationBlockInto(item.type, { ...item.options, id: blockId })); setTransformOpen(false); onDismiss?.(); }} />
      </> : <>
        <button type="button" className={`${control} mb-2 flex w-full items-center justify-between border border-panvas-border-default`} onMouseDown={event => event.preventDefault()} onClick={() => setTransformOpen(true)}><span>Turn into…</span><ChevronRight size={13} /></button>
        <div className="grid grid-cols-2 gap-2 border-b border-panvas-border-subtle pb-2">
          <label className="flex items-center justify-between gap-1">Text color<input type="color" aria-label="Block text color" value={formattingColorValue(target?.attrs.blockColor, '#202020')} onChange={event => run(chain => chain.setDocumentationBlockColor(event.target.value, blockId))} className="h-6 w-6 cursor-pointer rounded border border-panvas-border-default focus-ring" /></label>
          <label className="flex items-center justify-between gap-1">Background<input type="color" aria-label="Block background color" value={formattingColorValue(target?.attrs.blockBackground, '#ffffff')} onChange={event => run(chain => chain.setDocumentationBlockBackground(event.target.value, blockId))} className="h-6 w-6 cursor-pointer rounded border border-panvas-border-default focus-ring" /></label>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-1">
          {button('Collapse / expand', chain => chain.toggleDocumentationCollapse(blockId))}{button('Duplicate block', chain => chain.duplicateDocumentationBlock(blockId))}
          {button('Move block up', chain => chain.moveDocumentationBlock('up', blockId))}{button('Move block down', chain => chain.moveDocumentationBlock('down', blockId))}
          {button('Copy link to block', chain => chain.ensureDocumentationBlockIds().copyDocumentationBlockLink(pageId ?? '', blockId))}
          <button type="button" className={control} onMouseDown={event => event.preventDefault()} onClick={() => { requestDocumentationLink(editor); onDismiss?.(); }}>Edit link (Ctrl+K)</button>
          {button('Reset block colors', chain => chain.setDocumentationBlockColor(null, blockId).setDocumentationBlockBackground(null, blockId))}{button('Delete block', chain => chain.deleteDocumentationBlock(blockId))}
        </div>
      </>)}
      {section === 'insert' && <>
        {insertTool && <button type="button" className={`${control} mb-2 -ml-2`} onMouseDown={event => event.preventDefault()} onClick={() => setInsertTool(null)}>← Insert tools</button>}
        {!insertTool && <>
          <div className="grid grid-cols-2 gap-1 border-b border-panvas-border-subtle pb-2">
            {button('Insert table', chain => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}{button('Insert callout', chain => chain.insertDocumentationBlock('callout'))}
            {button('Insert toggle', chain => chain.insertDocumentationBlock('details'))}{button('Insert divider', chain => chain.setHorizontalRule())}
            {button('Insert contents', chain => chain.insertDocumentationBlock('tableOfContents'))}{button('Page break', chain => chain.insertDocumentPageBreak())}
          </div>
          <div className="mt-1 grid gap-1">
            <button type="button" className={control} onMouseDown={event => event.preventDefault()} onClick={() => { setInsertTool('equation'); if (editor?.isActive('blockMath')) setLatex(editor.getAttributes('blockMath').latex); else if (editor?.isActive('inlineMath')) setLatex(editor.getAttributes('inlineMath').latex); }}>Equation…</button>
            <button type="button" className={control} onMouseDown={event => event.preventDefault()} onClick={() => setInsertTool('reference')}>Page reference…</button>
            <button type="button" className={control} onMouseDown={event => event.preventDefault()} onClick={() => { requestDocumentationMarkdown(editor); onDismiss?.(); }}>Paste Markdown…</button>
          </div>
        </>}
        {insertTool === 'equation' && <>
          <label className="block">LaTeX source<input aria-label="LaTeX source" className={field} value={latex} onChange={event => setLatex(event.target.value)} /></label>
          <div className="mt-2 grid grid-cols-2 gap-1">{button('Block equation', chain => editor?.isActive('blockMath') ? chain.updateBlockMath({ latex }) : chain.insertBlockMath({ latex }))}{button('Inline equation', chain => editor?.isActive('inlineMath') ? chain.updateInlineMath({ latex }) : chain.insertInlineMath({ latex }))}</div>
          <div className="mt-2 border-t border-panvas-border-subtle pt-2">
            <button type="button" className={control} onMouseDown={event => event.preventDefault()} onClick={() => {
              if (!editor || editor.isDestroyed || !editor.isEditable) return;
              const applied = editor.commands.convertExistingNotebookMath();
              setMessage(applied ? 'Converted existing LaTeX. Undo restores the original text.' : 'No supported LaTeX delimiters found in this text.');
            }}>Convert existing LaTeX</button>
            <p className="mt-1 leading-relaxed">Convert supported delimiters throughout this text. Code and plain currency stay literal. You can undo this action.</p>
          </div>
        </>}
        {insertTool === 'reference' && <>
          <label className="block">Internal page link<select aria-label="Internal page link" className={field} value={targetPage} onChange={event => setTargetPage(event.target.value)}><option value="">Choose a page…</option>{pages.map(page => <option key={page.id} value={page.id}>{page.title}</option>)}</select></label>
          <div className="mt-2">{button('Insert page link', chain => chain.insertDocumentationReference({ targetPageId: targetPage, label: pages.find(page => page.id === targetPage)?.title ?? 'Page' }))}</div>
        </>}
      </>}
      {section === 'table' && (inTable ? <div className="grid grid-cols-2 gap-1">
        {button('Add row', chain => chain.addRowAfter())}{button('Add column', chain => chain.addColumnAfter())}{button('Merge cells', chain => chain.mergeCells())}{button('Split cell', chain => chain.splitCell())}{button('Delete row', chain => chain.deleteRow())}{button('Delete column', chain => chain.deleteColumn())}
      </div> : <p className="py-2">Select a table to edit its rows and columns.</p>)}
      {message && <p role="status" className="mt-2 text-xs leading-relaxed">{message}</p>}
    </div>
  </div>;
}
