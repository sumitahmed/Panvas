import './rich-text-pipeline';
import { parseNotebookMarkdown, serializeNotebookMarkdown, importNotebookMarkdownFile, createNotebookMarkdownFile } from '../../src/components/notebook/notebookMarkdown';
import { unsupportedNotebookContent } from '../../src/components/notebook/notebookContentCompatibility';
import { getNotebookSchema, lowlight } from '../../src/components/notebook/tiptapExtensions';
import { documentationHeadings } from '../../src/components/notebook/notebookDocumentationNodes';
import { documentationBlockLink } from '../../src/components/notebook/notebookBlockCommands';
import { textFromTipTap } from '../../src/services/search/pageSearchContent';
import { canvasRepository } from '../../src/repositories/CanvasRepository';
import { createEmptyDrawingData } from '../../src/components/notebook/engine/drawingTypes';
import { dispatchDocumentationReference } from '../../src/components/notebook/notebookDocumentationNodes';
Object.assign(window, { documentationFixture: {
  parse: parseNotebookMarkdown,
  serialize: serializeNotebookMarkdown,
  importFile: (name: string, source: string) => importNotebookMarkdownFile(new File([source], name, { type: 'text/markdown' })),
  exportFile: async (content: Parameters<typeof createNotebookMarkdownFile>[0], name: string) => {
    const result = createNotebookMarkdownFile(content, name);
    return { fileName: result.fileName, markdown: await result.blob.text(), warnings: result.warnings };
  },
  unsupported: (content: unknown) => unsupportedNotebookContent(content, getNotebookSchema()),
  headings: documentationHeadings,
  link: documentationBlockLink,
  search: textFromTipTap,
  languages: () => lowlight.listLanguages(),
  follow: dispatchDocumentationReference,
  protectVersion: async (version: number) => {
    const fixture = (window as any).richFixture;
    const engine = fixture.engine(), pageId = engine.getDrawingOwnership().pageId;
    const data = engine.getDrawingData();
    data.objects[0].metadata = { ...data.objects[0].metadata, richTextSchemaVersion: version };
    engine.setDrawingData(createEmptyDrawingData(), pageId);
    engine.input.notifyChange();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    engine.setDrawingData(data, pageId);
    engine.input.notifyChange();
  },
  storeImage: async (pageId: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    canvas.getContext('2d')!.fillRect(0, 0, 2, 2);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    const file = await canvasRepository.storeImage(null, pageId, 'stage-2.png', 'image/png', await blob.arrayBuffer());
    return file.id;
  },
} });
