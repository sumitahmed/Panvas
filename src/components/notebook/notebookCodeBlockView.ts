import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { getRenderedAttributes, mergeAttributes } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { copyNotebookText } from './notebookClipboard';
import { notebookCodeHighlight } from './notebookCodeHighlight';

const languageNames: Record<string, string> = {
  plaintext: 'Plain Text', java: 'Java', javascript: 'JavaScript', typescript: 'TypeScript',
  python: 'Python', c: 'C', cpp: 'C++', csharp: 'C#', xml: 'HTML / XML', css: 'CSS', json: 'JSON', sql: 'SQL',
};
export const notebookCodeLanguageLabel = (language: string) => Object.prototype.hasOwnProperty.call(languageNames, language) ? languageNames[language] : language;
const languageLabel = notebookCodeLanguageLabel;

function codeIcon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
  for (const value of paths) { const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', value); svg.append(path); }
  return svg;
}

/** Text and author options live in the existing code node; controls are view state. */
export const NotebookCodeBlock = CodeBlockLowlight.extend({
  addProseMirrorPlugins() {
    // In the pinned Tiptap 3.30.2 extension the final parent plugin is Lowlight's
    // eager whole-document decorator. Keep the base code-paste plugin unchanged.
    const inherited = this.parent?.() ?? [];
    return [...inherited.slice(0, -1), notebookCodeHighlight(this.name, this.options.lowlight, this.options.defaultLanguage)];
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      wrap: { default: false, parseHTML: element => element.getAttribute('data-code-wrap') === 'true', renderHTML: attrs => ({ 'data-code-wrap': String(Boolean(attrs.wrap)) }) },
      caption: { default: '', parseHTML: element => element.getAttribute('data-code-caption') ?? '', renderHTML: attrs => attrs.caption ? { 'data-code-caption': attrs.caption } : {} },
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['pre', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), ['code', { class: `language-${node.attrs.language ?? 'plaintext'}` }, 0]];
  },
  addNodeView() {
    return ({ editor, node, getPos, HTMLAttributes, view }) => {
      const dom = document.createElement('div'); dom.className = 'panvas-code-block';
      const controls = document.createElement('div'); controls.className = 'panvas-code-controls'; controls.contentEditable = 'false';
      const picker = document.createElement('details'); picker.className = 'panvas-code-language';
      const trigger = document.createElement('summary'); trigger.setAttribute('aria-label', 'Code language');
      const languageText = document.createElement('span'); trigger.append(languageText, codeIcon(['m7 10 5 5 5-5']));
      const actions = document.createElement('div'); actions.className = 'panvas-code-actions';
      const popup = document.createElement('div'); popup.className = 'panvas-overlay panvas-code-language-popup'; popup.hidden = true;
      popup.id = 'code-languages-' + crypto.randomUUID(); trigger.setAttribute('aria-controls', popup.id); trigger.setAttribute('aria-haspopup', 'listbox');
      const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search languages'; search.setAttribute('aria-label', 'Search code languages');
      const choices = document.createElement('div'); choices.setAttribute('role', 'listbox'); choices.setAttribute('aria-label', 'Code languages');
      popup.append(search, choices); picker.append(trigger); controls.append(picker, actions);
      // Portal outside the paper mask so choices remain usable near a sheet seam.
      document.body.append(popup);
      const button = (label: string, text: string) => { const element = document.createElement('button'); element.type = 'button'; element.textContent = text; element.setAttribute('aria-label', label); element.title = label; element.addEventListener('mousedown', event => event.preventDefault()); actions.append(element); return element; };
      const wrap = button('Wrap lines', 'Wrap'), copy = button('Copy code', 'Copy'), captionToggle = button('Caption', '');
      copy.className = 'panvas-code-copy';
      captionToggle.append(codeIcon(['M4 5h16M4 10h16M4 15h10M19 14v6m-3-3h6'])); captionToggle.title = 'Add or edit caption';
      const feedback = document.createElement('span'); feedback.className = 'sr-only'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); controls.append(feedback);
      const pre = document.createElement('pre'); pre.className = String(HTMLAttributes.class ?? '');
      const code = document.createElement('code'); pre.append(code);
      const caption = document.createElement('input'); caption.className = 'panvas-code-caption'; caption.contentEditable = 'false'; caption.placeholder = 'Add a caption'; caption.setAttribute('aria-label', 'Code caption');
      dom.append(controls, pre, caption);
      let current = node, captionVisible = Boolean(node.attrs.caption), copyTimer: ReturnType<typeof setTimeout> | undefined;
      let previousAttributes = new Set<string>();
      const edit = (options: { language?: string; wrap?: boolean; caption?: string }) => {
        const pos = getPos();
        if (typeof pos !== 'number' || !editor.isEditable) return;
        if (options.language !== undefined) {
          const chain = editor.chain();
          if (editor.state.selection.from < pos + 1 || editor.state.selection.to > pos + current.nodeSize - 1) chain.setTextSelection(pos + 1);
          chain.setDocumentationCodeOptions(options, current.attrs.blockId ?? undefined).run();
        }
        else if (current.attrs.blockId) editor.commands.setDocumentationCodeOptions(options, current.attrs.blockId);
        else editor.chain().setTextSelection(pos + 1).setDocumentationCodeOptions(options).run();
      };
      const renderChoices = () => {
        const languages = [...new Set(['plaintext', ...this.options.lowlight.listLanguages(), String(current.attrs.language ?? 'plaintext')])];
        choices.replaceChildren(...languages.filter(value => `${languageLabel(value)} ${value}`.toLowerCase().includes(search.value.toLowerCase())).map(value => {
          const option = document.createElement('button'); option.type = 'button'; option.textContent = languageLabel(value);
          option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(value === current.attrs.language));
          option.disabled = !editor.isEditable;
          option.addEventListener('click', () => { closePicker(); edit({ language: value }); editor.view.focus(); });
          return option;
        }));
      };
      const update = () => {
        const attributes = getRenderedAttributes(current, editor.extensionManager.attributes);
        for (const attribute of previousAttributes) if (!(attribute in attributes)) (attribute === 'style' || attribute.startsWith('data-code-') ? pre : dom).removeAttribute(attribute);
        for (const [attribute, value] of Object.entries(attributes)) {
          if (attribute === 'style' || attribute.startsWith('data-code-')) pre.setAttribute(attribute, String(value ?? ''));
          else if (attribute !== 'class' && value != null) dom.setAttribute(attribute, String(value));
        }
        previousAttributes = new Set(Object.keys(attributes).filter(attribute => attribute !== 'class'));
        const language = String(current.attrs.language ?? 'plaintext');
        languageText.textContent = languageLabel(language); trigger.title = languageLabel(language); trigger.setAttribute('aria-disabled', String(!editor.isEditable)); trigger.setAttribute('aria-expanded', String(picker.open));
        code.className = `language-${language}`;
        wrap.setAttribute('aria-pressed', String(Boolean(current.attrs.wrap)));
        wrap.textContent = current.attrs.wrap ? 'Wrap On' : 'Wrap Off';
        wrap.title = current.attrs.wrap ? 'Wrap is on. Click to scroll long lines horizontally.' : 'Wrap is off. Click to wrap long lines.';
        wrap.disabled = captionToggle.disabled = caption.disabled = !editor.isEditable;
        if (!editor.isEditable) closePicker();
        captionVisible ||= Boolean(current.attrs.caption);
        caption.hidden = !captionVisible;
        if (document.activeElement !== caption) caption.value = String(current.attrs.caption ?? '');
        if (picker.open) renderChoices(); else choices.replaceChildren();
      };
      search.addEventListener('input', renderChoices);
      trigger.addEventListener('click', () => { if (!picker.open) search.value = ''; });
      const positionPopup = () => {
        const rect = trigger.getBoundingClientRect(), width = Math.min(260, window.innerWidth - 24);
        const below = window.innerHeight - rect.bottom - 18, above = rect.top - 18, downward = below >= 180 || below >= above;
        choices.style.maxHeight = `${Math.max(64, Math.min(248, (downward ? below : above) - 56))}px`;
        popup.style.width = `${width}px`;
        popup.style.left = `${Math.max(12, Math.min(rect.left - 4, window.innerWidth - width - 12))}px`;
        popup.style.top = `${Math.max(12, downward ? rect.bottom + 6 : rect.top - popup.offsetHeight - 6)}px`;
      };
      let listening = false;
      const outside = (event: PointerEvent) => { if (!picker.contains(event.target as Node) && !popup.contains(event.target as Node)) closePicker(); };
      const closeOther = (event: Event) => { if ((event as CustomEvent).detail !== popup.id) closePicker(); };
      const reposition = () => { if (picker.open) positionPopup(); };
      const closePicker = () => {
        picker.open = false; popup.hidden = true; trigger.setAttribute('aria-expanded', 'false'); choices.replaceChildren();
        if (listening) { document.removeEventListener('pointerdown', outside); document.removeEventListener('panvas:documentation-menu', closeOther); window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); listening = false; }
      };
      picker.addEventListener('toggle', () => {
        popup.hidden = !picker.open;
        if (picker.open && editor.isEditable) {
          document.dispatchEvent(new CustomEvent('panvas:documentation-menu', { detail: popup.id }));
          popup.dataset.documentEditor = view.dom.closest<HTMLElement>('[data-document-body]')?.dataset.documentBody
            ?? view.dom.closest<HTMLElement>('[data-text-object-id]')?.dataset.textObjectId ?? '';
          trigger.setAttribute('aria-expanded', 'true'); renderChoices(); positionPopup(); search.focus();
          if (!listening) { document.addEventListener('pointerdown', outside); document.addEventListener('panvas:documentation-menu', closeOther); window.addEventListener('scroll', reposition, true); window.addEventListener('resize', reposition); listening = true; }
        } else closePicker();
      });
      const pickerKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); closePicker(); editor.view.focus(); }
        if (event.key === 'ArrowDown' && event.target === search) { event.preventDefault(); choices.querySelector<HTMLButtonElement>('button')?.focus(); }
        if (event.key === 'Enter' && event.target === search) { event.preventDefault(); choices.querySelector<HTMLButtonElement>('button')?.click(); }
        if (event.target instanceof HTMLButtonElement && choices.contains(event.target) && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'ArrowDown' ? event.target.nextElementSibling : event.target.previousElementSibling;
          if (next instanceof HTMLButtonElement) next.focus(); else search.focus();
        }
      };
      picker.addEventListener('keydown', pickerKey); popup.addEventListener('keydown', pickerKey);
      popup.addEventListener('focusout', event => { if (event.relatedTarget instanceof Node && !popup.contains(event.relatedTarget) && !picker.contains(event.relatedTarget)) closePicker(); });
      copy.addEventListener('click', async () => {
        try { await copyNotebookText(current.textContent); copy.textContent = 'Copied'; copy.setAttribute('aria-label', 'Copied'); feedback.textContent = 'Code copied.'; }
        catch { copy.textContent = 'Retry'; copy.setAttribute('aria-label', 'Could not copy'); feedback.textContent = 'Could not copy code.'; }
        clearTimeout(copyTimer); copyTimer = setTimeout(() => { copy.textContent = 'Copy'; copy.setAttribute('aria-label', 'Copy code'); }, 1800);
      });
      wrap.addEventListener('click', () => { edit({ wrap: !current.attrs.wrap }); editor.view.focus(); });
      captionToggle.addEventListener('click', () => { captionVisible = true; caption.hidden = false; caption.focus(); });
      caption.addEventListener('input', () => edit({ caption: caption.value }));
      caption.addEventListener('focus', () => { if (editor.isEditable) editor.view.dispatch(closeHistory(editor.state.tr)); });
      caption.addEventListener('blur', () => { if (!caption.value.trim()) { captionVisible = false; caption.hidden = true; } });
      caption.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); editor.view.focus(); }
        if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
          event.preventDefault(); event.stopPropagation();
          if (event.shiftKey || event.key.toLowerCase() === 'y') editor.commands.redo(); else editor.commands.undo();
          caption.value = String(current.attrs.caption ?? '');
        }
      });
      update();
      const editability = new MutationObserver(update);
      editability.observe(view.dom, { attributes: true, attributeFilter: ['contenteditable'] });
      return {
        dom, contentDOM: code,
        update: next => {
          if (next.type !== current.type) return false;
          const changed = next.attrs !== current.attrs;
          current = next; // Copy must always read the latest source, including ordinary typing.
          if (changed) update(); // Pagination/decorations do not change the code controls.
          return true;
        },
        stopEvent: event => controls.contains(event.target as Node) || event.target === caption,
        ignoreMutation: mutation => controls.contains(mutation.target) || mutation.target === caption || mutation.type === 'attributes' && (mutation.target === code || mutation.target === pre || mutation.target === dom),
        destroy: () => { editability.disconnect(); closePicker(); popup.remove(); clearTimeout(copyTimer); },
      };
    };
  },
});
