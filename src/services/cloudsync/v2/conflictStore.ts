import Dexie, { type Table } from 'dexie';
import type { SyncV2ConflictStore, SyncV2MigrationConflict } from './types.ts';

class SyncV2ConflictDB extends Dexie {
  conflicts!: Table<SyncV2MigrationConflict>;

  constructor() {
    super('panvas-sync-v2');
    this.version(1).stores({ conflicts: 'conflictId, profileId, workspaceId, resolvedAt, createdAt' });
  }
}

let conflictDBInstance: SyncV2ConflictDB | null = null;
const memoryRows = new Map<string, SyncV2MigrationConflict>();

function getDB(): SyncV2ConflictDB | null {
  if (typeof indexedDB === 'undefined') return null;
  if (!conflictDBInstance) {
    try {
      conflictDBInstance = new SyncV2ConflictDB();
    } catch {
      return null;
    }
  }
  return conflictDBInstance;
}

export const dexieSyncV2ConflictStore: SyncV2ConflictStore = {
  async preserve(conflict) {
    const db = getDB();
    if (db) {
      try {
        if (await db.conflicts.get(conflict.conflictId)) return 'present';
        await db.conflicts.put(conflict);
        return 'created';
      } catch {
        // Fall back to in-memory below
      }
    }
    if (memoryRows.has(conflict.conflictId)) return 'present';
    memoryRows.set(conflict.conflictId, structuredClone(conflict));
    return 'created';
  },
  async hasUnresolved(profileId?: string) {
    const db = getDB();
    if (db) {
      try {
        if (profileId) {
          return (await db.conflicts.where('profileId').equals(profileId).filter(item => item.resolvedAt === null).count()) > 0;
        }
        return (await db.conflicts.filter(item => item.resolvedAt === null).count()) > 0;
      } catch {
        // Fall back to in-memory below
      }
    }
    return [...memoryRows.values()].some(row => (!profileId || row.profileId === profileId) && row.resolvedAt === null);
  },
  async listUnresolved(profileId?: string) {
    const db = getDB();
    if (db) {
      try {
        if (profileId) {
          return await db.conflicts.where('profileId').equals(profileId).filter(item => item.resolvedAt === null).toArray();
        }
        return await db.conflicts.filter(item => item.resolvedAt === null).toArray();
      } catch {
        // Fall back to in-memory below
      }
    }
    return [...memoryRows.values()].filter(row => (!profileId || row.profileId === profileId) && row.resolvedAt === null);
  },
  async resolve(conflictId, profileId) {
    const db = getDB();
    if (db) {
      try {
        const conflict = await db.conflicts.get(conflictId);
        if (!conflict || (profileId && conflict.profileId !== profileId) || conflict.resolvedAt !== null) return false;
        await db.conflicts.update(conflictId, { resolvedAt: Date.now() });
        return true;
      } catch {
        // Fall back to in-memory below
      }
    }
    const conflict = memoryRows.get(conflictId);
    if (!conflict || (profileId && conflict.profileId !== profileId) || conflict.resolvedAt !== null) return false;
    conflict.resolvedAt = Date.now();
    return true;
  },
  async remove(conflictId: string) {
    const db = getDB();
    if (db) {
      try {
        await db.conflicts.delete(conflictId);
      } catch {
        // Fall back to memory
      }
    }
    memoryRows.delete(conflictId);
  },
  async clear() {
    const db = getDB();
    if (db) {
      try {
        await db.conflicts.clear();
      } catch {
        // Fall back to memory
      }
    }
    memoryRows.clear();
  },
};
