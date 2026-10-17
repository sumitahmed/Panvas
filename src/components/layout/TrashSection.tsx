import React from 'react';
import { Trash2, RotateCcw, X, FileText, Folder as FolderIcon, Layout, BookOpen, ListTree } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useUIStore } from '@/stores/uiStore';
import { trashCountdown } from '@/services/cloudsync/trash';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

export function TrashSection() {
  const {
    workspaces,
    folders,
    notebooks,
    notebookSections,
    deletedWorkspaces,
    deletedFolders,
    deletedCanvases,
    deletedNotebooks,
    deletedSections,
    deletedPages,
    restoreItem,
    permanentlyDeleteItem,
    permanentlyDeleteAllTrash,
  } = useWorkspaceStore();

  const [isExpanded, setIsExpanded] = React.useState(false);
  const [isDeleteAllDialogOpen, setIsDeleteAllDialogOpen] = React.useState(false);

  const totalItems = deletedWorkspaces.length + deletedFolders.length + deletedCanvases.length
    + deletedNotebooks.length + deletedSections.length + deletedPages.length;

  const allWorkspaces = [...workspaces, ...deletedWorkspaces];
  const allFolders = [...folders, ...deletedFolders];
  const allNotebooks = [...notebooks, ...deletedNotebooks];
  const allSections = [...notebookSections, ...deletedSections];
  const wsMap = new Map(allWorkspaces.map(w => [w.id, w.name]));
  const folderMap = new Map(allFolders.map(f => [f.id, f]));
  const nbMap = new Map(allNotebooks.map(n => [n.id, n]));
  const secMap = new Map(allSections.map(s => [s.id, s]));

  const formatOrigin = (wsId?: string | null, fId?: string | null, nbId?: string | null, sId?: string | null) => {
    const parts: string[] = [];
    if (wsId && wsMap.has(wsId)) parts.push(wsMap.get(wsId)!);
    if (fId && folderMap.has(fId)) parts.push(folderMap.get(fId)!.name);
    if (nbId && nbMap.has(nbId)) parts.push(nbMap.get(nbId)!.name);
    if (sId && secMap.has(sId)) parts.push(secMap.get(sId)!.name);
    return parts.join(' / ');
  };

  const handleDeleteAll = async () => {
    if (totalItems === 0) return;
    setIsDeleteAllDialogOpen(true);
  };

  const confirmDeleteAll = async () => {
    await permanentlyDeleteAllTrash();
    setIsDeleteAllDialogOpen(false);
  };

  return (
    <section className="border-t border-panvas-border-subtle pt-3" aria-labelledby="trash-heading">
      <div className="flex items-center gap-1">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={`min-w-0 flex-1 flex items-center justify-between px-2 py-1.5 rounded-md text-xs font-medium
                   hover:bg-panvas-bg-hover transition-colors focus-ring
                   ${isExpanded ? 'text-panvas-text-primary' : 'text-panvas-text-tertiary hover:text-panvas-text-secondary'}`}
        >
          <div className="flex items-center gap-2">
            <Trash2 size={13} />
            <span id="trash-heading">Trash</span>
          </div>
          <span className="text-2xs bg-panvas-bg-tertiary px-1.5 rounded-full text-panvas-text-tertiary">
            {totalItems}
          </span>
        </button>
        {totalItems > 0 && <button
          type="button"
          onClick={() => void handleDeleteAll()}
          title="Empty Trash"
          aria-label="Empty Trash"
          className="flex h-7 w-7 items-center justify-center rounded-md text-panvas-text-tertiary hover:bg-panvas-accent-rose/15 hover:text-panvas-accent-rose focus-ring"
        >
          <Trash2 size={13} />
        </button>}
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="pl-1 mt-1 space-y-0.5">
              {deletedWorkspaces.map(ws => (
                <TrashItemRow
                  key={ws.id}
                  name={ws.name}
                  icon={<Layout size={12} className="text-panvas-text-tertiary" />}
                  retentionLabel={ws.deletedAt ? trashCountdown(ws.deletedAt, Date.now()).label : undefined}
                  onRestore={() => restoreItem(ws.id, 'workspace')}
                  onDelete={() => permanentlyDeleteItem(ws.id, 'workspace')}
                />
              ))}
              {deletedFolders.map(f => (
                <TrashItemRow
                  key={f.id}
                  name={f.name}
                  originPath={formatOrigin(f.workspaceId, f.parentId)}
                  icon={<FolderIcon size={12} className="text-panvas-text-tertiary" />}
                  retentionLabel={f.deletedAt ? trashCountdown(f.deletedAt, Date.now()).label : undefined}
                  onRestore={() => restoreItem(f.id, 'folder')}
                  onDelete={() => permanentlyDeleteItem(f.id, 'folder')}
                />
              ))}
              {deletedCanvases.map(c => (
                <TrashItemRow
                  key={c.id}
                  name={c.name}
                  originPath={formatOrigin(c.workspaceId, c.folderId, c.notebookId, c.sectionId)}
                  icon={<FileText size={12} className="text-panvas-text-tertiary" />}
                  retentionLabel={c.deletedAt ? trashCountdown(c.deletedAt, Date.now()).label : undefined}
                  onRestore={() => restoreItem(c.id, 'canvas')}
                  onDelete={() => permanentlyDeleteItem(c.id, 'canvas')}
                />
              ))}
              {deletedNotebooks.map(n => (
                <TrashItemRow
                  key={n.id}
                  name={n.name}
                  originPath={formatOrigin(n.workspaceId, n.folderId)}
                  icon={<BookOpen size={12} className="text-panvas-text-tertiary" />}
                  retentionLabel={n.deletedAt ? trashCountdown(n.deletedAt, Date.now()).label : undefined}
                  onRestore={() => restoreItem(n.id, 'notebook')}
                  onDelete={() => permanentlyDeleteItem(n.id, 'notebook')}
                />
              ))}
              {deletedSections.map(sec => {
                const nb = nbMap.get(sec.notebookId);
                return (
                  <TrashItemRow
                    key={sec.id}
                    name={sec.name}
                    originPath={formatOrigin(nb?.workspaceId, nb?.folderId, sec.notebookId)}
                    icon={<ListTree size={12} className="text-panvas-text-tertiary" />}
                    retentionLabel={sec.deletedAt ? trashCountdown(sec.deletedAt, Date.now()).label : undefined}
                    onRestore={() => restoreItem(sec.id, 'section')}
                    onDelete={() => permanentlyDeleteItem(sec.id, 'section')}
                  />
                );
              })}
              {deletedPages.map(pg => {
                const nb = nbMap.get(pg.notebookId);
                return (
                  <TrashItemRow
                    key={pg.id}
                    name={pg.title || 'Untitled Page'}
                    originPath={formatOrigin(nb?.workspaceId, nb?.folderId, pg.notebookId, pg.sectionId)}
                    icon={<FileText size={12} className="text-panvas-text-tertiary" />}
                    retentionLabel={pg.deletedAt ? trashCountdown(pg.deletedAt, Date.now()).label : undefined}
                    onRestore={() => restoreItem(pg.id, 'page')}
                    onDelete={() => permanentlyDeleteItem(pg.id, 'page')}
                  />
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <ConfirmDialog
        open={isDeleteAllDialogOpen}
        title="Empty Trash permanently?"
        description={`This will permanently delete all ${totalItems} Trash item${totalItems === 1 ? '' : 's'}. This cannot be undone.`}
        confirmLabel="Empty Trash"
        onCancel={() => setIsDeleteAllDialogOpen(false)}
        onConfirm={confirmDeleteAll}
      />
    </section>
  );
}

function TrashItemRow({ name, icon, onRestore, onDelete, retentionLabel, originPath }: { name: string; icon: React.ReactNode; onRestore: () => void; onDelete?: () => void; retentionLabel?: string; originPath?: string }) {
  const [isConfirmOpen, setIsConfirmOpen] = React.useState(false);

  return (
    <div className="group flex items-center justify-between px-2 py-1 rounded-md text-xs hover:bg-panvas-bg-hover">
      <div className="flex items-center gap-2 overflow-hidden">
        <span className="flex-shrink-0">{icon}</span>
        <span className="min-w-0">
          <span className="block truncate text-panvas-text-secondary opacity-60 line-through decoration-panvas-text-tertiary">
            {name}
          </span>
          {originPath && <span className="block text-[10px] text-panvas-text-tertiary truncate" title={originPath}>{originPath}</span>}
          {retentionLabel && <span className="block text-2xs text-panvas-text-tertiary">{retentionLabel}</span>}
        </span>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        <button
          onClick={onRestore}
          title="Restore"
          aria-label={`Restore ${name}`}
          className="p-1 rounded-md text-panvas-text-tertiary hover:bg-panvas-bg-elevated hover:text-panvas-text-primary transition-colors"
        >
          <RotateCcw size={12} />
        </button>
        {onDelete && (
        <button
          onClick={() => setIsConfirmOpen(true)}
          title="Delete Permanently"
          aria-label={`Delete ${name} permanently`}
          className="p-1 rounded-md text-panvas-text-tertiary hover:bg-panvas-bg-elevated hover:text-panvas-accent-rose transition-colors"
        >
          <X size={12} />
        </button>
        )}
      </div>
      <ConfirmDialog
        open={isConfirmOpen}
        title="Delete this item permanently?"
        description={`“${name}” will be permanently deleted. This action cannot be undone.`}
        confirmLabel="Delete permanently"
        onCancel={() => setIsConfirmOpen(false)}
        onConfirm={async () => {
          await onDelete?.();
          setIsConfirmOpen(false);
        }}
      />
    </div>
  );
}
