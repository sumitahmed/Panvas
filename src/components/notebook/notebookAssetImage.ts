import Image from '@tiptap/extension-image';
import { mergeAttributes } from '@tiptap/core';
import { canvasRepository } from '../../repositories/CanvasRepository';

export function isAssetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
}

export function safeImageReference(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) return null;
  const source = value.trim();
  if (/^https?:\/\//i.test(source)) {
    try { new URL(source); return source; } catch { return null; }
  }
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source) ? source : null;
}

/** Only local repository bytes are loaded. External/relative references stay placeholders. */
export function hydrateAssetImages(root: HTMLElement): () => void {
  let disposed = false;
  const urls: string[] = [];
  root.querySelectorAll<HTMLElement>('[data-type="asset-image"], [data-type="asset-inline-image"]').forEach(element => {
    const id = element.dataset.fileId;
    if (!isAssetId(id)) return;
    void canvasRepository.getImage(id).then(file => {
      if (disposed || !file || !/^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i.test(file.mimeType)) return;
      const url = URL.createObjectURL(new Blob([file.data], { type: file.mimeType }));
      urls.push(url);
      const image = document.createElement('img');
      image.src = url;
      image.alt = element.dataset.alt ?? '';
      for (const dimension of ['width', 'height']) {
        const size = Number(element.getAttribute('data-' + dimension));
        if (Number.isFinite(size) && size > 0) image.setAttribute(dimension, String(size));
      }
      image.style.maxWidth = '100%';
      element.replaceChildren(image);
    }).catch(() => { /* Keep the recoverable reference visible. */ });
  });
  return () => { disposed = true; urls.forEach(url => URL.revokeObjectURL(url)); };
}

const AssetImage = Image.extend({
  addAttributes() {
    return {
      fileId: { default: null, parseHTML: element => element.getAttribute('data-file-id'), renderHTML: attrs => attrs.fileId ? { 'data-file-id': attrs.fileId } : {} },
      source: { default: null, parseHTML: element => safeImageReference(element.getAttribute('data-source')), renderHTML: attrs => attrs.source ? { 'data-source': attrs.source } : {} },
      alt: { default: '', parseHTML: element => element.getAttribute('data-alt') ?? '', renderHTML: attrs => ({ 'data-alt': attrs.alt }) },
      title: { default: null },
      width: { default: null, parseHTML: element => Number(element.getAttribute('data-width')) || null, renderHTML: attrs => attrs.width ? { 'data-width': attrs.width } : {} },
      height: { default: null, parseHTML: element => Number(element.getAttribute('data-height')) || null, renderHTML: attrs => attrs.height ? { 'data-height': attrs.height } : {} },
    };
  },
  parseHTML() {
    return [{ tag: this.options.inline ? 'span[data-type="asset-inline-image"]' : 'div[data-type="asset-image"]' }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [this.options.inline ? 'span' : 'div', mergeAttributes(HTMLAttributes, {
      'data-type': this.options.inline ? 'asset-inline-image' : 'asset-image',
      class: 'panvas-document-asset',
    }), node.attrs.alt ? 'Image: ' + node.attrs.alt : 'Image reference (portability pending)'];
  },
  addCommands() { return {}; }, // No upload/insertion UI before Stage 3 portability acceptance.
  addNodeView() {
    return ({ node, HTMLAttributes }) => {
      const dom = document.createElement(this.options.inline ? 'span' : 'div');
      for (const [key, value] of Object.entries(HTMLAttributes)) if (value != null) dom.setAttribute(key, String(value));
      dom.dataset.type = this.options.inline ? 'asset-inline-image' : 'asset-image';
      dom.classList.add('panvas-document-asset');
      dom.textContent = node.attrs.alt ? 'Image: ' + node.attrs.alt : 'Image reference (portability pending)';
      const wrapper = document.createElement('div');
      wrapper.appendChild(dom);
      const dispose = hydrateAssetImages(wrapper);
      return { dom, destroy: dispose, ignoreMutation: () => true };
    };
  },
});

export const NotebookImage = AssetImage.configure({ inline: false });
export const NotebookInlineImage = AssetImage.extend({ name: 'inlineImage' }).configure({ inline: true });
