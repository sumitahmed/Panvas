import { useId, useLayoutEffect, type RefObject } from 'react';
import { fullDarkInkColor, fullDarkSurfaceColor } from '@/lib/fullDarkView';

/** A scoped view stylesheet leaves TipTap's DOM styles and parsed marks intact. */
export function useDocumentTextPresentation(ref: RefObject<HTMLElement | null>, enabled: boolean, content: unknown): void {
  const scope = useId();
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    const stylesheet = document.createElement('style');
    root.setAttribute('data-document-view', scope);
    document.head.append(stylesheet);
    const update = () => {
      const rules = new Set<string>();
      const escScope = CSS.escape(scope);
      const prefixes = [
        `.dark.full-dark-view [data-document-view="${escScope}"]`,
        `[data-panvas-dark-paper="true"][data-document-view="${escScope}"]`,
      ];
      for (const element of [root, ...root.querySelectorAll<HTMLElement>('[style]')]) {
        if (element.tagName === 'IMG' || element.tagName === 'VIDEO') continue;
        for (const property of ['color', 'background-color']) {
          const original = element.style.getPropertyValue(property);
          if (!original || original === 'transparent') continue;
          const value = CSS.escape(`${property}: ${original}`);
          const display = property === 'color' ? fullDarkInkColor(original) : fullDarkSurfaceColor(original, true);
          for (const prefix of prefixes) {
            rules.add(`${prefix} [style^="${value}"],${prefix} [style*="; ${value}"]{${property}:${display}!important}`);
          }
        }
      }
      const css = [...rules].join('\n');
      if (stylesheet.textContent !== css) stylesheet.textContent = css;
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    return () => { observer.disconnect(); stylesheet.remove(); root.removeAttribute('data-document-view'); };
  }, [ref, enabled, content, scope]);
}
