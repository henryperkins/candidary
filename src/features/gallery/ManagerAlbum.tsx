import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  ImageOff,
  Link,
  Plus,
  Star,
  X,
} from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { ClientApiError, mediaPreview } from '../../app/api';
import type { ExportDownloadView, ExportView } from '../../app/types';
import { AutosaveStatus, autosaveStatusText } from '../../components/AutosaveStatus';
import { ErrorState, LoadingState, describeLoadFailure } from '../../components/States';
import type { LoadFailure } from '../../components/States';
import {
  ALBUM_DESCRIPTION_MAX_LENGTH,
  ALBUM_MAX_ENTRIES,
  ALBUM_MAX_SECTIONS,
  ALBUM_SECTION_HEADING_MAX_LENGTH,
  ALBUM_TITLE_MAX_LENGTH,
} from '../../../shared/constants';
import type {
  AlbumEntryView,
  AlbumMetadataInput,
  AlbumShareStatus,
  AlbumView,
} from '../../../shared/contracts';
import {
  fetchAlbum,
  moveEntryTo,
  saveAlbumOrder,
  setAlbumPicks,
  startAlbum,
  toEntryInput,
} from './album-api';
import { AlbumPreview } from './AlbumPreview';
import { AlbumExportControl } from './AlbumExportControl';
import { fetchAlbumShare, shareAlbum, stopAlbumShare } from './album-share-api';
import { galleryPhotoTitle } from './gallery-timeline';
import {
  AUTOSAVE_DEBOUNCE_MS,
  createAutosaveQueue,
  type AutosaveQueue,
  type AutosaveState,
  type DomainAutosaveState,
} from '../settings/autosave-queue';
import { UndoBar, useUndo } from './undo';

interface ManagerAlbumProps {
  eventId: string;
  active: boolean;
  onGoToLibrary(): void;
  /** Raised whenever membership changes here, so Library's `Album picks (n)` stays true. */
  onPicksChanged(): void;
  exportJob?: ExportView;
  activeExport?: ExportView;
  exportDownload?: ExportDownloadView;
  onPrepareExport(): Promise<void>;
  onDownloadExport(job: ExportView): Promise<void>;
  onRetryExport(job: ExportView): Promise<void>;
  onAutosaveStateChange?(state: DomainAutosaveState): void;
  onAccessFailure?(failure: LoadFailure | null): void;
  onAnnouncement?(message: string): void;
}

export interface ManagerAlbumHandle {
  prepareToLeave(): Promise<boolean>;
}

type AlbumDraft = {
  entries: AlbumEntryView[];
  title: string;
  description: string;
  coverMediaId: string | null;
};

const INITIAL_DRAFT: AlbumDraft = {
  entries: [],
  title: 'Album',
  description: '',
  coverMediaId: null,
};

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

function entryKey(entry: AlbumEntryView): string {
  return entry.kind === 'section' ? `section:${entry.id}` : `photo:${entry.photo.id}`;
}

function entryName(entry: AlbumEntryView): string {
  return entry.kind === 'section' ? entry.heading : galleryPhotoTitle(entry.photo);
}

function draftFromAlbum(album: AlbumView): AlbumDraft {
  return {
    entries: album.entries,
    title: album.title,
    description: album.description,
    coverMediaId: album.coverMediaId,
  };
}

function canonicalDraft(draft: AlbumDraft): AlbumDraft {
  return {
    ...draft,
    title: draft.title.trim(),
    entries: draft.entries.map((entry) => (
      entry.kind === 'section' ? { ...entry, heading: entry.heading.trim() } : entry
    )),
  };
}

function draftMetadata(draft: AlbumDraft): AlbumMetadataInput {
  return {
    title: draft.title,
    description: draft.description,
    coverMediaId: draft.coverMediaId,
  };
}

function draftKey(draft: AlbumDraft): string {
  const canonical = canonicalDraft(draft);
  return JSON.stringify({
    entries: toEntryInput(canonical.entries),
    metadata: draftMetadata(canonical),
  });
}

function draftIntent(draft: AlbumDraft): string {
  return JSON.stringify({
    entries: toEntryInput(draft.entries),
    title: draft.title,
    description: draft.description,
    coverMediaId: draft.coverMediaId,
  });
}

function titleIsInvalid(draft: AlbumDraft): boolean {
  return draft.title.trim().length === 0;
}

function clampCodePoints(value: string, maximum: number): string {
  const points = Array.from(value);
  return points.length <= maximum ? value : points.slice(0, maximum).join('');
}

interface RemovedEntryContext {
  entry: AlbumEntryView;
  previousKey: string | null;
  nextKey: string | null;
  index: number;
}

function removedEntryContext(entries: readonly AlbumEntryView[], key: string): RemovedEntryContext | null {
  const index = entries.findIndex((entry) => entryKey(entry) === key);
  const entry = entries[index];
  if (!entry) return null;
  return {
    entry,
    previousKey: index > 0 ? entryKey(entries[index - 1]!) : null,
    nextKey: index + 1 < entries.length ? entryKey(entries[index + 1]!) : null,
    index,
  };
}

function restoreEntry(entries: readonly AlbumEntryView[], context: RemovedEntryContext): AlbumEntryView[] {
  const key = entryKey(context.entry);
  if (entries.some((entry) => entryKey(entry) === key)) return [...entries];
  const nextIndex = context.nextKey
    ? entries.findIndex((entry) => entryKey(entry) === context.nextKey)
    : -1;
  if (nextIndex >= 0) return [...entries.slice(0, nextIndex), context.entry, ...entries.slice(nextIndex)];
  const previousIndex = context.previousKey
    ? entries.findIndex((entry) => entryKey(entry) === context.previousKey)
    : -1;
  const insertion = previousIndex >= 0
    ? previousIndex + 1
    : Math.min(context.index, entries.length);
  return [...entries.slice(0, insertion), context.entry, ...entries.slice(insertion)];
}

type AnchorPreference = 'previous' | 'next';

type AlbumIntentOperation =
  | { kind: 'set-title'; value: string }
  | { kind: 'set-description'; value: string }
  | { kind: 'set-cover'; value: string | null }
  | {
      kind: 'move-entry';
      key: string;
      entry: AlbumEntryView;
      previousKey: string | null;
      nextKey: string | null;
      prefer: AnchorPreference;
    }
  | {
      kind: 'insert-entry';
      entry: AlbumEntryView;
      previousKey: string | null;
      nextKey: string | null;
      prefer: AnchorPreference;
    }
  | { kind: 'remove-entry'; key: string }
  | {
      kind: 'rename-section';
      section: Extract<AlbumEntryView, { kind: 'section' }>;
      previousKey: string | null;
      nextKey: string | null;
      prefer: AnchorPreference;
    }
  | { kind: 'reset-entries' }
  | { kind: 'replace-draft'; draft: AlbumDraft };

interface JournalledAlbumOperation {
  cursor: number;
  operation: AlbumIntentOperation;
}

interface AlbumQueueSnapshot {
  draft: AlbumDraft;
  operationCursor: number;
}

interface RejectedAlbumDraft {
  snapshot: AlbumQueueSnapshot;
  intent: string;
}

function livePhotoIds(entries: readonly AlbumEntryView[]): Set<string> {
  return new Set(entries.flatMap((entry) => (
    entry.kind === 'photo' ? [entry.photo.id] : []
  )));
}

function normalizeDraftCover(draft: AlbumDraft): AlbumDraft {
  return {
    ...draft,
    coverMediaId: draft.coverMediaId && livePhotoIds(draft.entries).has(draft.coverMediaId)
      ? draft.coverMediaId
      : null,
  };
}

function anchoredEntry(
  entries: readonly AlbumEntryView[],
  entry: AlbumEntryView,
  previousKey: string | null,
  nextKey: string | null,
  prefer: AnchorPreference,
): AlbumEntryView[] {
  const key = entryKey(entry);
  const without = entries.filter((candidate) => entryKey(candidate) !== key);
  const previousIndex = previousKey
    ? without.findIndex((candidate) => entryKey(candidate) === previousKey)
    : -1;
  const nextIndex = nextKey
    ? without.findIndex((candidate) => entryKey(candidate) === nextKey)
    : -1;
  const insertion = prefer === 'previous'
    ? previousIndex >= 0 ? previousIndex + 1 : nextIndex >= 0 ? nextIndex : without.length
    : nextIndex >= 0 ? nextIndex : previousIndex >= 0 ? previousIndex + 1 : 0;
  return [...without.slice(0, insertion), entry, ...without.slice(insertion)];
}

function mergeReplacementEntries(
  requested: readonly AlbumEntryView[],
  canonical: readonly AlbumEntryView[],
): AlbumEntryView[] {
  const canonicalPhotos = new Map(canonical.flatMap((entry) => (
    entry.kind === 'photo' ? [[entry.photo.id, entry] as const] : []
  )));
  const placed = new Set<string>();
  let entries = requested.flatMap((entry): AlbumEntryView[] => {
    const key = entryKey(entry);
    if (placed.has(key)) return [];
    if (entry.kind === 'photo') {
      const live = canonicalPhotos.get(entry.photo.id);
      if (!live) return [];
      placed.add(key);
      return [live];
    }
    placed.add(key);
    return [entry];
  });
  for (let index = 0; index < canonical.length; index += 1) {
    const entry = canonical[index]!;
    const key = entryKey(entry);
    if (placed.has(key)) continue;
    const previousKey = canonical
      .slice(0, index)
      .reverse()
      .map(entryKey)
      .find((candidate) => placed.has(candidate)) ?? null;
    const nextKey = canonical
      .slice(index + 1)
      .map(entryKey)
      .find((candidate) => placed.has(candidate)) ?? null;
    entries = anchoredEntry(entries, entry, previousKey, nextKey, previousKey ? 'previous' : 'next');
    placed.add(key);
  }
  return entries;
}

/** Replays recorded actions, never an inferred array diff, over the trusted GET. */
function replayAlbumOperations(
  canonicalAlbum: AlbumView,
  operations: readonly JournalledAlbumOperation[],
): AlbumDraft {
  const canonical = draftFromAlbum(canonicalAlbum);
  const canonicalPhotos = new Map(canonical.entries.flatMap((entry) => (
    entry.kind === 'photo' ? [[entry.photo.id, entry] as const] : []
  )));
  let next = canonical;
  for (const { operation } of operations) {
    switch (operation.kind) {
      case 'set-title':
        next = { ...next, title: operation.value };
        break;
      case 'set-description':
        next = { ...next, description: operation.value };
        break;
      case 'set-cover':
        next = {
          ...next,
          coverMediaId: operation.value && livePhotoIds(next.entries).has(operation.value)
            ? operation.value
            : null,
        };
        break;
      case 'move-entry': {
        const existing = next.entries.find((entry) => entryKey(entry) === operation.key);
        const entry = existing
          ?? (operation.entry.kind === 'photo'
            ? canonicalPhotos.get(operation.entry.photo.id)
            : operation.entry);
        if (entry) next = {
          ...next,
          entries: anchoredEntry(
            next.entries,
            entry,
            operation.previousKey,
            operation.nextKey,
            operation.prefer,
          ),
        };
        break;
      }
      case 'insert-entry': {
        const entry = operation.entry.kind === 'photo'
          ? canonicalPhotos.get(operation.entry.photo.id)
          : operation.entry;
        if (entry) next = {
          ...next,
          entries: anchoredEntry(
            next.entries,
            entry,
            operation.previousKey,
            operation.nextKey,
            operation.prefer,
          ),
        };
        break;
      }
      case 'remove-entry':
        next = normalizeDraftCover({
          ...next,
          entries: next.entries.filter((entry) => entryKey(entry) !== operation.key),
        });
        break;
      case 'rename-section': {
        const existing = next.entries.some((entry) => (
          entry.kind === 'section' && entry.id === operation.section.id
        ));
        next = {
          ...next,
          entries: existing
            ? next.entries.map((entry) => (
              entry.kind === 'section' && entry.id === operation.section.id
                ? { ...entry, heading: operation.section.heading }
                : entry
            ))
            : anchoredEntry(
              next.entries,
              operation.section,
              operation.previousKey,
              operation.nextKey,
              operation.prefer,
            ),
        };
        break;
      }
      case 'reset-entries':
        next = normalizeDraftCover({
          ...next,
          entries: next.entries
            .filter((entry): entry is Extract<AlbumEntryView, { kind: 'photo' }> => (
              entry.kind === 'photo'
            ))
            .sort((left, right) => (
              left.photo.timelineAt.localeCompare(right.photo.timelineAt)
              || left.photo.id.localeCompare(right.photo.id)
            )),
        });
        break;
      case 'replace-draft':
        next = normalizeDraftCover({
          ...operation.draft,
          entries: mergeReplacementEntries(operation.draft.entries, canonical.entries),
        });
        break;
    }
  }
  return normalizeDraftCover(next);
}

function mergeCanonicalMembership(current: AlbumDraft, canonical: AlbumView): AlbumDraft {
  const canonicalPhotos = new Map(canonical.entries.flatMap((entry) => (
    entry.kind === 'photo' ? [[entry.photo.id, entry] as const] : []
  )));
  const placed = new Set<string>();
  const entries = current.entries.flatMap((entry): AlbumEntryView[] => {
    if (entry.kind === 'section') return [entry];
    const live = canonicalPhotos.get(entry.photo.id);
    if (!live) return [];
    placed.add(entry.photo.id);
    return [live];
  });
  for (const entry of canonical.entries) {
    if (entry.kind === 'photo' && !placed.has(entry.photo.id)) entries.push(entry);
  }
  const liveIds = new Set(canonicalPhotos.keys());
  return {
    ...current,
    entries,
    coverMediaId: current.coverMediaId && liveIds.has(current.coverMediaId)
      ? current.coverMediaId
      : null,
  };
}

/**
 * One album draft and one revision stream. Every editor action enters the same
 * serialized queue; exits consume its settled state before they can observe or
 * snapshot the album.
 */
export const ManagerAlbum = forwardRef<ManagerAlbumHandle, ManagerAlbumProps>(function ManagerAlbum({
  eventId,
  active,
  onGoToLibrary,
  onPicksChanged,
  exportJob,
  activeExport,
  exportDownload,
  onPrepareExport,
  onDownloadExport,
  onRetryExport,
  onAutosaveStateChange,
  onAccessFailure,
  onAnnouncement,
}, ref) {
  const [album, setAlbum] = useState<AlbumView | null>(null);
  const [draft, setDraft] = useState<AlbumDraft>(INITIAL_DRAFT);
  const [autosave, setAutosave] = useState<AutosaveState>({ status: 'saved', failure: null });
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [starting, setStarting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [share, setShare] = useState<AlbumShareStatus>(null);
  const [sharePending, setSharePending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyUnavailable, setCopyUnavailable] = useState(false);
  const [recoveryFocusRequest, setRecoveryFocusRequest] = useState(0);
  const [pendingPickIds, setPendingPickIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingOperationCount, setPendingOperationCount] = useState(0);
  const [failedPreviewIds, setFailedPreviewIds] = useState<ReadonlySet<string>>(() => new Set());
  const [reconciliationFailure, setReconciliationFailure] = useState<LoadFailure | null>(null);

  const undo = useUndo();
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const draftRef = useRef<AlbumDraft>(INITIAL_DRAFT);
  const revisionRef = useRef(0);
  const loadGeneration = useRef(0);
  const loadFailureRef = useRef<LoadFailure | null>(null);
  const hasLoaded = useRef(false);
  const conflictEpoch = useRef(0);
  const dragKey = useRef<string | null>(null);
  const refocusKey = useRef<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  const copyPending = useRef<number | null>(null);
  const shareCredentialGeneration = useRef(0);
  const shareRequestGeneration = useRef(0);
  const shareOperationPending = useRef(false);
  const draftGeneration = useRef(0);
  const canonicalTrusted = useRef(true);
  const reconciliationFailureRef = useRef<LoadFailure | null>(null);
  const pendingOperations = useRef(new Set<Promise<unknown>>());
  const coverIntentGeneration = useRef(0);
  const operationCursor = useRef(0);
  const operationJournal = useRef<JournalledAlbumOperation[]>([]);
  const loadCanonicalRef = useRef<((rejected: RejectedAlbumDraft) => Promise<AlbumView>) | null>(null);
  const queueRef = useRef<AutosaveQueue<AlbumQueueSnapshot> | null>(null);

  if (queueRef.current === null) {
    queueRef.current = createAutosaveQueue<AlbumQueueSnapshot>({
      baselineKey: 'album:not-loaded',
      debounceMs: AUTOSAVE_DEBOUNCE_MS,
      async save(snapshot, sent) {
        const sentDraft = snapshot.draft;
        try {
          const result = await saveAlbumOrder(
            eventId,
            revisionRef.current,
            toEntryInput(sentDraft.entries),
            draftMetadata(sentDraft),
          );
          // This assignment is synchronous and happens before the queue can start
          // a coalesced successor from the resolved outcome.
          revisionRef.current = result.album.revision;
          operationJournal.current = operationJournal.current.filter(
            ({ cursor }) => cursor > snapshot.operationCursor,
          );
          setAlbum(result.album);
          if (draftIntent(draftRef.current) === sent.intent) {
            const confirmed = draftFromAlbum(result.album);
            draftGeneration.current += 1;
            draftRef.current = confirmed;
            setDraft(confirmed);
          }
          return { status: 'confirmed', key: draftKey(draftFromAlbum(result.album)) };
        } catch (caught) {
          if (!(caught instanceof ClientApiError) || caught.code !== 'REVISION_CONFLICT') throw caught;
          conflictEpoch.current += 1;
          setNotice(caught.message);
          queueRef.current?.discardPending();
          const current = await loadCanonicalRef.current?.({ snapshot, intent: sent.intent });
          if (!current) throw caught;
          return { status: 'confirmed', key: draftKey(draftFromAlbum(current)) };
        }
      },
      describeFailure(caught) {
        const failure = describeLoadFailure(caught, 'manager', 'The album could not be saved.');
        setNotice(failure.message);
        return {
          message: failure.message,
          retryable: failure.retryable,
          ...(failure.retryable ? {} : { escalation: failure }),
        };
      },
      onChange: setAutosave,
    });
  }
  const queue = queueRef.current;

  const adoptCanonical = useCallback((next: AlbumView, resetQueue = false) => {
    const nextDraft = draftFromAlbum(next);
    if (resetQueue) queue.discardPending();
    revisionRef.current = next.revision;
    draftGeneration.current += 1;
    draftRef.current = nextDraft;
    setAlbum(next);
    setDraft(nextDraft);
    operationJournal.current = [];
    canonicalTrusted.current = true;
    reconciliationFailureRef.current = null;
    setReconciliationFailure(null);
    queue.adoptBaseline(draftKey(nextDraft));
  }, [queue]);

  const loadCanonical = useCallback((signal?: AbortSignal) => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    loadFailureRef.current = null;
    setLoadFailure(null);
    onAccessFailure?.(null);
    return fetchAlbum(eventId, signal).then((result) => {
      if (generation !== loadGeneration.current) return result.album;
      hasLoaded.current = true;
      loadFailureRef.current = null;
      onAccessFailure?.(null);
      adoptCanonical(result.album, true);
      return result.album;
    }).catch((caught: unknown) => {
      if (generation === loadGeneration.current
        && !(caught instanceof DOMException && caught.name === 'AbortError')) {
        const failure = describeLoadFailure(caught, 'manager', 'The album could not be loaded.');
        loadFailureRef.current = failure;
        setLoadFailure(failure);
        if (!failure.retryable) onAccessFailure?.(failure);
      }
      throw caught;
    }).finally(() => {
      if (generation === loadGeneration.current) setLoading(false);
    });
  }, [adoptCanonical, eventId, onAccessFailure]);
  const reloadAfterConflict = useCallback(async (rejected: RejectedAlbumDraft) => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    loadFailureRef.current = null;
    setLoadFailure(null);
    onAccessFailure?.(null);
    try {
      const result = await fetchAlbum(eventId);
      if (generation !== loadGeneration.current) return result.album;
      hasLoaded.current = true;
      const canonical = draftFromAlbum(result.album);
      revisionRef.current = result.album.revision;
      canonicalTrusted.current = true;
      reconciliationFailureRef.current = null;
      setReconciliationFailure(null);
      setAlbum(result.album);
      queue.adoptBaseline(draftKey(canonical));
      const replay = operationJournal.current.filter(
        ({ cursor }) => cursor > rejected.snapshot.operationCursor,
      );
      operationJournal.current = replay;
      if (replay.length === 0) {
        draftGeneration.current += 1;
        draftRef.current = canonical;
        setDraft(canonical);
      } else {
        const rebased = replayAlbumOperations(result.album, replay);
        draftGeneration.current += 1;
        draftRef.current = rebased;
        setDraft(rebased);
        const snapshot = canonicalDraft(rebased);
        queue.submit({
          // A changed-away-and-back operation can produce the rejected payload's
          // exact key. The conflict did not commit it, so this successor still has
          // to enter the serialized queue rather than dedupe against the in-flight
          // request that is about to resolve.
          key: `conflict:${conflictEpoch.current}:${draftKey(snapshot)}`,
          intent: draftIntent(rebased),
          snapshot: titleIsInvalid(rebased) ? null : {
            draft: snapshot,
            operationCursor: operationCursor.current,
          },
        }, true);
      }
      return result.album;
    } catch (caught) {
      if (generation === loadGeneration.current) {
        const failure = describeLoadFailure(caught, 'manager', 'The album could not be loaded.');
        loadFailureRef.current = failure;
        setLoadFailure(failure);
        if (!failure.retryable) onAccessFailure?.(failure);
      }
      throw caught;
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [eventId, onAccessFailure, queue]);
  loadCanonicalRef.current = reloadAfterConflict;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const shareGeneration = ++shareRequestGeneration.current;
    void loadCanonical(controller.signal).catch(() => {});
    void fetchAlbumShare(eventId, controller.signal).then(
      (result) => {
        if (shareGeneration === shareRequestGeneration.current) setShare(result.share);
      },
      (caught: unknown) => {
        if (shareGeneration === shareRequestGeneration.current
          && !(caught instanceof DOMException && caught.name === 'AbortError')) {
          setNotice(errorMessage(caught, 'The album sharing status could not be loaded.'));
        }
      },
    );
    return () => controller.abort();
  }, [active, eventId, loadCanonical]);

  useEffect(() => () => {
    queue.dispose();
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, [queue]);

  useEffect(() => {
    if (copyTimer.current !== null) {
      window.clearTimeout(copyTimer.current);
      copyTimer.current = null;
    }
    shareCredentialGeneration.current += 1;
    copyPending.current = null;
    setCopied(false);
    setCopyUnavailable(false);
  }, [share?.url]);

  useEffect(() => {
    const blockingField = titleIsInvalid(draft)
      ? { label: 'Album title', message: 'Give this album a title.' }
      : null;
    const accessFailure = reconciliationFailure ?? loadFailure;
    const state = accessFailure
      ? {
          status: 'failed' as const,
          failure: {
            message: accessFailure.message,
            retryable: accessFailure.retryable,
            ...(accessFailure.retryable ? {} : { escalation: accessFailure }),
          },
        }
      : (loading || pendingOperationCount > 0) && autosave.status === 'saved'
        ? { status: 'saving' as const, failure: null }
        : autosave;
    onAutosaveStateChange?.({
      domain: 'album',
      label: 'Album',
      status: state.status,
      failure: state.failure,
      blockingField,
    });
    const text = autosaveStatusText('Album', state, blockingField);
    onAnnouncement?.(text.announcement);
  }, [autosave, draft.title, loadFailure, loading, onAnnouncement, onAutosaveStateChange, pendingOperationCount, reconciliationFailure]);

  useEffect(() => {
    if (announcement) onAnnouncement?.(announcement);
  }, [announcement, onAnnouncement]);

  useEffect(() => {
    if (undo.error) onAnnouncement?.(undo.error);
  }, [onAnnouncement, undo.error]);

  function recordOperations(operations: readonly AlbumIntentOperation[]) {
    for (const operation of operations) {
      operationCursor.current += 1;
      operationJournal.current.push({ cursor: operationCursor.current, operation });
    }
  }

  function applyDraft(
    next: AlbumDraft,
    immediate = false,
    operations: readonly AlbumIntentOperation[] = [],
  ) {
    recordOperations(operations);
    draftGeneration.current += 1;
    draftRef.current = next;
    setDraft(next);
    const canonical = canonicalDraft(next);
    queue.submit({
      key: draftKey(canonical),
      intent: draftIntent(next),
      snapshot: titleIsInvalid(next) ? null : {
        draft: canonical,
        operationCursor: operationCursor.current,
      },
    }, immediate);
  }

  function trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    const running = operation();
    pendingOperations.current.add(running);
    setPendingOperationCount(pendingOperations.current.size);
    void running.finally(() => {
      pendingOperations.current.delete(running);
      setPendingOperationCount(pendingOperations.current.size);
    }).catch(() => {});
    return running;
  }

  async function confirmUndoPersistence(
    beforeConflict: number,
    fallback: string,
    requireTrustedCanonical = true,
  ) {
    queue.flush();
    const state = await queue.waitForSettled();
    if (
      state.status !== 'saved'
      || conflictEpoch.current !== beforeConflict
      || loadFailureRef.current !== null
      || (requireTrustedCanonical && !canonicalTrusted.current)
    ) {
      const message = state.failure?.message
        ?? reconciliationFailureRef.current?.message
        ?? loadFailureRef.current?.message
        ?? fallback;
      focusBlockingRecovery(state);
      throw new Error(message);
    }
  }

  function focusBlockingRecovery(state: AutosaveState) {
    if (state.status === 'invalid') {
      titleRef.current?.focus();
      return;
    }
    if (reconciliationFailureRef.current?.retryable) {
      setNotice(reconciliationFailureRef.current.message);
      setRecoveryFocusRequest((current) => current + 1);
      return;
    }
    if (reconciliationFailureRef.current && !reconciliationFailureRef.current.retryable) {
      onAccessFailure?.(reconciliationFailureRef.current);
      return;
    }
    if (state.failure?.escalation) {
      onAccessFailure?.(state.failure.escalation);
      return;
    }
    if (loadFailureRef.current && !loadFailureRef.current.retryable) {
      onAccessFailure?.(loadFailureRef.current);
      return;
    }
    if (state.status === 'failed' || loadFailureRef.current !== null) {
      setRecoveryFocusRequest((current) => current + 1);
    }
  }

  useEffect(() => {
    if (recoveryFocusRequest === 0) return;
    const recovery = rootRef.current
      ?.querySelector<HTMLElement>('[aria-label="Retry album refresh"], [aria-label="Retry album"], .state-card button');
    if (!recovery) return;
    recovery.focus();
  }, [recoveryFocusRequest]);

  const settleDraft = useCallback(async () => {
    const beforeConflict = conflictEpoch.current;
    queue.flush();
    while (pendingOperations.current.size > 0) {
      await Promise.allSettled([...pendingOperations.current]);
    }
    queue.flush();
    const state = await queue.waitForSettled();
    const ready = state.status === 'saved'
      && conflictEpoch.current === beforeConflict
      && loadFailureRef.current === null
      && canonicalTrusted.current;
    if (!ready) focusBlockingRecovery(state);
    return ready;
  }, [queue]);

  useImperativeHandle(ref, () => ({ prepareToLeave: settleDraft }), [settleDraft]);

  useEffect(() => {
    const key = refocusKey.current;
    if (!key) return;
    refocusKey.current = null;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-entry-key="${CSS.escape(key)}"] .album-entry__move-earlier`)
      ?.focus();
  }, [draft.entries]);

  function move(from: number, to: number) {
    const entry = draftRef.current.entries[from];
    if (!entry || from === to || to < 0 || to >= draftRef.current.entries.length) return;
    const entries = moveEntryTo(draftRef.current.entries, from, to);
    const context = removedEntryContext(entries, entryKey(entry));
    if (!context) return;
    refocusKey.current = entryKey(entry);
    applyDraft({ ...draftRef.current, entries }, false, [{
      kind: 'move-entry',
      key: entryKey(entry),
      entry,
      previousKey: context.previousKey,
      nextKey: context.nextKey,
      prefer: from < to ? 'previous' : 'next',
    }]);
    setAnnouncement(`Moved to position ${to + 1} of ${entries.length}.`);
  }

  function addSection() {
    const current = draftRef.current;
    if (current.entries.length >= ALBUM_MAX_ENTRIES) {
      setNotice(`An album holds up to ${ALBUM_MAX_ENTRIES} photos and sections.`);
      return;
    }
    if (current.entries.filter((entry) => entry.kind === 'section').length >= ALBUM_MAX_SECTIONS) {
      setNotice(`An album holds up to ${ALBUM_MAX_SECTIONS} sections.`);
      return;
    }
    const section: AlbumEntryView = {
      kind: 'section',
      id: crypto.randomUUID(),
      heading: 'New section',
    };
    const entries = [...current.entries, section];
    const context = removedEntryContext(entries, entryKey(section));
    applyDraft({ ...current, entries }, false, context ? [{
      kind: 'insert-entry',
      entry: section,
      previousKey: context.previousKey,
      nextKey: context.nextKey,
      prefer: 'previous',
    }] : []);
    setAnnouncement('Section added at the end.');
    window.requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLInputElement>(`[data-entry-key="${CSS.escape(entryKey(section))}"] input`)
        ?.select();
    });
  }

  function renameSection(id: string, heading: string) {
    const current = draftRef.current;
    const section = current.entries.find((entry) => entry.kind === 'section' && entry.id === id);
    const context = removedEntryContext(current.entries, `section:${id}`);
    if (!section || section.kind !== 'section' || !context || section.heading === heading) return;
    const next = {
      ...current,
      entries: current.entries.map((entry) => (
        entry.kind === 'section' && entry.id === id ? { ...entry, heading } : entry
      )),
    };
    recordOperations([{
      kind: 'rename-section',
      section: { ...section, heading },
      previousKey: context.previousKey,
      nextKey: context.nextKey,
      prefer: context.previousKey ? 'previous' : 'next',
    }]);
    draftGeneration.current += 1;
    draftRef.current = next;
    setDraft(next);
  }

  function commitSectionName(id: string) {
    const current = draftRef.current;
    const section = current.entries.find((entry) => entry.kind === 'section' && entry.id === id);
    if (!section || section.kind !== 'section') return;
    const heading = section.heading.trim() || 'New section';
    const context = removedEntryContext(current.entries, `section:${id}`);
    applyDraft({
      ...current,
      entries: current.entries.map((entry) => (
        entry.kind === 'section' && entry.id === id ? { ...entry, heading } : entry
      )),
    }, false, heading === section.heading || !context ? [] : [{
      kind: 'rename-section',
      section: { ...section, heading },
      previousKey: context.previousKey,
      nextKey: context.nextKey,
      prefer: context.previousKey ? 'previous' : 'next',
    }]);
  }

  function removeSection(id: string) {
    const before = draftRef.current;
    const context = removedEntryContext(before.entries, `section:${id}`);
    if (!context) return;
    const nextEntries = before.entries.filter((entry) => entry.kind !== 'section' || entry.id !== id);
    if (nextEntries.length === before.entries.length) return;
    applyDraft({ ...before, entries: nextEntries }, false, [{
      kind: 'remove-entry',
      key: `section:${id}`,
    }]);
    setAnnouncement('Section removed.');
    undo.present({
      message: 'Section removed.',
      run: async () => {
        const beforeConflict = conflictEpoch.current;
        const current = draftRef.current;
        const entries = restoreEntry(current.entries, context);
        const restored = removedEntryContext(entries, entryKey(context.entry));
        applyDraft({ ...current, entries }, true, restored ? [{
          kind: 'insert-entry',
          entry: context.entry,
          previousKey: restored.previousKey,
          nextKey: restored.nextKey,
          prefer: context.nextKey ? 'next' : 'previous',
        }] : []);
        await confirmUndoPersistence(beforeConflict, 'The section could not be restored. Try Undo again.');
        setAnnouncement('Change undone.');
      },
    });
  }

  function resetOrder() {
    const before = draftRef.current;
    const photos = before.entries
      .filter((entry): entry is Extract<AlbumEntryView, { kind: 'photo' }> => entry.kind === 'photo')
      .sort((left, right) => (
        left.photo.timelineAt.localeCompare(right.photo.timelineAt)
        || left.photo.id.localeCompare(right.photo.id)
      ));
    const liveIds = new Set(photos.map((entry) => entry.photo.id));
    applyDraft({
      ...before,
      entries: photos,
      coverMediaId: before.coverMediaId && liveIds.has(before.coverMediaId)
        ? before.coverMediaId
        : null,
    }, false, [{ kind: 'reset-entries' }]);
    const message = 'Album order reset to the timeline. Sections were removed.';
    setAnnouncement(message);
    undo.present({
      message,
      run: async () => {
        const beforeConflict = conflictEpoch.current;
        applyDraft(before, true, [{ kind: 'replace-draft', draft: before }]);
        await confirmUndoPersistence(beforeConflict, 'The album order could not be restored. Try Undo again.');
        setAnnouncement('Change undone.');
      },
    });
  }

  async function refreshAfterMembership(fallback: string) {
    for (;;) {
      queue.flush();
      await queue.waitForSettled();
      const generation = draftGeneration.current;
      let refreshed: { album: AlbumView };
      try {
        refreshed = await fetchAlbum(eventId);
      } catch (caught) {
        const classified = describeLoadFailure(caught, 'manager', fallback);
        const failure = classified.retryable ? { ...classified, message: fallback } : classified;
        canonicalTrusted.current = false;
        reconciliationFailureRef.current = failure;
        setReconciliationFailure(failure);
        if (!failure.retryable) onAccessFailure?.(failure);
        setNotice(fallback);
        return false;
      }
      if (generation !== draftGeneration.current || !['saved', 'failed', 'invalid'].includes(queue.state().status)) {
        continue;
      }
      if (queue.state().status === 'saved') {
        adoptCanonical(refreshed.album);
      } else {
        const merged = mergeCanonicalMembership(draftRef.current, refreshed.album);
        revisionRef.current = refreshed.album.revision;
        setAlbum(refreshed.album);
        draftGeneration.current += 1;
        draftRef.current = merged;
        setDraft(merged);
      }
      canonicalTrusted.current = true;
      reconciliationFailureRef.current = null;
      setReconciliationFailure(null);
      setNotice(null);
      onAccessFailure?.(null);
      return true;
    }
  }

  async function retryMembershipRefresh() {
    const failure = reconciliationFailureRef.current;
    if (!failure?.retryable) return;
    await trackOperation(() => refreshAfterMembership(failure.message));
  }

  async function removePhoto(entry: Extract<AlbumEntryView, { kind: 'photo' }>) {
    const photoId = entry.photo.id;
    if (pendingPickIds.has(photoId)) return;
    const before = draftRef.current;
    const context = removedEntryContext(before.entries, `photo:${photoId}`);
    if (!context) return;
    const restoreExplicitCover = before.coverMediaId === photoId;
    const coverIntentAtRemoval = coverIntentGeneration.current;
    setPendingPickIds((current) => new Set(current).add(photoId));
    try {
      await setAlbumPicks(eventId, [photoId], false);
      canonicalTrusted.current = false;
      const current = draftRef.current;
      const next: AlbumDraft = {
        ...current,
        entries: current.entries.filter((item) => item.kind !== 'photo' || item.photo.id !== photoId),
        coverMediaId: current.coverMediaId === photoId ? null : current.coverMediaId,
      };
      applyDraft(next, true, [{ kind: 'remove-entry', key: `photo:${photoId}` }]);
      const title = galleryPhotoTitle(entry.photo);
      const message = '1 photo removed from the album. The original is still delivered.';
      setAnnouncement(message);
      undo.present({
        message,
        run: () => trackOperation(async () => {
          const beforeConflict = conflictEpoch.current;
          await setAlbumPicks(eventId, [photoId], true);
          canonicalTrusted.current = false;
          const latest = draftRef.current;
          const entries = restoreEntry(latest.entries, context);
          const coverMediaId = restoreExplicitCover
            && coverIntentGeneration.current === coverIntentAtRemoval
            && latest.coverMediaId === null
            ? photoId
            : latest.coverMediaId;
          const restored = removedEntryContext(entries, entryKey(context.entry));
          const operations: AlbumIntentOperation[] = restored ? [{
            kind: 'insert-entry',
            entry: context.entry,
            previousKey: restored.previousKey,
            nextKey: restored.nextKey,
            prefer: context.nextKey ? 'next' : 'previous',
          }] : [];
          if (coverMediaId !== latest.coverMediaId) {
            operations.push({ kind: 'set-cover', value: coverMediaId });
          }
          applyDraft({
            ...latest,
            entries,
            coverMediaId,
          }, true, operations);
          await confirmUndoPersistence(beforeConflict, 'The photo could not be restored. Try Undo again.', false);
          const refreshed = await refreshAfterMembership('The photo is back, but the album could not be refreshed. Try again in a moment.');
          if (!refreshed || !canonicalTrusted.current || conflictEpoch.current !== beforeConflict) {
            throw new Error(reconciliationFailureRef.current?.message
              ?? 'The restored album is not confirmed yet. Try Undo again.');
          }
          onPicksChanged();
          setAnnouncement(`${title} is back in the album.`);
        }),
      });
      await queue.waitForSettled();
      await refreshAfterMembership('The photo was removed, but the album could not be refreshed. Use Undo or try again in a moment.');
      onPicksChanged();
    } catch (caught) {
      setNotice(errorMessage(caught, 'That photo could not be removed from the album.'));
    } finally {
      setPendingPickIds((current) => {
        const next = new Set(current);
        next.delete(photoId);
        return next;
      });
    }
  }

  async function choose(start: 'from-picks' | 'empty') {
    if (starting) return;
    const before = draftRef.current;
    setStarting(true);
    try {
      const result = await startAlbum(eventId, start);
      adoptCanonical(result.album, true);
      onPicksChanged();
      if (start === 'empty') {
        const message = 'The album starts empty. The hearts were cleared.';
        setAnnouncement(message);
        undo.present({
          message,
          run: () => trackOperation(async () => {
            const beforeConflict = conflictEpoch.current;
            await setAlbumPicks(eventId, result.cleared, true);
            canonicalTrusted.current = false;
            onPicksChanged();
            const latest = draftRef.current;
            let restoredEntries = latest.entries;
            for (const entry of before.entries) {
              if (entry.kind !== 'photo' || !result.cleared.includes(entry.photo.id)) continue;
              const context = removedEntryContext(before.entries, entryKey(entry));
              if (context) restoredEntries = restoreEntry(restoredEntries, context);
            }
            const restored: AlbumDraft = {
              ...latest,
              entries: restoredEntries,
              coverMediaId: latest.coverMediaId ?? before.coverMediaId,
            };
            applyDraft(restored, true, [{ kind: 'replace-draft', draft: restored }]);
            await confirmUndoPersistence(beforeConflict, 'The album picks could not be restored. Try Undo again.', false);
            const refreshed = await refreshAfterMembership('The hearts are back, but the album could not be refreshed.');
            if (!refreshed || !canonicalTrusted.current || conflictEpoch.current !== beforeConflict) {
              throw new Error(reconciliationFailureRef.current?.message
                ?? 'The restored album is not confirmed yet. Try Undo again.');
            }
            setAnnouncement('Change undone.');
          }),
        });
      } else {
        setAnnouncement(`The album starts from ${result.album.photoCount} favorited photo${result.album.photoCount === 1 ? '' : 's'}.`);
      }
    } catch (caught) {
      setNotice(errorMessage(caught, 'The album could not be started.'));
    } finally {
      setStarting(false);
    }
  }

  async function togglePreview() {
    if (!(await settleDraft())) return;
    setPreviewOpen((current) => !current);
  }

  async function toggleShare() {
    if (shareOperationPending.current) return;
    const activeShare = share;
    if (!activeShare && !(await settleDraft())) return;
    if (shareOperationPending.current) return;
    const operationGeneration = ++shareRequestGeneration.current;
    shareOperationPending.current = true;
    setSharePending(true);
    try {
      if (activeShare) {
        await stopAlbumShare(eventId);
        if (operationGeneration === shareRequestGeneration.current) setShare(null);
        setAnnouncement('Album sharing stopped.');
      } else {
        const result = await shareAlbum(eventId);
        if (operationGeneration === shareRequestGeneration.current) setShare(result.share);
        setAnnouncement('Album link is ready.');
      }
      setNotice(null);
    } catch (caught) {
      setNotice(errorMessage(caught, activeShare ? 'Album sharing could not be stopped.' : 'The album could not be shared.'));
    } finally {
      shareOperationPending.current = false;
      setSharePending(false);
    }
  }

  async function copyShareLink() {
    if (!share || copyPending.current !== null) return;
    const credentialGeneration = shareCredentialGeneration.current;
    copyPending.current = credentialGeneration;
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    setCopied(false);
    setCopyUnavailable(false);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(share.url);
      if (credentialGeneration !== shareCredentialGeneration.current) return;
      setCopied(true);
      setAnnouncement('Album link copied.');
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        if (credentialGeneration === shareCredentialGeneration.current) setCopied(false);
      }, 2_200);
    } catch {
      if (credentialGeneration !== shareCredentialGeneration.current) return;
      setCopyUnavailable(true);
      setAnnouncement('Copy unavailable. Select the album link instead.');
    } finally {
      if (copyPending.current === credentialGeneration) copyPending.current = null;
    }
  }

  const prepareAlbumExport = useCallback(async () => {
    if (!(await settleDraft())) return;
    await onPrepareExport();
  }, [onPrepareExport, settleDraft]);

  if (loading && !hasLoaded.current) return <LoadingState label="Opening the album…" live={false} />;
  if (loadFailure) {
    return <div className="gallery-album" ref={rootRef}>
      <ErrorState
        message={loadFailure.message}
        recoveryHint={loadFailure.recoveryHint}
        onRetry={loadFailure.retryable ? () => { void loadCanonical(); } : undefined}
      />
    </div>;
  }

  const photos = draft.entries.filter(
    (entry): entry is Extract<AlbumEntryView, { kind: 'photo' }> => entry.kind === 'photo',
  );
  const photoCount = photos.length;
  const explicitCover = draft.coverMediaId
    ? photos.find((entry) => entry.photo.id === draft.coverMediaId)?.photo ?? null
    : null;
  const effectiveCover = explicitCover ?? photos[0]?.photo ?? null;
  const effectiveCoverId = effectiveCover?.id ?? null;
  const needsReconciliation = album !== null && !album.saved && photoCount > 0;
  const invalidTitle = titleIsInvalid(draft);

  let photoPosition = 0;
  return <div className="gallery-album" ref={rootRef}>
    {notice && <div className="manager-action-error" role="alert">
      <div className="manager-action-error__summary">
        <div className="manager-action-error__alert">
          {notice}
          {reconciliationFailure?.retryable && <button
            type="button"
            className="text-button manager-action-error__retry"
            aria-label="Retry album refresh"
            onClick={() => { void retryMembershipRefresh(); }}
          >Try again</button>}
        </div>
        <button
          type="button"
          className="manager-action-error__dismiss"
          aria-label="Dismiss error"
          onClick={() => setNotice(null)}
        >Dismiss</button>
      </div>
    </div>}

    {needsReconciliation
      ? <>
          <p className="album-not-started">Not started yet</p>
          <section className="album-reconcile" aria-labelledby="album-reconcile-title">
            <p className="section-label">Before albums, there were favorites</p>
            <h3 id="album-reconcile-title">
              {photoCount} photo{photoCount === 1 ? ' was' : 's were'} favorited before this album existed.
            </h3>
            <p>
              Album picks are the same hearts you already used, so this album can start from them —
              in the order the photos arrived, with the first as the cover. Nothing is published
              either way, and you can add or remove photos afterwards.
            </p>
            <div className="album-reconcile__actions">
              <button
                type="button"
                className="button button--primary"
                disabled={starting}
                onClick={() => { void trackOperation(() => choose('from-picks')); }}
              >Start the album from {photoCount === 1 ? 'it' : 'them'}</button>
              <button
                type="button"
                className="button button--secondary"
                disabled={starting}
                onClick={() => { void trackOperation(() => choose('empty')); }}
              >Start empty</button>
            </div>
            <small>Starting empty clears the hearts on those photos. It never deletes a photo.</small>
          </section>
        </>
      : <>
          <div className="album-autosave-row">
            <AutosaveStatus
              label="Album"
              state={autosave}
              blockingField={invalidTitle ? { label: 'Album title', message: 'Give this album a title.' } : null}
              onRetry={() => applyDraft(draftRef.current, true)}
              live={false}
            />
            <span>{photoCount} photo{photoCount === 1 ? '' : 's'} in the album</span>
          </div>

          {previewOpen
            ? <AlbumPreview entries={draft.entries} title={draft.title.trim()} description={draft.description} />
            : <div className="album-editor">
                <section className="album-metadata" aria-label="Album details">
                  <div className="album-cover">
                    {effectiveCover
                      ? failedPreviewIds.has(effectiveCover.id)
                        ? <div
                            className="album-cover__placeholder"
                            role="img"
                            aria-label={`Album cover: ${galleryPhotoTitle(effectiveCover)}, from ${effectiveCover.guestName}`}
                          ><ImageOff aria-hidden="true" /><span>Preview unavailable</span></div>
                        : <img
                            className="album-cover__image"
                            src={mediaPreview(effectiveCover.id)}
                            alt={`Album cover: ${galleryPhotoTitle(effectiveCover)}`}
                            onError={() => setFailedPreviewIds((current) => new Set(current).add(effectiveCover.id))}
                          />
                      : <div className="album-cover__placeholder"><span>Nothing to show yet</span></div>}
                    <small>{effectiveCover
                      ? `${explicitCover ? 'Cover · ' : 'Cover · first photo, until you star another · '}${galleryPhotoTitle(effectiveCover)}`
                      : 'The first photo becomes the cover.'}</small>
                    {explicitCover && <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        coverIntentGeneration.current += 1;
                        applyDraft(
                          { ...draftRef.current, coverMediaId: null },
                          false,
                          [{ kind: 'set-cover', value: null }],
                        );
                        setAnnouncement('The first photo is the album cover.');
                      }}
                    >Use the first photo instead</button>}
                  </div>

                  <div className="album-metadata__fields">
                    <label htmlFor="album-title">Album title</label>
                    <input
                      id="album-title"
                      ref={titleRef}
                      value={draft.title}
                      aria-invalid={invalidTitle}
                      aria-describedby={invalidTitle ? 'album-title-error' : undefined}
                      onChange={(change) => {
                        const title = clampCodePoints(change.target.value, ALBUM_TITLE_MAX_LENGTH);
                        applyDraft(
                          { ...draftRef.current, title },
                          false,
                          [{ kind: 'set-title', value: title }],
                        );
                      }}
                      onBlur={() => {
                        const current = draftRef.current;
                        const trimmed = current.title.trim();
                        if (trimmed && trimmed !== current.title) {
                          applyDraft(
                            { ...current, title: trimmed },
                            false,
                            [{ kind: 'set-title', value: trimmed }],
                          );
                        }
                        queue.flush();
                      }}
                    />
                    {invalidTitle && <small className="field-error" id="album-title-error">Give this album a title.</small>}
                    <label htmlFor="album-description">Description</label>
                    <textarea
                      id="album-description"
                      rows={2}
                      value={draft.description}
                      onChange={(change) => {
                        const description = clampCodePoints(
                          change.target.value,
                          ALBUM_DESCRIPTION_MAX_LENGTH,
                        );
                        applyDraft(
                          { ...draftRef.current, description },
                          false,
                          [{ kind: 'set-description', value: description }],
                        );
                      }}
                      onBlur={() => queue.flush()}
                    />
                    <small>Guests see this only if you share the album. It is optional.</small>
                  </div>
                </section>

                <header className="album-order-heading">
                  <h3 className="section-label">The order guests will see</h3>
                  <button type="button" className="button button--secondary" onClick={addSection}>
                    <Plus aria-hidden="true" /> Add a section
                  </button>
                  <button type="button" className="text-button" onClick={resetOrder}>
                    Reset to timeline order
                  </button>
                </header>

                {draft.entries.length === 0
                  ? <div className="empty-state">
                      <h3>The album is empty.</h3>
                      <p>Pick photos in Library. A pick adds the photo to this album for every host on this event. It does not publish it.</p>
                      <button type="button" className="button button--secondary" onClick={onGoToLibrary}>Go to Library</button>
                    </div>
                  : <ol className="album-review-grid" ref={listRef}>
                      {draft.entries.map((entry, index) => {
                        const key = entryKey(entry);
                        const name = entryName(entry);
                        if (entry.kind === 'photo') photoPosition += 1;
                        const position = photoPosition;
                        const isCover = entry.kind === 'photo' && entry.photo.id === effectiveCoverId;
                        const previewFailed = entry.kind === 'photo'
                          && failedPreviewIds.has(entry.photo.id);
                        return <li
                          key={key}
                          data-entry-key={key}
                          className={entry.kind === 'section'
                            ? 'album-review-grid__section'
                            : 'album-review-grid__photo'}
                          draggable
                          onDragStart={(dragEvent) => {
                            dragKey.current = key;
                            if (dragEvent.dataTransfer) {
                              dragEvent.dataTransfer.effectAllowed = 'move';
                              dragEvent.dataTransfer.setData('text/plain', key);
                            }
                          }}
                          onDragOver={(dragEvent) => dragEvent.preventDefault()}
                          onDrop={(dropEvent) => {
                            dropEvent.preventDefault();
                            const sourceKey = dragKey.current;
                            dragKey.current = null;
                            if (!sourceKey) return;
                            const currentEntries = draftRef.current.entries;
                            const from = currentEntries.findIndex((item) => entryKey(item) === sourceKey);
                            const to = currentEntries.findIndex((item) => entryKey(item) === key);
                            if (from >= 0 && to >= 0) move(from, to);
                          }}
                          onDragEnd={(dragEvent) => {
                            dragKey.current = null;
                            dragEvent.dataTransfer?.clearData();
                          }}
                        >
                          {entry.kind === 'section'
                            ? <>
                                <span className="album-section__marker" aria-hidden="true" />
                                <input
                                  className="album-section__input"
                                  aria-label="Section name"
                                  value={entry.heading}
                                  onChange={(change) => renameSection(
                                    entry.id,
                                    clampCodePoints(change.target.value, ALBUM_SECTION_HEADING_MAX_LENGTH),
                                  )}
                                  onBlur={() => commitSectionName(entry.id)}
                                  onKeyDown={(pressed) => {
                                    if (pressed.key === 'Enter') {
                                      pressed.preventDefault();
                                      pressed.currentTarget.blur();
                                    }
                                  }}
                                />
                                <span className="album-section__rule" aria-hidden="true" />
                              </>
                            : <>
                                <div className="album-review-grid__preview">
                                  {entry.photo.previewAvailable && !previewFailed
                                    ? <img
                                        src={mediaPreview(entry.photo.id)}
                                        alt=""
                                        loading={position <= 6 ? 'eager' : 'lazy'}
                                        decoding="async"
                                        onError={() => setFailedPreviewIds((current) => (
                                          new Set(current).add(entry.photo.id)
                                        ))}
                                      />
                                    : <div
                                        className="album-review-grid__fallback"
                                        role="img"
                                        aria-label={`${name}, from ${entry.photo.guestName}`}
                                      ><ImageOff aria-hidden="true" /><span>Preview unavailable</span></div>}
                                  <span className="album-review-grid__number" data-testid="album-photo-position">{position}</span>
                                  {isCover && <span className="album-review-grid__cover-badge">Cover</span>}
                                </div>
                                <span className="album-review-grid__meta">
                                  <strong>{name}</strong>
                                  <small>From {entry.photo.guestName}</small>
                                </span>
                              </>}

                          <span className="album-entry__controls">
                            <button
                              type="button"
                              className="icon-button album-entry__move-earlier"
                              disabled={index === 0}
                              aria-label={`Move ${name} earlier`}
                              onClick={() => move(index, index - 1)}
                            >{entry.kind === 'section'
                              ? <ChevronUp aria-hidden="true" />
                              : <ChevronLeft aria-hidden="true" />}</button>
                            <button
                              type="button"
                              className="icon-button album-entry__move-later"
                              disabled={index === draft.entries.length - 1}
                              aria-label={`Move ${name} later`}
                              onClick={() => move(index, index + 1)}
                            >{entry.kind === 'section'
                              ? <ChevronDown aria-hidden="true" />
                              : <ChevronRight aria-hidden="true" />}</button>
                            {entry.kind === 'photo' && <button
                              type="button"
                              className="icon-button album-entry__cover"
                              aria-label={isCover
                                ? `${name} is the album cover`
                                : `Use ${name} as the album cover`}
                              aria-pressed={isCover}
                              onClick={() => {
                                coverIntentGeneration.current += 1;
                                applyDraft(
                                  { ...draftRef.current, coverMediaId: entry.photo.id },
                                  false,
                                  [{ kind: 'set-cover', value: entry.photo.id }],
                                );
                                setAnnouncement(`${name} is the album cover.`);
                              }}
                            ><Star aria-hidden="true" /></button>}
                            <button
                              type="button"
                              className="icon-button album-entry__remove"
                              disabled={entry.kind === 'photo' && pendingPickIds.has(entry.photo.id)}
                              aria-label={entry.kind === 'section'
                                ? `Remove section ${name}`
                                : `Remove ${name} from the album`}
                              onClick={() => {
                                if (entry.kind === 'section') removeSection(entry.id);
                                else void trackOperation(() => removePhoto(entry));
                              }}
                            ><X aria-hidden="true" /></button>
                          </span>
                        </li>;
                      })}
                    </ol>}
              </div>}

          <section className="album-exits" aria-labelledby="album-exits-title">
            <p className="section-label" id="album-exits-title">When the album is right</p>
            <div className="album-exits__controls">
              <button
                type="button"
                className="button button--secondary"
                disabled={photoCount === 0}
                onClick={() => { void togglePreview(); }}
              ><Eye aria-hidden="true" /> {previewOpen ? 'Back to editing' : 'Preview album'}</button>
              <button
                type="button"
                className="button button--secondary"
                disabled={(!share && photoCount === 0) || sharePending}
                onClick={() => { void toggleShare(); }}
              ><Link aria-hidden="true" /> {share
                ? 'Stop sharing album'
                : sharePending ? 'Sharing album…' : 'Share album'}</button>
              <AlbumExportControl
                photoCount={photoCount}
                totalBytes={album?.totalBytes ?? 0}
                job={exportJob}
                activeJob={activeExport}
                download={exportDownload}
                onPrepare={prepareAlbumExport}
                onDownload={onDownloadExport}
                onRetry={onRetryExport}
                live={false}
                onAnnouncement={onAnnouncement}
              />
            </div>

            {share && <div className="album-share">
              <p>Anyone holding this link can see the album. It does not change what the shared gallery shows.</p>
              <div className="album-share__link">
                <code tabIndex={0}>{share.url}</code>
                <button type="button" className="button button--secondary" onClick={() => { void copyShareLink(); }}>
                  {copied ? 'Copied' : 'Copy album link'}
                </button>
              </div>
              {copyUnavailable && <small className="album-share__error">
                Copy unavailable. Select the link instead.
              </small>}
            </div>}
          </section>
        </>}

    <UndoBar controller={undo} live={false} />
  </div>;
});
