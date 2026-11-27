import type { DocumentId, EditorDocumentAdapter, LoadedDocument, WriteOutcome } from "../../core/index";

export interface DocumentDraftEntry {
  text: string;
  baseText: string;
  revision: string | undefined;
  languageId?: string;
  byteLength: number;
  readOnly?: boolean;
  version: number;
  savedVersion: number;
  reloadSeq: number;
  /** Incremented whenever authoritative disk content replaces the buffer, invalidating stale queued saves. */
  epoch: number;
  saveChain: Promise<void>;
  readonly listeners: Set<() => void>;
}

const adapterDraftStores = new WeakMap<EditorDocumentAdapter, Map<DocumentId, DocumentDraftEntry>>();

function getAdapterMap(adapter: EditorDocumentAdapter): Map<DocumentId, DocumentDraftEntry> {
  let map = adapterDraftStores.get(adapter);
  if (!map) {
    map = new Map<DocumentId, DocumentDraftEntry>();
    adapterDraftStores.set(adapter, map);
  }
  return map;
}

function notifyEntry(entry: DocumentDraftEntry): void {
  for (const listener of entry.listeners) {
    listener();
  }
}

export function getDocumentDraft(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
): DocumentDraftEntry | undefined {
  return adapterDraftStores.get(adapter)?.get(documentId);
}

export function isDraftDirty(entry: DocumentDraftEntry): boolean {
  return entry.version !== entry.savedVersion;
}

/** Subscribes to authoritative reloads (e.g. "Take theirs") on a shared document draft across split panes. */
export function subscribeDocumentDraft(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  listener: () => void,
): () => void {
  const entry = getDocumentDraft(adapter, documentId);
  if (!entry) return () => undefined;
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

/** Seeds a draft entry from a freshly loaded document if none exists yet. */
export function seedDocumentDraft(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  doc: LoadedDocument,
): DocumentDraftEntry {
  const map = getAdapterMap(adapter);
  const existing = map.get(documentId);
  if (existing) return existing;
  const entry: DocumentDraftEntry = {
    text: doc.text,
    baseText: doc.text,
    revision: doc.revision,
    languageId: doc.languageId,
    byteLength: doc.byteLength,
    readOnly: doc.readOnly,
    version: 0,
    savedVersion: 0,
    reloadSeq: 0,
    epoch: 0,
    saveChain: Promise.resolve(),
    listeners: new Set(),
  };
  map.set(documentId, entry);
  return entry;
}

/**
 * Replaces a draft entry in place with authoritative disk content (e.g. "Take theirs" conflict
 * resolution), invalidating any queued pre-replacement saves and notifying all panes showing this doc.
 */
export function replaceDocumentDraftFromDisk(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  doc: LoadedDocument,
): DocumentDraftEntry {
  const map = getAdapterMap(adapter);
  const existing = map.get(documentId);
  if (!existing) {
    return seedDocumentDraft(adapter, documentId, doc);
  }
  existing.text = doc.text;
  existing.baseText = doc.text;
  existing.revision = doc.revision;
  existing.languageId = doc.languageId;
  existing.byteLength = doc.byteLength;
  existing.readOnly = doc.readOnly;
  existing.version += 1;
  existing.savedVersion = existing.version;
  existing.reloadSeq += 1;
  existing.epoch += 1;
  notifyEntry(existing);
  return existing;
}

/** Records a live buffer edit for `documentId` and returns whether the draft is currently dirty. */
export function recordDocumentEdit(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  nextText: string,
): boolean {
  const entry = getDocumentDraft(adapter, documentId);
  if (!entry) return false;
  if (nextText === entry.text) return isDraftDirty(entry);
  entry.text = nextText;
  entry.byteLength = new TextEncoder().encode(nextText).byteLength;
  entry.version += 1;
  return isDraftDirty(entry);
}

export interface PersistDraftCallbacks {
  readonly onDirtyChange?: (documentId: DocumentId, dirty: boolean) => void;
  readonly onSave?: (documentId: DocumentId) => void;
  readonly onWriteConflict?: (
    documentId: DocumentId,
    outcome: Extract<WriteOutcome, { readonly written: false }>,
  ) => void;
}

/**
 * Serializes saves per `(adapter, documentId)` so overlapping saves or tab switches never
 * overwrite another document's state, clear dirty status for mid-save edits, or write discarded
 * text after a "Take theirs" replacement.
 */
export function persistDocumentDraft(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  forceOverwrite: boolean,
  callbacks: PersistDraftCallbacks,
): Promise<void> {
  const entry = getDocumentDraft(adapter, documentId);
  if (!entry || entry.readOnly) return Promise.resolve();

  const targetVersion = entry.version;
  const snapshotText = entry.text;
  const capturedEpoch = entry.epoch;

  const runSave = async (): Promise<void> => {
    if (entry.epoch !== capturedEpoch) return;
    const expectedRevision = forceOverwrite ? undefined : entry.revision;
    const outcome = await adapter.writeIfUnchanged(documentId, snapshotText, expectedRevision);
    if (entry.epoch !== capturedEpoch) return;
    if (!outcome.written) {
      callbacks.onWriteConflict?.(documentId, outcome);
      return;
    }
    entry.revision = outcome.nextRevision;
    entry.baseText = snapshotText;
    if (targetVersion > entry.savedVersion) {
      entry.savedVersion = targetVersion;
    }
    callbacks.onDirtyChange?.(documentId, isDraftDirty(entry));
    await adapter.save(documentId);
    if (entry.epoch !== capturedEpoch) return;
    callbacks.onSave?.(documentId);
  };

  const next = entry.saveChain.then(runSave, runSave);
  entry.saveChain = next.catch(() => undefined);
  return next;
}
