import { create } from 'zustand';
import { settingsRepository } from '@/repositories/SettingsRepository';
import type { PageTemplate, ScrollDirection } from '@/components/notebook/engine/drawingTypes';
import { defaultHighlightPalette, readHighlightPalette, selectHighlightColor, type HighlightPalettePreference } from '@/lib/highlightPalette';

// Keep fast native preference writes in order; never serialize notebook content.
let paletteWrite: Promise<void> = Promise.resolve();
function saveHighlightPalette(palette: HighlightPalettePreference) {
  const write = paletteWrite.catch(() => {}).then(() => settingsRepository.set('notebook_highlightPalette', palette));
  paletteWrite = write;
  return write;
}

export type PaperColorOption = string;
export type PageTemplateOption = PageTemplate;
export type PageOrientationOption = 'Portrait' | 'Landscape';
export type PageSizeOption = 'A3' | 'A4' | 'A5' | 'Letter' | 'Infinite';
export type PageMarginOption = 'No Margin' | 'Narrow' | 'Normal' | 'Wide';

interface NotebookSettingsState {
  paperColor: PaperColorOption;
  template: PageTemplateOption;
  orientation: PageOrientationOption;
  pageSize: PageSizeOption;
  margins: PageMarginOption;
  scrollDirection: ScrollDirection;
  highlightPalette: HighlightPalettePreference;
  selectHighlightColor: (color: string | null, custom?: boolean) => Promise<void>;
  resetHighlightPalette: () => Promise<void>;
  
  setPaperColor: (color: PaperColorOption) => void;
  setTemplate: (template: PageTemplateOption) => void;
  setOrientation: (orientation: PageOrientationOption) => void;
  setPageSize: (size: PageSizeOption) => void;
  setMargins: (margins: PageMarginOption) => void;
  setScrollDirection: (scrollDirection: ScrollDirection) => void;
  hydrateSettings: (settings: Record<string, unknown>) => void;
  loadSettings: () => Promise<void>;
}

export const useNotebookSettingsStore = create<NotebookSettingsState>((set, get) => ({
  paperColor: '#ffffff',
  template: 'Blank',
  orientation: 'Portrait',
  pageSize: 'A4',
  margins: 'Normal',
  scrollDirection: 'vertical',
  highlightPalette: defaultHighlightPalette(),

  selectHighlightColor: (color, custom = false) => {
    const previous = get().highlightPalette, highlightPalette = selectHighlightColor(previous, color, custom);
    if (highlightPalette === previous) return Promise.resolve();
    set({ highlightPalette });
    return saveHighlightPalette(highlightPalette);
  },
  resetHighlightPalette: () => {
    const highlightPalette = defaultHighlightPalette(get().highlightPalette.selectedColor);
    set({ highlightPalette });
    return saveHighlightPalette(highlightPalette);
  },

  setPaperColor: (paperColor) => {
    set({ paperColor });
    settingsRepository.set('notebook_paperColor', paperColor);
  },
  setTemplate: (template) => {
    set({ template });
    settingsRepository.set('notebook_template', template);
  },
  setOrientation: (orientation) => {
    set({ orientation });
    settingsRepository.set('notebook_orientation', orientation);
  },
  setPageSize: (pageSize) => {
    set({ pageSize });
    settingsRepository.set('notebook_pageSize', pageSize);
  },
  setMargins: (margins) => {
    set({ margins });
    settingsRepository.set('notebook_margins', margins);
  },
  setScrollDirection: (scrollDirection: ScrollDirection) => {
    set({ scrollDirection: 'vertical' });
    settingsRepository.set('notebook_scrollDirection', 'vertical');
  },
  hydrateSettings: (settings: Record<string, unknown>) => {
    set(state => ({
      paperColor: typeof settings.notebook_paperColor === 'string' ? settings.notebook_paperColor : state.paperColor,
      template: typeof settings.notebook_template === 'string' ? settings.notebook_template as PageTemplateOption : state.template,
      orientation: settings.notebook_orientation === 'Portrait' || settings.notebook_orientation === 'Landscape' ? settings.notebook_orientation : state.orientation,
      pageSize: ['A3', 'A4', 'A5', 'Letter', 'Infinite'].includes(String(settings.notebook_pageSize)) ? settings.notebook_pageSize as PageSizeOption : state.pageSize,
      margins: ['No Margin', 'Narrow', 'Normal', 'Wide'].includes(String(settings.notebook_margins)) ? settings.notebook_margins as PageMarginOption : state.margins,
      scrollDirection: 'vertical',
      highlightPalette: readHighlightPalette(settings.notebook_highlightPalette),
    }));
  },
  loadSettings: async () => {
    const paperColor = await settingsRepository.get('notebook_paperColor');
    const template = await settingsRepository.get('notebook_template');
    const orientation = await settingsRepository.get('notebook_orientation');
    const pageSize = await settingsRepository.get('notebook_pageSize');
    const margins = await settingsRepository.get('notebook_margins');
    const scrollDirection = await settingsRepository.get('notebook_scrollDirection');
    const highlightPalette = readHighlightPalette(await settingsRepository.get('notebook_highlightPalette'));
    
    set(state => ({
      paperColor: paperColor ?? state.paperColor,
      template: template ?? state.template,
      orientation: orientation ?? state.orientation,
      pageSize: pageSize ?? state.pageSize,
      margins: margins ?? state.margins,
      scrollDirection: scrollDirection ?? state.scrollDirection,
      highlightPalette,
    }));
  }
}));
