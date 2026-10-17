import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { StorageService } from '@/services/storage/StorageService';
import type { StorageOverview } from '@/types/storageOverview';
import { useAuthStore } from '@/stores/authStore';
import { getCloudSyncPresentation } from '@/services/cloudsync/presentation';
import { SettingsCloudConnection, useSettingsCloudState } from '../SettingsCloudConnection';

export function WorkspaceSection() {
  const userId = useAuthStore(state => state.user?.id ?? null);
  const cloud = useSettingsCloudState();
  const presentation = getCloudSyncPresentation(cloud);
  const [storage, setStorage] = useState<StorageOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = async (force = false) => {
    const request = ++generation.current;
    setLoading(true); setError(null);
    try {
      const value = await StorageService.getMetrics(force);
      if (request === generation.current) setStorage(value);
    } catch {
      if (request === generation.current) { setStorage(null); setError('Local storage information could not be read. Your files have not been changed.'); }
    } finally { if (request === generation.current) setLoading(false); }
  };
  useEffect(() => {
    setStorage(null); void refresh();
    return () => { generation.current++; };
  }, [userId]);
  const choose = async () => {
    if (!window.panvas?.storage || choosing) return;
    setChoosing(true); setFolderError(null);
    try {
      const result = await window.panvas.storage.chooseRoot();
      if (result) await refresh(true);
    } catch { setFolderError('The selected folder is unavailable or not writable.'); }
    finally { setChoosing(false); }
  };
  const usage = !storage || storage.usedBytes === null ? 'Unavailable'
    : `${storage.usageKind === 'partial' ? 'At least ' : storage.usageKind === 'estimated' ? 'About ' : ''}${StorageService.formatBytes(storage.usedBytes)}`;
  return <div className="flex flex-col gap-6">
    <header className="pr-8"><h2 className="mb-1 text-xl font-semibold text-panvas-text-primary">Workspace & Storage</h2><p className="text-sm text-panvas-text-secondary">Local data and Google Drive are checked separately.</p></header>
    <section aria-label="Local storage" className="panvas-surface overflow-hidden" aria-busy={loading}>
      <div className="flex items-center justify-between gap-3 border-b border-panvas-border-subtle px-4 py-3">
        <h3 className="text-sm font-medium text-panvas-text-primary">On this device</h3>
        <button type="button" onClick={() => void refresh(true)} disabled={loading} className="inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-xs text-panvas-text-secondary hover:bg-panvas-bg-hover disabled:opacity-50 focus-ring"><RefreshCw size={14} aria-hidden="true" />{loading ? 'Checking…' : 'Refresh'}</button>
      </div>
      {error ? <p role="alert" className="p-4 text-sm text-panvas-text-primary">{error}</p> : !storage ? <p role="status" className="p-4 text-sm text-panvas-text-secondary">Reading local storage…</p> : <>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-panvas-border-subtle p-4 sm:grid-cols-4">
          {(['workspaces', 'canvases', 'notebooks', 'pages'] as const).map(key => <div key={key}><dt className="text-xs capitalize text-panvas-text-secondary">{key}</dt><dd data-storage-count={key} className="mt-1 text-lg font-semibold tabular-nums text-panvas-text-primary">{storage.counts ? `${storage.countsComplete ? '' : '≥ '}${storage.counts[key]}` : 'Unavailable'}</dd></div>)}
        </dl>
        <dl className="space-y-3 p-4 text-sm">
          <Row label="Storage used" value={usage} />
          <Row label="Backend" value={storage.backend === 'filesystem' ? 'Local filesystem' : 'Browser storage'} />
          {storage.quotaBytes !== null && <Row label="Browser quota (estimated)" value={StorageService.formatBytes(storage.quotaBytes)} />}
          <Row label="Local storage status" value={storage.health === 'accessible' ? 'Accessible' : storage.health === 'attention' ? 'Needs attention' : 'Unavailable'} />
        </dl>
        <div className="space-y-2 border-t border-panvas-border-subtle p-4 text-xs leading-relaxed text-panvas-text-secondary">
          <p>{storage.healthDetail}</p>
          <p>{storage.backend === 'filesystem' ? 'Usage includes workspace metadata, documents, assets, trash and recovery copies in known Panvas folders. Application caches are excluded.' : 'Usage and quota are browser estimates for this origin, including data belonging to other local accounts. They are not a Google Drive quota.'}</p>
          {storage.issues.map(issue => <p key={issue}>{issue}</p>)}
          <p>Checked <time dateTime={new Date(storage.measuredAt).toISOString()}>{new Date(storage.measuredAt).toLocaleTimeString()}</time>. Cached for up to 30 seconds; Refresh checks again.</p>
        </div>
      </>}
    </section>
    {storage?.root && <section aria-label="Panvas Storage Location" className="panvas-surface space-y-3 p-4">
      <h3 className="text-sm font-medium text-panvas-text-primary">Panvas Storage Location</h3>
      <p className="break-all text-sm text-panvas-text-primary">{storage.root.path}</p>
      {!storage.root.available && <p role="status" className="text-xs text-panvas-text-secondary">This configured folder is unavailable. Existing files have not been moved.</p>}
      {storage.root.activePath && storage.root.activePath !== storage.root.path && <p className="break-all text-xs text-panvas-text-secondary">Discovery fallback: {storage.root.activePath}</p>}
      <p className="text-xs leading-relaxed text-panvas-text-secondary">Changing this folder affects future workspaces and new desktop assets. Existing registered workspaces stay in their original folders; files are not migrated.</p>
      <p className="text-xs leading-relaxed text-panvas-text-secondary">Shared media stays in its original folder and remains readable while that folder is available.</p>
      <button type="button" onClick={() => void choose()} disabled={choosing} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-panvas-border-default px-3 text-xs font-medium text-panvas-text-primary hover:bg-panvas-bg-hover disabled:opacity-50 focus-ring"><FolderOpen size={14} aria-hidden="true" />{choosing ? 'Choosing…' : 'Change folder'}</button>
      {folderError && <p role="alert" className="text-xs text-panvas-text-primary">{folderError}</p>}
    </section>}
    <SettingsCloudConnection cloud={cloud} presentation={presentation} />
  </div>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt className="text-panvas-text-secondary">{label}</dt><dd className="font-medium text-panvas-text-primary">{value}</dd></div>;
}
