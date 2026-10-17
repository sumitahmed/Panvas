// ============================================
// Panvas — Text Manager
// ============================================
// Handles state for text boxes.

import type { TextObject } from './drawingTypes.ts';
import { LayerManager } from './LayerManager.ts';

export class TextManager {
  private documentBodyId?: string;
  setDocumentBodyId(id: string | undefined): void { this.documentBodyId = id; }
  getDocumentBodyId(): string | undefined { return this.documentBodyId; }
  private defaultFontFamily = 'Inter, sans-serif';
  getDefaultFontFamily(): string { return this.defaultFontFamily; }
  setDefaultFontFamily(fontFamily: string): void { this.defaultFontFamily = fontFamily || 'Inter, sans-serif'; }
  private texts: TextObject[] = [];
  private editors: Map<string, any> = new Map(); // Store Editor instances
  private layerManager: LayerManager;

  constructor(layerManager: LayerManager = new LayerManager()) {
    this.layerManager = layerManager;
  }

  private lastActiveTextId?: string;

  registerEditor(id: string, editor: any): void {
    this.editors.set(id, editor);
  }

  unregisterEditor(id: string): void {
    this.editors.delete(id);
    if (this.lastActiveTextId === id) {
      this.lastActiveTextId = undefined;
    }
  }

  getEditor(id: string): any | undefined {
    return this.editors.get(id);
  }

  setActiveTextId(id: string | undefined): void {
    this.lastActiveTextId = id;
  }

  getActiveTextId(): string | undefined {
    return this.lastActiveTextId;
  }

  getFocusedText(): TextObject | undefined {
    for (const [id, editor] of this.editors.entries()) {
      if (editor && !editor.isDestroyed && editor.isFocused) {
        this.lastActiveTextId = id;
        return this.texts.find(t => t.id === id);
      }
    }
    if (this.lastActiveTextId) {
      const active = this.texts.find(t => t.id === this.lastActiveTextId);
      if (active) return active;
    }
    return undefined;
  }

  getTexts(): TextObject[] {
    return this.texts;
  }

  setTexts(texts: TextObject[]): void {
    this.texts = texts;
  }

  addText(text: TextObject): void {
    text.layerId ??= this.layerManager.getActiveLayerId();
    this.texts.push(text);
  }

  /** Replace one object in place so continuation history preserves render order. */
  replaceText(text: TextObject): boolean {
    const index = this.texts.findIndex(candidate => candidate.id === text.id);
    if (index < 0) return false;
    this.texts[index] = text;
    return true;
  }

  updateTextContent(id: string, content: any): void {
    const text = this.texts.find(t => t.id === id);
    if (text) {
      text.content = content;
    }
  }

  /** Update metadata without replacing the text object identity used by the
   * selection and renderer layers. */
  updateTextMetadata(id: string, metadata: Record<string, any>): TextObject | undefined {
    const text = this.texts.find(t => t.id === id);
    if (!text) return undefined;
    text.metadata = { ...(text.metadata ?? {}), ...metadata };
    return text;
  }

  updateTextBounds(id: string, width: number, height: number): void {
    const text = this.texts.find(t => t.id === id);
    if (text) {
      text.width = width;
      text.height = height;
    }
  }

  updateTextPositionAndBounds(id: string, x: number, y: number, width: number, height: number): void {
    const text = this.texts.find(t => t.id === id);
    if (text) {
      text.x = x;
      text.y = y;
      text.width = width;
      text.height = height;
    }
  }

  removeText(id: string): TextObject | undefined {
    const index = this.texts.findIndex(t => t.id === id);
    if (index === -1) return undefined;
    const [removed] = this.texts.splice(index, 1);
    return removed;
  }

  removeTexts(ids: Set<string>): TextObject[] {
    const removed: TextObject[] = [];
    this.texts = this.texts.filter(t => {
      if (ids.has(t.id)) {
        removed.push(t);
        return false;
      }
      return true;
    });
    return removed;
  }

  clearTexts(): TextObject[] {
    const removed = this.texts;
    this.texts = [];
    return removed;
  }

  isEditable(text: TextObject): boolean {
    return this.layerManager.isEditable(text.layerId);
  }
}
