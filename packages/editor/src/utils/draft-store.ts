import type {
  DocumentId,
  EditorDocumentAdapter,
  LoadedDocument,
  WriteOutcome,
} from "@shaulavo/workbench-core";

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
  saveChain: Promise<void>;
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

export function getDocumentDraft(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
): DocumentDraftEntry | undefined {
  return adapterDraftStores.get(adapter)?.get(documentId);
}

export function isDraftDirty(entry: DocumentDraftEntry): boolean {
  return entry.version !== entry.savedVersion;
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
    saveChain: Promise.resolve(),
  };
  map.set(documentId, entry);
  return entry;
}

/** Replaces a draft entry with authoritative disk content (e.g. "Take theirs" conflict resolution). */
export function replaceDocumentDraftFromDisk(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  doc: LoadedDocument,
): DocumentDraftEntry {
  const map = getAdapterMap(adapter);
  const prev = map.get(documentId);
  const nextVersion = (prev?.version ?? 0) + 1;
  const entry: DocumentDraftEntry = {
    text: doc.text,
    baseText: doc.text,
    revision: doc.revision,
    languageId: doc.languageId,
    byteLength: doc.byteLength,
    readOnly: doc.readOnly,
    version: nextVersion,
    savedVersion: nextVersion,
    reloadSeq: (prev?.reloadSeq ?? 0) + 1,
    saveChain: prev?.saveChain ?? Promise.resolve(),
  };
  map.set(documentId, entry);
  return entry;
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
 * overwrite another document's state or clear dirty status for edits made while a save is pending.
 */
export function persistDocumentDraft(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  forceOverwrite: boolean,
  callbacks: PersistDraftCallbacks,
): Promise<void> {
  const entry = getDocumentDraft(adapter, documentId);
  if (!entry) return Promise.resolve();

  const targetVersion = entry.version;
  const snapshotText = entry.text;

  const runSave = async (): Promise<void> => {
    const expectedRevision = forceOverwrite ? undefined : entry.revision;
    const outcome = await adapter.writeIfUnchanged(documentId, snapshotText, expectedRevision);
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
    callbacks.onSave?.(documentId);
  };

  const next = entry.saveChain.then(runSave, runSave);
  entry.saveChain = next.catch(() => undefined);
  return next;
}
