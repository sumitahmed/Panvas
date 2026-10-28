import assert from 'node:assert/strict';
import test from 'node:test';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import Placeholder from '@tiptap/extension-placeholder';
import { Extension } from '@tiptap/core';
import { history } from '@tiptap/pm/history';
import { FontSize } from '../src/components/notebook/FontSizeExtension.ts';
import {
  captureFormattingSelection,
  resolveFormattingEditor,
  runFormattingCommand,
} from '../src/components/notebook/textFormatting.ts';
import { NotebookEngine } from '../src/components/notebook/engine/NotebookEngine.ts';
import { derivePagePropertyOverrides, resolvePageProperties, getNotebookPageDefaults } from '../src/lib/pageProperties.ts';
import { DEFAULT_PAGE_PROPERTY_SET, type Notebook, type NotebookPage } from '../src/types/notebook.ts';

function createTemplateFieldEditor(text = '8 September 2026', placeholder = 'DATE'): Editor {
  const editor = new Editor({
    element: null,
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
        link: false,
        underline: false,
      }),
      Underline,
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      Placeholder.configure({
        placeholder,
        emptyEditorClass: 'is-editor-empty',
        showOnlyWhenEditable: false,
      }),
      Extension.create({
        name: 'templateFieldEnterKey',
        addKeyboardShortcuts() {
          return {
            Enter: () => {
              this.editor.commands.blur();
              return true;
            },
          };
        },
      }),
    ],
    content: {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: text ? [{ type: 'text', text }] : [],
      }],
    },
  });

  // Headless Node environment adapter matching panvas-interactions.test.ts
  Object.defineProperty(editor, 'isDestroyed', { configurable: true, get: () => false });
  const stateWithHistory = editor.state.reconfigure({ plugins: [history()] });
  editor.view.updateState(stateWithHistory);
  return editor;
}

function disposeEditor(editor: Editor): void {
  delete (editor as any).isDestroyed;
  editor.destroy();
}

function findTextNode(editor: Editor, text: string): any {
  const paragraph = editor.getJSON().content?.[0];
  return paragraph?.content?.find((node: any) => node.text === text);
}

function findMark(editor: Editor, type: string): any | undefined {
  const paragraph = editor.getJSON().content?.[0];
  for (const node of paragraph?.content || []) {
    const found = node.marks?.find((candidate: any) => candidate.type === type);
    if (found) return found;
  }
  return undefined;
}

test('template field editor initializes with full rich-text formatting extensions', () => {
  const editor = createTemplateFieldEditor('October 28, 2026', 'DATE');
  assert.equal(editor.getText().trim(), 'October 28, 2026');
  assert.ok(editor.extensionManager.extensions.some(ext => ext.name === 'bold'));
  assert.ok(editor.extensionManager.extensions.some(ext => ext.name === 'italic'));
  assert.ok(editor.extensionManager.extensions.some(ext => ext.name === 'underline'));
  assert.ok(editor.extensionManager.extensions.some(ext => ext.name === 'strike'));
  assert.ok(editor.extensionManager.extensions.some(ext => ext.name === 'textStyle'));
  assert.ok(editor.extensionManager.extensions.some(ext => ext.name === 'color'));
  assert.ok(editor.extensionManager.extensions.some(ext => ext.name === 'fontFamily'));
  assert.ok(editor.extensionManager.extensions.some(ext => ext.name === 'fontSize'));
  assert.ok(editor.extensionManager.extensions.some(ext => ext.name === 'highlight'));
  assert.ok(editor.extensionManager.extensions.some(ext => ext.name === 'placeholder'));
  assert.ok(editor.extensionManager.extensions.some(ext => ext.name === 'templateFieldEnterKey'));
  disposeEditor(editor);
});

test('bold formatting applies, toggles, and preserves surrounding text in template fields', () => {
  const editor = createTemplateFieldEditor('Important Date', 'DATE');
  // Select "Important" (positions 1 to 10 in doc)
  editor.commands.setTextSelection({ from: 1, to: 10 });
  editor.commands.toggleBold();

  assert.ok(editor.isActive('bold'));
  const boldNode = findTextNode(editor, 'Important');
  assert.ok(boldNode?.marks?.some((m: any) => m.type === 'bold'));

  const dateNode = findTextNode(editor, ' Date');
  assert.ok(!dateNode?.marks?.some((m: any) => m.type === 'bold'));

  // Toggle bold off
  editor.commands.setTextSelection({ from: 1, to: 10 });
  editor.commands.toggleBold();
  assert.ok(!editor.isActive('bold'));
  assert.equal(findMark(editor, 'bold'), undefined);
  disposeEditor(editor);
});

test('italic, underline, and strikethrough formatting apply correctly to template fields', () => {
  const editor = createTemplateFieldEditor('Sunny and warm', 'MOOD / WEATHER');
  editor.commands.selectAll();

  editor.commands.toggleItalic();
  assert.ok(editor.isActive('italic'));
  assert.ok(findMark(editor, 'italic'));

  editor.commands.toggleUnderline();
  assert.ok(editor.isActive('underline'));
  assert.ok(findMark(editor, 'underline'));

  editor.commands.toggleStrike();
  assert.ok(editor.isActive('strike'));
  assert.ok(findMark(editor, 'strike'));
  disposeEditor(editor);
});

test('text color and highlight formatting apply correctly to template fields', () => {
  const editor = createTemplateFieldEditor('Meeting at 3PM', 'DATE');
  editor.commands.selectAll();

  // Apply custom text color
  editor.commands.setColor('#ef4444');
  assert.equal(editor.getAttributes('textStyle').color, '#ef4444');
  assert.equal(findMark(editor, 'textStyle')?.attrs?.color, '#ef4444');

  // Apply highlight
  editor.commands.setHighlight({ color: '#fef08a' });
  assert.ok(editor.isActive('highlight'));
  assert.equal(editor.getAttributes('highlight').color, '#fef08a');
  assert.equal(findMark(editor, 'highlight')?.attrs?.color, '#fef08a');

  // Unset color and highlight
  editor.commands.unsetColor();
  assert.equal(editor.getAttributes('textStyle').color, undefined);
  editor.commands.unsetHighlight();
  assert.ok(!editor.isActive('highlight'));
  disposeEditor(editor);
});

test('font family and font size formatting apply correctly to template fields', () => {
  const editor = createTemplateFieldEditor('Lecture 5: Algorithms', 'COURSE & TOPIC');
  editor.commands.selectAll();

  // Set font family
  editor.commands.setFontFamily('Georgia, serif');
  assert.equal(editor.getAttributes('textStyle').fontFamily, 'Georgia, serif');
  assert.equal(findMark(editor, 'textStyle')?.attrs?.fontFamily, 'Georgia, serif');

  // Set font size
  editor.commands.setFontSize('18px');
  assert.equal(editor.getAttributes('textStyle').fontSize, '18px');
  assert.equal(findMark(editor, 'textStyle')?.attrs?.fontSize, '18px');

  // Unset font family and font size
  editor.commands.unsetFontFamily();
  editor.commands.unsetFontSize();
  assert.equal(editor.getAttributes('textStyle').fontFamily, undefined);
  assert.equal(editor.getAttributes('textStyle').fontSize, undefined);
  disposeEditor(editor);
});

test('reset text formatting restores clean plain text', () => {
  const editor = createTemplateFieldEditor('Styled text', 'DATE');
  editor.commands.selectAll();
  editor.commands.toggleBold();
  editor.commands.toggleItalic();
  editor.commands.setColor('#10b981');
  editor.commands.setFontSize('22px');

  assert.ok(editor.isActive('bold'));
  assert.ok(editor.isActive('italic'));
  assert.equal(editor.getAttributes('textStyle').color, '#10b981');

  // Execute full formatting reset chain as used in Panvas TextFormattingStrip
  editor.chain().focus()
    .unsetBold()
    .unsetItalic()
    .unsetUnderline()
    .unsetStrike()
    .unsetColor()
    .unsetHighlight()
    .unsetFontFamily()
    .unsetFontSize()
    .run();

  assert.ok(!editor.isActive('bold'));
  assert.ok(!editor.isActive('italic'));
  assert.equal(editor.getAttributes('textStyle').color, undefined);
  assert.equal(editor.getAttributes('textStyle').fontSize, undefined);
  assert.equal(editor.getText().trim(), 'Styled text');
  disposeEditor(editor);
});

test('undo and redo revert and restore template field formatting changes', () => {
  const editor = createTemplateFieldEditor('Reversible text', 'DATE');
  editor.commands.selectAll();

  // Initial state: not bold
  assert.equal(findMark(editor, 'bold'), undefined);

  // Step 1: Make bold
  editor.commands.toggleBold();
  assert.ok(findMark(editor, 'bold'));

  // Step 2: Undo formatting
  editor.commands.undo();
  assert.equal(findMark(editor, 'bold'), undefined);

  // Step 3: Redo formatting
  editor.commands.redo();
  assert.ok(findMark(editor, 'bold'));
  disposeEditor(editor);
});

test('resolveFormattingEditor and runFormattingCommand seamlessly format template field editor', () => {
  const engine = new NotebookEngine();
  const editor = createTemplateFieldEditor('Date headline', 'DATE');

  // Register in engine texts
  engine.texts.registerEditor('template-field-date', editor);

  // When template editor is activeEditor, resolveFormattingEditor returns it
  const resolved = resolveFormattingEditor(editor, engine);
  assert.equal(resolved, editor);

  // Run formatting command through the production formatting runner
  editor.commands.selectAll();
  const nextRange = runFormattingCommand(editor, captureFormattingSelection(editor), c => c.toggleBold());
  assert.ok(nextRange !== null);
  assert.ok(findMark(editor, 'bold'));

  engine.texts.unregisterEditor('template-field-date');
  disposeEditor(editor);
});

test('formatted template fields persist through page overrides and resolve without data loss', () => {
  const notebook: Notebook = {
    id: 'test-notebook',
    workspaceId: 'ws-1',
    name: 'Research Notebook',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const page: NotebookPage = {
    id: 'page-journal-1',
    notebookId: 'test-notebook',
    pageNumber: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const formattedDate = '<p><strong>28 October 2026</strong></p>';
  const formattedMood = '<p><span style="color: #3b82f6;">Productive &amp; Focused</span></p>';

  const properties = {
    ...getNotebookPageDefaults(notebook),
    template: 'Journal' as const,
    templateFields: {
      date: formattedDate,
      'mood-weather': formattedMood,
    },
  };

  // Derive overrides (persisted to database / IPC layer)
  const overrides = derivePagePropertyOverrides(properties, notebook);
  assert.deepEqual(overrides.templateFields, {
    date: formattedDate,
    'mood-weather': formattedMood,
  });

  // Re-resolve page properties from page with overrides
  const resolved = resolvePageProperties(notebook, { ...page, pagePropertyOverrides: overrides });
  assert.equal(resolved.templateFields?.date, formattedDate);
  assert.equal(resolved.templateFields?.['mood-weather'], formattedMood);
});

test('backward compatibility: legacy plain text strings load without corruption into template field editor', () => {
  const legacyDate = '8 September';
  const editor = createTemplateFieldEditor(legacyDate, 'DATE');

  // Loads plain text cleanly
  assert.equal(editor.getText().trim(), legacyDate);
  assert.ok(!editor.isActive('bold'));

  // User subsequently formats the legacy text
  editor.commands.selectAll();
  editor.commands.toggleBold();
  assert.ok(findMark(editor, 'bold'));
  disposeEditor(editor);
});

