import { useUIStore } from '@/stores/uiStore';

export function useFullDarkView(): boolean {
  return useUIStore(state => state.theme === 'dark' && state.fullDarkView && !state.isPrinting);
}
