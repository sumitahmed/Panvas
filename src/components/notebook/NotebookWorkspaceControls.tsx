import React from 'react';
import { PanelLeft, PanelRight, Maximize2, Minimize2 } from 'lucide-react';
import { useUIStore } from '@/stores/uiStore';
import { useLayoutStore } from '@/stores/layoutStore';

export const NotebookWorkspaceControls: React.FC<{ focusOnly?: boolean; embedded?: boolean; showLabel?: boolean }> = ({ focusOnly = false, embedded = false, showLabel = false }) => {
  const { notebookModeLevel, setNotebookModeLevel, toggleNotebookPane, isNotebookPaneVisible, previousPanelState, setPreviousPanelState } = useLayoutStore();
  const { isSidebarOpen, toggleSidebar, togglePropertiesPanel, isPropertiesPanelOpen } = useUIStore();

  const handleToggleLeftPanel = () => {
    if (notebookModeLevel === 0) {
      toggleSidebar();
    } else {
      toggleNotebookPane();
    }
  };

  const handleToggleFocus = () => {
    if (notebookModeLevel !== 2) {
      // Entering Focus mode
      setPreviousPanelState({
        libraryVisible: notebookModeLevel === 0 ? isSidebarOpen : isNotebookPaneVisible,
        propertiesVisible: isPropertiesPanelOpen,
      });
      setNotebookModeLevel(2);
      
      // Force close them visually
      if (isSidebarOpen) toggleSidebar();
      if (isPropertiesPanelOpen) togglePropertiesPanel();
      if (notebookModeLevel === 1 && isNotebookPaneVisible) toggleNotebookPane();
    } else {
      // Exiting Focus mode
      setNotebookModeLevel(0); // We'll always default back to level 0 for standard layout memory
      
      if (previousPanelState) {
        if (previousPanelState.libraryVisible !== isSidebarOpen) toggleSidebar();
        if (previousPanelState.propertiesVisible !== isPropertiesPanelOpen) togglePropertiesPanel();
      }
      setPreviousPanelState(null);
    }
  };

  const isLeftPanelActive = notebookModeLevel === 0 ? isSidebarOpen : isNotebookPaneVisible;

  return (
    <div className={`flex items-center gap-1.5 text-panvas-text-primary select-none ${showLabel ? 'w-full' : 'w-max'} max-[599px]:gap-1 ${embedded ? (showLabel ? '' : 'p-1') : 'panvas-workspace-controls panvas-floating-surface p-1.5 max-[599px]:p-1'}`} role="toolbar" aria-label="Notebook workspace controls">
      {/* Full Page View */}
      <button
        type="button"
        onClick={handleToggleFocus}
        aria-pressed={notebookModeLevel === 2}
        className={`${showLabel ? 'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm' : 'panvas-icon-control shrink-0'} focus-ring ${
          notebookModeLevel === 2 
            ? 'bg-panvas-bg-hover text-panvas-text-primary' 
            : 'text-panvas-text-secondary hover:text-panvas-text-primary hover:bg-panvas-bg-hover'
        }`}
        title={notebookModeLevel === 2 ? "Exit Full Page View" : "Enter Full Page View"}
        aria-label={notebookModeLevel === 2 ? "Exit Full Page View" : "Enter Full Page View"}
      >
        {notebookModeLevel === 2 ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        {showLabel && <span>{notebookModeLevel === 2 ? 'Exit Full Page' : 'Full Page'}</span>}
      </button>

      {!focusOnly && <>

      <div className="w-px h-4 bg-panvas-border-default mx-1 shrink-0 max-[599px]:mx-0.5"></div>

      {/* Left Navigation Panel */}
      <button
        type="button"
        onClick={handleToggleLeftPanel}
        aria-pressed={isLeftPanelActive}
        className={`panvas-icon-control shrink-0 focus-ring ${
          isLeftPanelActive 
            ? 'bg-panvas-bg-hover text-panvas-text-primary' 
            : 'text-panvas-text-secondary hover:text-panvas-text-primary hover:bg-panvas-bg-hover'
        }`}
        title={notebookModeLevel === 0 ? (isSidebarOpen ? "Hide Library" : "Show Library") : (isNotebookPaneVisible ? "Hide Notebook Navigator" : "Show Notebook Navigator")}
        aria-label={notebookModeLevel === 0 ? (isSidebarOpen ? "Hide Library" : "Show Library") : (isNotebookPaneVisible ? "Hide Notebook Navigator" : "Show Notebook Navigator")}
      >
        <PanelLeft size={16} />
      </button>

      {/* Page Properties */}
      <button
        type="button"
        onClick={togglePropertiesPanel}
        aria-pressed={isPropertiesPanelOpen}
        className={`panvas-icon-control shrink-0 focus-ring ${
          isPropertiesPanelOpen 
            ? 'bg-panvas-bg-hover text-panvas-text-primary' 
            : 'text-panvas-text-secondary hover:text-panvas-text-primary hover:bg-panvas-bg-hover'
        }`}
        title="Toggle Page Properties"
        aria-label="Open page and view inspector"
      >
        <PanelRight size={16} />
      </button>
      </>}
    </div>
  );
};
