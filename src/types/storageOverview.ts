export interface StorageRootInfo {
  path: string;
  configuredPath: string | null;
  isDefault: boolean;
  available: boolean;
  activePath?: string;
}

export interface StorageOverview {
  backend: 'filesystem' | 'browser';
  counts: { workspaces: number; canvases: number; notebooks: number; pages: number } | null;
  countsComplete: boolean;
  usedBytes: number | null;
  usageKind: 'measured' | 'partial' | 'estimated' | 'unavailable';
  quotaBytes: number | null;
  health: 'accessible' | 'attention' | 'unavailable';
  healthDetail: string;
  root: StorageRootInfo | null;
  measuredAt: number;
  issues: string[];
}
