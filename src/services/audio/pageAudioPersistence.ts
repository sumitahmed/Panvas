import { createEmptyDrawingData, type AudioNote, type DrawingData, type TextObject } from '../../components/notebook/engine/drawingTypes.ts';
import { isVoiceNoteObject } from './voiceNoteObjects.ts';
import type { PageAudioOwner } from './audioLifecycle.ts';

interface DrawingRepository {
  loadDrawingData(workspaceId: string, notebookId: string, pageId: string): Promise<DrawingData | null | undefined>;
  saveDrawingData(workspaceId: string, notebookId: string, pageId: string, data: DrawingData, searchContext?: PageAudioSearchContext): Promise<void>;
}

export interface PageAudioSearchContext {
  pdfOwnerPageId?: string;
  pdfSourcePage?: number;
}

interface PageQueue {
  tail: Promise<unknown>;
  audioNotes?: AudioNote[];
  voiceObjects?: TextObject[];
}

export function appendAudioNote(data: DrawingData, note: AudioNote): DrawingData {
  const existing = data.audioNotes ?? [];
  if (existing.some(item => item.id === note.id)) return data;
  return { ...data, audioNotes: [...existing.map(item => ({ ...item })), { ...note }] };
}

export function removeAudioNote(data: DrawingData, noteId: string): DrawingData {
  return { ...data, audioNotes: (data.audioNotes ?? []).filter(note => note.id !== noteId).map(note => ({ ...note })) };
}

export function renameAudioNote(data: DrawingData, noteId: string, title: string): DrawingData {
  const normalized = title.trim();
  return {
    ...data,
    audioNotes: (data.audioNotes ?? []).map(note => note.id === noteId
      ? { ...note, title: normalized || undefined }
      : { ...note }),
  };
}

/** Serializes ordinary drawing saves and audio metadata mutations per canonical page. */
export class PageAudioPersistenceCoordinator {
  private readonly repository: DrawingRepository;
  private readonly queues = new Map<string, PageQueue>();

  constructor(repository: DrawingRepository) {
    this.repository = repository;
  }

  saveDrawing(owner: PageAudioOwner, data: DrawingData, searchContext?: PageAudioSearchContext): Promise<DrawingData> {
    return this.enqueue(owner, async queue => {
      const audioNotes = queue.audioNotes ?? data.audioNotes ?? [];
      const noteIds = new Set(audioNotes.map(note => note.id));
      const objects = (data.objects ?? []).filter(object => !isVoiceNoteObject(object) || noteIds.has(object.metadata.audioNoteId));
      for (const object of queue.voiceObjects ?? []) {
        if (!objects.some(item => item.id === object.id) && noteIds.has(String(object.metadata?.audioNoteId))) objects.push(structuredClone(object));
      }
      // Preserve an immutable snapshot and its already computed JSON when no
      // audio merge changed it. Queued audio/voice edits still take the merge path.
      const next = Array.isArray(data.objects) && Array.isArray(data.audioNotes)
        && !audioNotes.length && !queue.voiceObjects?.length && objects.length === data.objects.length
        ? data : { ...data, objects, audioNotes: audioNotes.map(note => ({ ...note })) };
      await this.repository.saveDrawingData(owner.workspaceId, owner.notebookId, owner.pageId, next, searchContext);
      queue.audioNotes = next.audioNotes;
      queue.voiceObjects = (next.objects ?? []).filter(isVoiceNoteObject).map(object => structuredClone(object));
      return next;
    });
  }

  append(owner: PageAudioOwner, note: AudioNote): Promise<DrawingData> {
    return this.mutate(owner, data => appendAudioNote(data, note));
  }

  appendVoiceNote(owner: PageAudioOwner, note: AudioNote, object: TextObject): Promise<DrawingData> {
    return this.mutate(owner, data => ({
      ...appendAudioNote(data, note),
      objects: [...(data.objects ?? []).filter(item => item.id !== object.id), { ...object }],
    }));
  }

  remove(owner: PageAudioOwner, noteId: string): Promise<DrawingData> {
    return this.mutate(owner, data => removeAudioNote(data, noteId));
  }

  rename(owner: PageAudioOwner, noteId: string, title: string): Promise<DrawingData> {
    return this.mutate(owner, data => renameAudioNote(data, noteId, title));
  }

  removeVoiceNote(owner: PageAudioOwner, noteId: string): Promise<DrawingData> {
    return this.mutate(owner, data => ({
      ...removeAudioNote(data, noteId),
      objects: (data.objects ?? []).filter(item => !(isVoiceNoteObject(item) && item.metadata.audioNoteId === noteId)),
    }));
  }

  /** Explicit document command, including undo: replace only this page's voice entities. */
  replaceVoiceState(owner: PageAudioOwner, notes: AudioNote[], objects: TextObject[]): Promise<DrawingData> {
    const snapshot = structuredClone({ notes, objects });
    return this.mutate(owner, data => ({ ...data, audioNotes: snapshot.notes,
      objects: [...(data.objects ?? []).filter(item => !isVoiceNoteObject(item)), ...snapshot.objects],
    }));
  }

  private mutate(owner: PageAudioOwner, update: (data: DrawingData) => DrawingData): Promise<DrawingData> {
    return this.enqueue(owner, async queue => {
      const loaded = await this.repository.loadDrawingData(owner.workspaceId, owner.notebookId, owner.pageId);
      const base = (loaded ?? createEmptyDrawingData()) as DrawingData;
      const current = queue.audioNotes
        ? { ...base, audioNotes: queue.audioNotes.map(note => ({ ...note })) }
        : base;
      const next = update(current);
      await this.repository.saveDrawingData(owner.workspaceId, owner.notebookId, owner.pageId, next);
      queue.audioNotes = (next.audioNotes ?? []).map(note => ({ ...note }));
      queue.voiceObjects = (next.objects ?? []).filter(isVoiceNoteObject).map(object => structuredClone(object));
      return next;
    });
  }

  private enqueue<T>(owner: PageAudioOwner, operation: (queue: PageQueue) => Promise<T>): Promise<T> {
    const key = `${owner.workspaceId}\u0000${owner.notebookId}\u0000${owner.pageId}`;
    const queue = this.queues.get(key) ?? { tail: Promise.resolve() };
    this.queues.set(key, queue);
    const result = queue.tail.catch(() => undefined).then(() => operation(queue));
    queue.tail = result.catch(() => undefined);
    return result;
  }
}
