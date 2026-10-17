import type React from 'react';

function rows(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter(row => row.getClientRects().length);
}

/** Roving focus is DOM-only: navigating the tree does not rerender its branches. */
export function focusWorkspaceTree(event: React.FocusEvent<HTMLElement>) {
  const row = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (!row) return;
  for (const item of rows(event.currentTarget)) item.tabIndex = item === row ? 0 : -1;
}

export function navigateWorkspaceTree(event: React.KeyboardEvent<HTMLElement>) {
  const row = event.target as HTMLElement;
  if (row.getAttribute('role') !== 'treeitem' || event.altKey || event.ctrlKey || event.metaKey) return;
  const items = rows(event.currentTarget), index = items.indexOf(row), level = Number(row.getAttribute('aria-level'));
  let next: HTMLElement | undefined;
  switch (event.key) {
    case 'ArrowDown': next = items[Math.min(index + 1, items.length - 1)]; break;
    case 'ArrowUp': next = items[Math.max(index - 1, 0)]; break;
    case 'Home': next = items[0]; break;
    case 'End': next = items[items.length - 1]; break;
    case 'ArrowRight':
      if (row.getAttribute('aria-expanded') === 'false') row.querySelector<HTMLButtonElement>('[data-tree-toggle]')?.click();
      else if (Number(items[index + 1]?.getAttribute('aria-level')) > level) next = items[index + 1];
      break;
    case 'ArrowLeft':
      if (row.getAttribute('aria-expanded') === 'true') row.querySelector<HTMLButtonElement>('[data-tree-toggle]')?.click();
      else next = items.slice(0, index).reverse().find(item => Number(item.getAttribute('aria-level')) < level);
      break;
    case 'F10':
      if (!event.shiftKey) return;
      // Use the existing context menu at this row, including keyboard invocation.
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
        clientX: row.getBoundingClientRect().left + 24, clientY: row.getBoundingClientRect().bottom }));
      break;
    default: return;
  }
  event.preventDefault(); event.stopPropagation(); next?.focus();
}
