import {
  createAnchorSelection,
  createEditorTextBuffer,
  createSelectionSet,
  pieceTableSnapshotsHaveSameText,
  type DocumentTextSnapshot,
  type EditorTextBuffer,
  type EditorTextBufferChange,
  type PieceTableSnapshot,
  type TextEdit,
} from "@singapore-editor/core/document";
import type { DocumentId, EditorDocumentAdapter, LoadedDocument, WriteOutcome } from "../../core/index";

export interface DocumentDraftEntry {
  readonly buffer: EditorTextBuffer;
  revision: string | undefined;
  languageId?: string;
  byteLength: number;
  readOnly?: boolean;
  savedSnapshot: PieceTableSnapshot;
  savedRevision: number;
  reloadSeq: number;
  /** Incremented whenever authoritative disk content replaces the buffer, invalidating stale queued saves. */
  epoch: number;
  resolvingConflict: boolean;
  replacingFromDisk: boolean;
  saveChain: Promise<void>;
  unsubBuffer: (() => void) | null;
}

interface AdapterDraftStore {
  readonly entries: Map<DocumentId, DocumentDraftEntry>;
  readonly listenersByDoc: Map<DocumentId, Set<() => void>>;
}

interface ExpandedEditWindow {
  readonly bStart: number;
  bEnd: number;
  readonly aStart: number;
  aEnd: number;
}

const adapterDraftStores = new WeakMap<EditorDocumentAdapter, AdapterDraftStore>();

function getAdapterStore(adapter: EditorDocumentAdapter): AdapterDraftStore {
  let store = adapterDraftStores.get(adapter);
  if (!store) {
    store = {
      entries: new Map<DocumentId, DocumentDraftEntry>(),
      listenersByDoc: new Map<DocumentId, Set<() => void>>(),
    };
    adapterDraftStores.set(adapter, store);
  }
  return store;
}

function notifyDoc(store: AdapterDraftStore, documentId: DocumentId): void {
  const listeners = store.listenersByDoc.get(documentId);
  if (!listeners) return;
  for (const listener of listeners) {
    listener();
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Computes exact UTF-8 byte length matching TextEncoder (including 3-byte U+FFFD for unpaired surrogates). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
      continue;
    }
    if (code <= 0x7ff) {
      bytes += 2;
      continue;
    }
    if (isHighSurrogate(code) && i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i += 1;
      continue;
    }
    bytes += 3;
  }
  return bytes;
}

function resolveDocByteLength(doc: LoadedDocument): number {
  if (typeof doc.byteLength === "number" && Number.isFinite(doc.byteLength) && doc.byteLength >= 0) {
    return doc.byteLength;
  }
  return utf8ByteLength(doc.text);
}

/**
 * Computes exact incremental UTF-8 byte-length delta across a batch of edits without reading the
 * full document. Expands edit boundaries by 1 UTF-16 code unit whenever a boundary touches a
 * pairing surrogate (`0xD800-0xDBFF` on the left, `0xDC00-0xDFFF` on the right) and merges
 * overlapping windows so split or joined astral surrogate pairs are always measured accurately.
 */
export function computeIncrementalUtf8Delta(
  before: DocumentTextSnapshot,
  after: DocumentTextSnapshot,
  edits: readonly TextEdit[],
): number {
  if (edits.length === 0) return 0;
  const sorted = edits.toSorted((a, b) => a.from - b.from);
  const windows: ExpandedEditWindow[] = [];
  let cumDelta = 0;

  for (const edit of sorted) {
    const padLeft =
      edit.from > 0 && isHighSurrogate(before.readRange(edit.from - 1, edit.from).charCodeAt(0)) ? 1 : 0;
    const padRight =
      edit.to < before.length && isLowSurrogate(before.readRange(edit.to, edit.to + 1).charCodeAt(0)) ? 1 : 0;
    const bStart = edit.from - padLeft;
    const bEnd = edit.to + padRight;
    const aStart = edit.from + cumDelta - padLeft;
    const aEnd = edit.from + cumDelta + edit.text.length + padRight;
    cumDelta += edit.text.length - (edit.to - edit.from);

    const prev = windows.at(-1);
    if (prev && (bStart <= prev.bEnd || aStart <= prev.aEnd)) {
      prev.bEnd = Math.max(prev.bEnd, bEnd);
      prev.aEnd = Math.max(prev.aEnd, aEnd);
    } else {
      windows.push({ bStart, bEnd, aStart, aEnd });
    }
  }

  let byteDelta = 0;
  for (const window of windows) {
    const beforeSlice = before.readRange(window.bStart, window.bEnd);
    const afterSlice = after.readRange(window.aStart, window.aEnd);
    byteDelta += utf8ByteLength(afterSlice) - utf8ByteLength(beforeSlice);
  }
  return byteDelta;
}

export function getDocumentDraft(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
): DocumentDraftEntry | undefined {
  return adapterDraftStores.get(adapter)?.entries.get(documentId);
}

/**
 * Returns whether the shared live `EditorTextBuffer` currently differs from its last acknowledged
 * saved checkpoint (`savedSnapshot`), handling undo back to a saved checkpoint even when newer
 * edits arrived during an async save.
 */
export function isDraftDirty(entry: DocumentDraftEntry): boolean {
  const current = entry.buffer.getSnapshot();
  if (current === entry.savedSnapshot) return false;
  return !pieceTableSnapshotsHaveSameText(current, entry.savedSnapshot);
}

/**
 * Subscribes to draft lifecycle changes (initial seed, buffer edits, dirty transitions, saves,
 * conflict-resolution lock changes, and authoritative disk reloads) for `(adapter, documentId)`.
 */
export function subscribeDocumentDraft(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  listener: () => void,
): () => void {
  const store = getAdapterStore(adapter);
  let listeners = store.listenersByDoc.get(documentId);
  if (!listeners) {
    listeners = new Set();
    store.listenersByDoc.set(documentId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      store.listenersByDoc.delete(documentId);
    }
  };
}

function attachBufferSubscription(
  store: AdapterDraftStore,
  documentId: DocumentId,
  entry: DocumentDraftEntry,
): void {
  entry.unsubBuffer?.();
  entry.unsubBuffer = entry.buffer.subscribe((event: EditorTextBufferChange) => {
    if (entry.replacingFromDisk) return;
    if (event.change.edits.length === 0) return;
    const delta = computeIncrementalUtf8Delta(
      event.textSnapshotBefore,
      event.change.textSnapshot,
      event.change.edits,
    );
    entry.byteLength = Math.max(0, entry.byteLength + delta);
    if (!isDraftDirty(entry) && entry.buffer.isDirty()) {
      entry.buffer.markClean();
    }
    notifyDoc(store, documentId);
  });
}

/** Seeds a shared live-buffer draft entry from a freshly loaded document if none exists yet. */
export function seedDocumentDraft(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  doc: LoadedDocument,
): DocumentDraftEntry {
  const store = getAdapterStore(adapter);
  const existing = store.entries.get(documentId);
  if (existing) return existing;

  const buffer = createEditorTextBuffer(doc.text);
  buffer.markClean();
  const entry: DocumentDraftEntry = {
    buffer,
    revision: doc.revision,
    languageId: doc.languageId,
    byteLength: resolveDocByteLength(doc),
    readOnly: doc.readOnly,
    savedSnapshot: buffer.getSnapshot(),
    savedRevision: buffer.getRevision(),
    reloadSeq: 0,
    epoch: 0,
    resolvingConflict: false,
    replacingFromDisk: false,
    saveChain: Promise.resolve(),
    unsubBuffer: null,
  };
  attachBufferSubscription(store, documentId, entry);
  store.entries.set(documentId, entry);
  notifyDoc(store, documentId);
  return entry;
}

function replaceBufferFromDisk(
  store: AdapterDraftStore,
  documentId: DocumentId,
  entry: DocumentDraftEntry,
  doc: LoadedDocument,
  bumpEpoch: boolean,
): DocumentDraftEntry {
  entry.replacingFromDisk = true;
  try {
    const snapshot = entry.buffer.getSnapshot();
    const currentLength = snapshot.length;
    if (currentLength > 0 || doc.text.length > 0) {
      const selection = createSelectionSet([createAnchorSelection(snapshot, 0, 0)]);
      entry.buffer.applyEdits(selection, [{ from: 0, to: currentLength, text: doc.text }], {
        history: "skip",
        origin: "external",
      });
    }
    entry.buffer.clearHistory();
    entry.buffer.markClean();
    entry.revision = doc.revision;
    entry.languageId = doc.languageId;
    entry.byteLength = resolveDocByteLength(doc);
    entry.readOnly = doc.readOnly;
    entry.savedSnapshot = entry.buffer.getSnapshot();
    entry.savedRevision = entry.buffer.getRevision();
    entry.reloadSeq += 1;
    if (bumpEpoch) {
      entry.epoch += 1;
    }
  } finally {
    entry.replacingFromDisk = false;
  }
  notifyDoc(store, documentId);
  return entry;
}

/**
 * Replaces a draft entry's shared `EditorTextBuffer` in place with authoritative disk content,
 * invalidating any queued pre-replacement saves and notifying all panes showing this document.
 */
export function replaceDocumentDraftFromDisk(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  doc: LoadedDocument,
): DocumentDraftEntry {
  const store = getAdapterStore(adapter);
  const existing = store.entries.get(documentId);
  if (!existing) {
    return seedDocumentDraft(adapter, documentId, doc);
  }
  return replaceBufferFromDisk(store, documentId, existing, doc, true);
}

export interface PersistDraftCallbacks {
  readonly onDirtyChange?: (documentId: DocumentId, dirty: boolean) => void;
  readonly onSave?: (documentId: DocumentId) => void;
  readonly onWriteConflict?: (
    documentId: DocumentId,
    outcome: Extract<WriteOutcome, { readonly written: false }>,
  ) => void;
}

async function executeSave(
  store: AdapterDraftStore,
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  entry: DocumentDraftEntry,
  capturedEpoch: number,
  forceOverwrite: boolean,
  callbacks: PersistDraftCallbacks,
): Promise<void> {
  if (entry.epoch !== capturedEpoch || entry.readOnly) return;
  entry.buffer.breakTypingRun();
  const targetRevision = entry.buffer.getRevision();
  const targetSnapshot = entry.buffer.getSnapshot();
  const snapshotText = entry.buffer.materializeFullText();
  entry.byteLength = utf8ByteLength(snapshotText);
  const expectedRevision = forceOverwrite ? undefined : entry.revision;
  const outcome = await adapter.writeIfUnchanged(documentId, snapshotText, expectedRevision);
  if (entry.epoch !== capturedEpoch) return;
  if (!outcome.written) {
    callbacks.onWriteConflict?.(documentId, outcome);
    return;
  }
  entry.revision = outcome.nextRevision;
  await adapter.save(documentId);
  if (entry.epoch !== capturedEpoch) return;
  entry.savedSnapshot = targetSnapshot;
  if (targetRevision > entry.savedRevision) {
    entry.savedRevision = targetRevision;
  }
  if (entry.buffer.getRevision() === targetRevision) {
    entry.buffer.markClean();
  }
  const dirtyNow = isDraftDirty(entry);
  callbacks.onDirtyChange?.(documentId, dirtyNow);
  notifyDoc(store, documentId);
  callbacks.onSave?.(documentId);
}

/**
 * Serializes saves per `(adapter, documentId)` on the shared live `EditorTextBuffer`.
 * Captures `epoch` at enqueue time so queued saves invalidated by "Take theirs" skip cleanly,
 * calls `buffer.breakTypingRun()` before writing so mid-save edits start a fresh undo transaction,
 * materializes full text once per save, and only advances the clean checkpoint after `adapter.save()`
 * resolves (retaining `entry.revision = outcome.nextRevision` if `adapter.save()` rejects).
 */
export function persistDocumentDraft(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  forceOverwrite: boolean,
  callbacks: PersistDraftCallbacks,
): Promise<void> {
  const store = getAdapterStore(adapter);
  const entry = store.entries.get(documentId);
  if (!entry || entry.readOnly) return Promise.resolve();

  const capturedEpoch = entry.epoch;
  const runSave = (): Promise<void> =>
    executeSave(store, adapter, documentId, entry, capturedEpoch, forceOverwrite, callbacks);

  const next = entry.saveChain.then(runSave, runSave);
  entry.saveChain = next.catch(() => undefined);
  return next;
}

/**
 * Serializes conflict resolution across all panes showing `(adapter, documentId)`.
 * - `"take-theirs"` increments `entry.epoch` BEFORE chaining onto `saveChain` so queued saves
 *   never write while any already-in-flight write finishes before the disk reload replaces the buffer.
 * - `"keep-mine"` chains onto `saveChain`, invokes `adapter.resolveConflict("keep-mine")`, and
 *   runs a forced overwrite write preserving all save/dirty/conflict callbacks.
 */
export function resolveDocumentConflict(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  choice: "keep-mine" | "take-theirs",
  callbacks: PersistDraftCallbacks = {},
): Promise<void> {
  if (!adapter.resolveConflict) return Promise.resolve();
  const store = getAdapterStore(adapter);
  const entry = store.entries.get(documentId);
  if (!entry || entry.resolvingConflict) return Promise.resolve();
  if (choice === "keep-mine" && entry.readOnly) return Promise.resolve();

  entry.resolvingConflict = true;
  if (choice === "take-theirs") {
    entry.epoch += 1;
  }
  const capturedEpoch = entry.epoch;
  notifyDoc(store, documentId);

  const runResolution = async (): Promise<void> => {
    try {
      if (choice === "take-theirs") {
        await adapter.resolveConflict?.(documentId, "take-theirs");
        const fresh = await adapter.loadDocument(documentId);
        if (fresh && entry.epoch === capturedEpoch) {
          replaceBufferFromDisk(store, documentId, entry, fresh, false);
          callbacks.onDirtyChange?.(documentId, false);
        }
        return;
      }
      if (entry.epoch !== capturedEpoch || entry.readOnly) return;
      await adapter.resolveConflict?.(documentId, "keep-mine");
      if (entry.epoch !== capturedEpoch || entry.readOnly) return;
      await executeSave(store, adapter, documentId, entry, capturedEpoch, true, callbacks);
    } finally {
      entry.resolvingConflict = false;
      notifyDoc(store, documentId);
    }
  };

  const next = entry.saveChain.then(runResolution, runResolution);
  entry.saveChain = next.catch(() => undefined);
  return next;
}
