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
  Trash2,
  X,
} from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal, flushSync } from 'react-dom';

import { ClientApiError, mediaPreview } from '../../app/api';
import { useDeadlineClock } from '../../app/use-deadline-clock';
import {
  formatRetentionDate,
  TIME_UNAVAILABLE,
  type EventTimeDisplay,
} from '../../app/event-date-time';
import type { ExportDownloadView, ExportView } from '../../app/types';
import { AutosaveStatus, autosaveStatusText } from '../../components/AutosaveStatus';
import { CopyableLinkCard } from '../../components/CopyableLinkCard';
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
  AlbumRetainedSlotView,
  AlbumShareStatus,
  AlbumView,
} from '../../../shared/contracts';
import {
  fetchAlbum,
  moveEntryTo,
  runAlbumInverse,
  saveAlbumOrder,
  setAlbumPicks,
  startAlbum,
  toEntryInput,
  type AlbumInversePayload,
  type AlbumInverseState,
  type AlbumStartRequest,
} from './album-api';
import { AlbumPreview } from './AlbumPreview';
import { AlbumExportControl } from './AlbumExportControl';
import type { ExportCurrentSource } from './export-control-status';
import { fetchAlbumShare, shareAlbum, stopAlbumShare } from './album-share-api';
import { galleryPhotoTitle } from './gallery-timeline';
import {
  AUTOSAVE_DEBOUNCE_MS,
  createAutosaveQueue,
  type AutosaveQueue,
  type AutosaveState,
  type DomainAutosaveState,
} from '../settings/autosave-queue';
import { UNDO_WINDOW_MS, useManagerUndo } from './undo';
import { useWideViewport } from './viewport';
import type { GalleryAnchor } from '../../app/manager-history-state';
import {
  captureRenderedGalleryAnchor,
  restoreRenderedGalleryAnchor,
  type GalleryAnchorRestoreOutcome,
} from './gallery-anchor';

interface ManagerAlbumProps {
  eventId: string;
  /** The authored event name is the first-run title and the empty-title hint. */
  eventName: string;
  active: boolean;
  /**
   * The event's IANA zone. A recovery deadline read in the browser's zone is a
   * different day for half the world, so without it the album says **Time
   * unavailable** rather than a plausible instant in the wrong place.
   */
  eventTimezone?: string;
  onGoToLibrary(): void;
  /** Raised whenever membership changes here, so Library's `Album picks (n)` stays true. */
  onPicksChanged(): void;
  /** Manager-owned invalidation used after mount-independent inverse work. */
  invalidateGalleryAfterMutation(): void;
  /** Raised only after a confirmed mutation changes an audience-facing summary field. */
  onAudienceChanged?(): void;
  /**
   * Take the host to Intake's Recently deleted filter.
   *
   * Album never stores that destination itself: the retained slot is a marker in
   * this document, and where Recently deleted lives is the Manager's business.
   */
  onOpenRecentlyDeleted?(mediaId: string): void;
  exportJob?: ExportView;
  exportSource: ExportCurrentSource;
  activeExport?: ExportView;
  exportDownload?: ExportDownloadView;
  onPrepareExport(): Promise<void>;
  onDownloadExport(job: ExportView): Promise<void>;
  onRetryExport(job: ExportView): Promise<void>;
  onAutosaveStateChange?(state: DomainAutosaveState): void;
  onAccessFailure?(failure: LoadFailure | null): void;
  onAnnouncement?(message: string): void;
  onAnchorReady?(): void;
  /**
   * The workspace's docked action bar, passed only while Album is the chosen mode.
   * The share action is portalled into it rather than copied, so it keeps the ref,
   * disabled rule and confirmation contract it already has here, and there is never
   * a second `Create Album link` in the document.
   */
  actionDock?: HTMLElement | null;
}

export type AlbumLeavePreparation =
  | { status: 'ready' }
  | { status: 'waiting' }
  | { status: 'invalid'; field: string }
  | { status: 'failed'; message: string };

export interface ManagerAlbumHandle {
  prepareToLeave(): Promise<AlbumLeavePreparation>;
  retryPendingAlbumChanges(): Promise<AlbumLeavePreparation>;
  discardPendingAlbumChanges(): void;
  restoreLeaveFocus(outcome: AlbumLeavePreparation): void;
  captureAnchor(effectiveVisibleTop: number): GalleryAnchor | null;
  restoreAnchor(anchor: GalleryAnchor, effectiveVisibleTop: number): GalleryAnchorRestoreOutcome;
}

type AlbumDraft = {
  entries: AlbumEntryView[];
  title: string;
  description: string;
  coverMediaId: string | null;
};

type ReorderDirection = 'earlier' | 'later';

type ReorderFocusRequest = {
  entryKey: string;
  direction: ReorderDirection;
};

type CreateShareSnapshot = {
  photoCount: number;
  publishedCaptionCount: number;
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

type AlbumPhotoEntry = Extract<AlbumEntryView, { kind: 'photo' }>;
type AlbumRetainedEntry = Extract<AlbumEntryView, { kind: 'photo-retained' }>;

/** What the marker says everywhere it appears. It is deliberately not a photo's name. */
const RETAINED_SLOT_NAME = 'Recently deleted photo';
const RETAINED_SLOT_EXPIRED = 'Recovery expired · cleanup pending';

function isPhotoEntry(entry: AlbumEntryView): entry is AlbumPhotoEntry {
  return entry.kind === 'photo';
}

function isRetainedEntry(entry: AlbumEntryView): entry is AlbumRetainedEntry {
  return entry.kind === 'photo-retained';
}

/**
 * The media a slot holds, whether the photograph is visible or retained.
 *
 * A retained slot and the photo it stands for are the same place in the album, so
 * they share one key: trashing and a timely Restore change what the slot shows,
 * never where it sits.
 */
function entryMediaId(entry: AlbumEntryView): string | null {
  if (isPhotoEntry(entry)) return entry.photo.id;
  if (isRetainedEntry(entry)) return entry.slot.mediaId;
  return null;
}

function entryKey(entry: AlbumEntryView): string {
  const mediaId = entryMediaId(entry);
  return mediaId === null
    ? `section:${(entry as Extract<AlbumEntryView, { kind: 'section' }>).id}`
    : `photo:${mediaId}`;
}

function entryName(entry: AlbumEntryView): string {
  if (isPhotoEntry(entry)) return galleryPhotoTitle(entry.photo);
  if (isRetainedEntry(entry)) return RETAINED_SLOT_NAME;
  return entry.heading;
}

/**
 * Whether Restore is still on offer.
 *
 * The server's `state` is the answer, and the deadline is checked as well because an
 * editor left open all afternoon would otherwise keep offering a recovery that has
 * already lapsed.
 */
function retainedSlotExpired(slot: AlbumRetainedSlotView, now = Date.now()): boolean {
  if (slot.state === 'expired-cleanup-pending') return true;
  const deadline = Date.parse(slot.restoreUntil);
  return Number.isFinite(deadline) && deadline <= now;
}

function retentionDisplay(iso: string, eventTimezone: string | undefined): EventTimeDisplay {
  const value = eventTimezone ? formatRetentionDate(iso, eventTimezone) : null;
  return value === null ? { value: TIME_UNAVAILABLE, dateTime: null } : { value, dateTime: iso };
}

function RetentionInstant({ display }: { display: EventTimeDisplay }) {
  return display.dateTime
    ? <time dateTime={display.dateTime}>{display.value}</time>
    : <>{display.value}</>;
}

function draftFromAlbum(album: AlbumView): AlbumDraft {
  return {
    entries: album.entries,
    title: album.title,
    description: album.description,
    coverMediaId: album.coverMediaId,
  };
}

function canonicalSectionHeading(heading: string): string {
  return heading.trim() || 'New section';
}

function emptySectionIds(entries: readonly AlbumEntryView[]): Set<string> {
  const empty = new Set<string>();
  let pendingSectionId: string | null = null;
  for (const entry of entries) {
    if (entry.kind === 'section') {
      if (pendingSectionId !== null) empty.add(pendingSectionId);
      pendingSectionId = entry.id;
    } else if (entry.kind === 'photo') {
      pendingSectionId = null;
    }
  }
  if (pendingSectionId !== null) empty.add(pendingSectionId);
  return empty;
}

function canonicalDraft(draft: AlbumDraft): AlbumDraft {
  return {
    ...draft,
    title: draft.title.trim(),
    entries: draft.entries.map((entry) => (
      entry.kind === 'section' ? { ...entry, heading: canonicalSectionHeading(entry.heading) } : entry
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

function effectiveAlbumAutosaveState(
  autosave: AutosaveState,
  loading: boolean,
  pendingOperationCount: number,
  accessFailure: LoadFailure | null,
): AutosaveState {
  if (accessFailure) {
    return {
      status: 'failed',
      failure: {
        message: accessFailure.message,
        retryable: accessFailure.retryable,
        ...(accessFailure.retryable ? {} : { escalation: accessFailure }),
      },
    };
  }
  return (loading || pendingOperationCount > 0) && autosave.status === 'saved'
    ? { status: 'saving', failure: null }
    : autosave;
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
  audienceChangeAlreadyConfirmed: boolean;
}

interface AlbumQueueSnapshot {
  draft: AlbumDraft;
  operationCursor: number;
}

type AlbumUndoInput = 'keyboard' | 'pointer';

function undoInputFromClickDetail(detail: number): AlbumUndoInput {
  return detail === 0 ? 'keyboard' : 'pointer';
}

interface CapturedAlbumDraft {
  readonly entries: AlbumInverseState['entries'];
  readonly title: string;
  readonly description: string;
  readonly coverMediaId: string | null;
}

interface QueuedAlbumInverseBase {
  readonly cursor: number;
  readonly key: string;
  readonly forward: CapturedAlbumDraft;
  readonly restored: CapturedAlbumDraft;
  readonly message: string;
  readonly input: AlbumUndoInput;
  readonly fallback: HTMLElement | null;
  sentRevision: number | null;
  preState: AlbumInverseState | null;
}

type QueuedAlbumInverse =
  | (QueuedAlbumInverseBase & { readonly kind: 'order' })
  | (QueuedAlbumInverseBase & { readonly kind: 'photo'; readonly mediaId: string });

type QueuedAlbumInverseRequest =
  | {
    readonly kind: 'order';
    readonly restored: CapturedAlbumDraft;
    readonly message: string;
    readonly input: AlbumUndoInput;
    readonly fallback: HTMLElement | null;
  }
  | {
    readonly kind: 'photo';
    readonly mediaId: string;
    readonly restored: CapturedAlbumDraft;
    readonly message: string;
    readonly input: AlbumUndoInput;
    readonly fallback: HTMLElement | null;
  };

type QueuedInverseClassification =
  | { readonly kind: 'offer'; readonly payload: AlbumInversePayload }
  | { readonly kind: 'pre-state' }
  | { readonly kind: 'unrelated' };

function captureAlbumDraft(draft: AlbumDraft): CapturedAlbumDraft {
  const canonical = canonicalDraft(draft);
  return {
    entries: toEntryInput(canonical.entries).map((entry) => ({ ...entry })),
    title: canonical.title,
    description: canonical.description,
    coverMediaId: canonical.coverMediaId,
  };
}

function inverseStateFromCapture(
  captured: CapturedAlbumDraft,
  revision: number,
  saved: boolean,
): AlbumInverseState {
  return {
    revision,
    saved,
    entries: captured.entries.map((entry) => ({ ...entry })),
    title: captured.title,
    description: captured.description,
    coverMediaId: captured.coverMediaId,
  };
}

function inverseStateFromAlbum(album: AlbumView): AlbumInverseState {
  return {
    revision: album.revision,
    saved: album.saved,
    entries: toEntryInput(album.entries),
    title: album.title,
    description: album.description,
    coverMediaId: album.coverMediaId,
  };
}

function sameInverseState(left: AlbumInverseState, right: AlbumInverseState): boolean {
  return left.revision === right.revision
    && left.saved === right.saved
    && left.title === right.title
    && left.description === right.description
    && left.coverMediaId === right.coverMediaId
    && JSON.stringify(left.entries) === JSON.stringify(right.entries);
}

function frozenInverseState(state: AlbumInverseState): AlbumInverseState {
  const entries = Object.freeze(state.entries.map((entry) => Object.freeze({ ...entry })));
  return Object.freeze({ ...state, entries });
}

function frozenAlbumInverse(payload: AlbumInversePayload): AlbumInversePayload {
  if (payload.kind === 'order') {
    return Object.freeze({
      kind: payload.kind,
      forward: frozenInverseState(payload.forward),
      restored: frozenInverseState(payload.restored),
    });
  }
  if (payload.kind === 'membership') {
    return Object.freeze({
      kind: payload.kind,
      mediaIds: Object.freeze([...payload.mediaIds]),
      forward: frozenInverseState(payload.forward),
      restored: frozenInverseState(payload.restored),
    });
  }
  return Object.freeze({
    kind: payload.kind,
    mediaIds: Object.freeze([...payload.mediaIds]),
    forward: frozenInverseState(payload.forward),
    membershipRestored: frozenInverseState(payload.membershipRestored),
    restored: frozenInverseState(payload.restored),
  });
}

function mountIndependentAlbumInverse(
  eventId: string,
  payload: AlbumInversePayload,
  invalidateGalleryAfterMutation: () => void,
): () => Promise<void> {
  const frozenPayload = frozenAlbumInverse(payload);
  return async () => {
    try {
      await runAlbumInverse(eventId, frozenPayload);
    } finally {
      invalidateGalleryAfterMutation();
    }
  };
}

function partialPhotoState(preState: AlbumInverseState, mediaId: string): AlbumInverseState {
  return {
    ...preState,
    entries: preState.entries.filter((entry) => (
      entry.kind !== 'photo' || entry.mediaId !== mediaId
    )),
    coverMediaId: preState.coverMediaId === mediaId ? null : preState.coverMediaId,
  };
}

function classifyQueuedInverse(
  candidate: QueuedAlbumInverse,
  album: AlbumView,
): QueuedInverseClassification {
  if (candidate.sentRevision === null || candidate.preState === null) {
    return { kind: 'unrelated' };
  }
  const canonical = inverseStateFromAlbum(album);
  const forward = inverseStateFromCapture(candidate.forward, candidate.sentRevision + 1, true);
  const restored = inverseStateFromCapture(candidate.restored, candidate.sentRevision + 2, true);

  if (sameInverseState(canonical, forward)) {
    if (candidate.kind === 'order') {
      return { kind: 'offer', payload: { kind: 'order', forward, restored } };
    }
    const membershipRestored: AlbumInverseState = {
      ...forward,
      entries: [...forward.entries, { kind: 'photo', mediaId: candidate.mediaId }],
    };
    return {
      kind: 'offer',
      payload: {
        kind: 'membership-order',
        mediaIds: [candidate.mediaId],
        forward,
        membershipRestored,
        restored,
      },
    };
  }

  if (candidate.kind === 'photo') {
    if (sameInverseState(canonical, candidate.preState)) return { kind: 'pre-state' };
    const partial = partialPhotoState(candidate.preState, candidate.mediaId);
    if (sameInverseState(canonical, partial)) {
      return {
        kind: 'offer',
        payload: {
          kind: 'membership',
          mediaIds: [candidate.mediaId],
          forward: partial,
          restored: candidate.preState,
        },
      };
    }
  }

  return { kind: 'unrelated' };
}

interface AlbumReconnectFailureOwner {
  queue: AutosaveQueue<AlbumQueueSnapshot>;
  lifecycle: number;
  attempt: number;
  draftGeneration: number;
  canonicalKey: string;
}

const ALBUM_NETWORK_SAVE_MESSAGE = 'Check your connection, then try saving the Album again.';

interface RejectedAlbumDraft {
  snapshot: AlbumQueueSnapshot;
  intent: string;
}

/**
 * Every media id holding a photo position, retained slots included.
 *
 * The cover is validated against this set, so trashing the chosen cover does not
 * quietly drop the host's choice: the reference survives, a timely Restore brings
 * the same photograph back as the cover, and starring another photo is the one
 * thing that replaces it.
 */
function livePhotoIds(entries: readonly AlbumEntryView[]): Set<string> {
  return new Set(entries.flatMap((entry) => {
    const mediaId = entryMediaId(entry);
    return mediaId === null ? [] : [mediaId];
  }));
}

/**
 * The timeline order, with retained slots kept.
 *
 * Only Start empty clears picks and markers. Reset to timeline order is an ordinary
 * edit, so it sorts visible and retained photo slots together by the ordering-only
 * timeline fact the Manager projection carries for both.
 */
function timelineOrderedEntries(entries: readonly AlbumEntryView[]): AlbumEntryView[] {
  const slots = entries.filter(
    (entry): entry is AlbumPhotoEntry | AlbumRetainedEntry => entry.kind !== 'section',
  );
  return slots.sort((left, right) => {
    const leftTimeline = isPhotoEntry(left) ? left.photo.timelineAt : left.slot.timelineAt;
    const rightTimeline = isPhotoEntry(right) ? right.photo.timelineAt : right.slot.timelineAt;
    const leftId = isPhotoEntry(left) ? left.photo.id : left.slot.mediaId;
    const rightId = isPhotoEntry(right) ? right.photo.id : right.slot.mediaId;
    return leftTimeline.localeCompare(rightTimeline) || leftId.localeCompare(rightId);
  });
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

/** Photo and retained slots by media id, so a slot that changed kind resolves to the live one. */
function canonicalSlotsById(entries: readonly AlbumEntryView[]): Map<string, AlbumEntryView> {
  return new Map(entries.flatMap((entry) => {
    const mediaId = entryMediaId(entry);
    return mediaId === null ? [] : [[mediaId, entry] as const];
  }));
}

function mergeReplacementEntries(
  requested: readonly AlbumEntryView[],
  canonical: readonly AlbumEntryView[],
): AlbumEntryView[] {
  const canonicalPhotos = canonicalSlotsById(canonical);
  const placed = new Set<string>();
  let entries = requested.flatMap((entry): AlbumEntryView[] => {
    const key = entryKey(entry);
    if (placed.has(key)) return [];
    const mediaId = entryMediaId(entry);
    if (mediaId !== null) {
      const live = canonicalPhotos.get(mediaId);
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
  const canonicalPhotos = canonicalSlotsById(canonical.entries);
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
        const movedMediaId = entryMediaId(operation.entry);
        const entry = existing
          ?? (movedMediaId === null
            ? operation.entry
            : canonicalPhotos.get(movedMediaId));
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
        const insertedMediaId = entryMediaId(operation.entry);
        const entry = insertedMediaId === null
          ? operation.entry
          : canonicalPhotos.get(insertedMediaId);
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
          entries: timelineOrderedEntries(next.entries),
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
  const canonicalPhotos = canonicalSlotsById(canonical.entries);
  const placed = new Set<string>();
  const entries = current.entries.flatMap((entry): AlbumEntryView[] => {
    const mediaId = entryMediaId(entry);
    if (mediaId === null) return [entry];
    const live = canonicalPhotos.get(mediaId);
    if (!live) return [];
    placed.add(mediaId);
    return [live];
  });
  for (const entry of canonical.entries) {
    const mediaId = entryMediaId(entry);
    if (mediaId !== null && !placed.has(mediaId)) entries.push(entry);
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
  eventName,
  active,
  eventTimezone,
  onGoToLibrary,
  onPicksChanged,
  invalidateGalleryAfterMutation,
  onAudienceChanged,
  onOpenRecentlyDeleted,
  exportJob,
  exportSource,
  activeExport,
  exportDownload,
  onPrepareExport,
  onDownloadExport,
  onRetryExport,
  onAutosaveStateChange,
  onAccessFailure,
  onAnnouncement,
  onAnchorReady,
  actionDock = null,
}, ref) {
  const [album, setAlbum] = useState<AlbumView | null>(null);
  const [draft, setDraft] = useState<AlbumDraft>(() => ({
    ...INITIAL_DRAFT,
    title: eventName,
  }));
  const [autosave, setAutosave] = useState<AutosaveState>({ status: 'saved', failure: null });
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [starting, setStarting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [albumDetailsOpen, setAlbumDetailsOpen] = useState(false);
  const [titleFocusRequest, setTitleFocusRequest] = useState(0);
  const [share, setShare] = useState<AlbumShareStatus>(null);
  const [sharePending, setSharePending] = useState(false);
  const [createShareSnapshot, setCreateShareSnapshot] = useState<CreateShareSnapshot | null>(null);
  const [createShareError, setCreateShareError] = useState<string | null>(null);
  const [createShareRecoveryRequest, setCreateShareRecoveryRequest] = useState(0);
  const [createShareReturnFocusRequest, setCreateShareReturnFocusRequest] = useState(0);
  const [shareCopyFocusRequest, setShareCopyFocusRequest] = useState(0);
  const [confirmingStopShare, setConfirmingStopShare] = useState(false);
  const [stopShareError, setStopShareError] = useState<string | null>(null);
  const [stopShareFocusRequest, setStopShareFocusRequest] = useState(0);
  const [confirmHost] = useState(() => {
    const element = document.createElement('div');
    element.dataset.albumConfirmHost = 'true';
    return element;
  });
  const [recoveryFocusRequest, setRecoveryFocusRequest] = useState(0);
  const [pendingPickIds, setPendingPickIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingOperationCount, setPendingOperationCount] = useState(0);
  const [failedPreviewIds, setFailedPreviewIds] = useState<ReadonlySet<string>>(() => new Set());
  const [reconciliationFailure, setReconciliationFailure] = useState<LoadFailure | null>(null);

  /**
   * The details fold is a phone affordance: from 761 its summary is hidden and the
   * fields stand open. The width is read here rather than left to a media query so
   * `aria-expanded` stays honest, and so a focus request can never aim at a field
   * that CSS alone had taken off the screen.
   */
  const wide = useWideViewport();

  const undo = useManagerUndo();
  const dismissUndo = undo.dismiss;
  const rootRef = useRef<HTMLDivElement>(null);
  const leaveHeadingRef = useRef<HTMLHeadingElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const lastFocusedEntryKey = useRef<string | null>(null);
  const selectSectionKey = useRef<string | null>(null);
  const draftRef = useRef<AlbumDraft>({ ...INITIAL_DRAFT, title: eventName });
  const revisionRef = useRef(0);
  const loadGeneration = useRef(0);
  const loadFailureRef = useRef<LoadFailure | null>(null);
  const hasLoaded = useRef(false);
  const conflictEpoch = useRef(0);
  const dragKey = useRef<string | null>(null);
  const reorderFocusRequest = useRef<ReorderFocusRequest | null>(null);
  const shareConfirmRef = useRef<HTMLDivElement>(null);
  const cancelCreateShareRef = useRef<HTMLButtonElement>(null);
  const keepSharingRef = useRef<HTMLButtonElement>(null);
  const createShareOriginRef = useRef<HTMLElement | null>(null);
  const stopShareOriginRef = useRef<HTMLElement | null>(null);
  const createShareErrorRef = useRef<HTMLParagraphElement>(null);
  const stopShareErrorRef = useRef<HTMLParagraphElement>(null);
  const shareActionRef = useRef<HTMLButtonElement>(null);
  const shareCopyRef = useRef<HTMLButtonElement>(null);
  const shareHeadingRef = useRef<HTMLParagraphElement>(null);
  const shareRequestGeneration = useRef(0);
  const shareOperationPending = useRef(false);
  const currentShare = useRef<AlbumShareStatus>(null);
  const createShareOpen = useRef(false);
  const draftGeneration = useRef(0);
  const autoStartAttemptedEvent = useRef<string | null>(null);
  const canonicalTrusted = useRef(true);
  const reconciliationFailureRef = useRef<LoadFailure | null>(null);
  const pendingOperations = useRef(new Set<Promise<unknown>>());
  const coverIntentGeneration = useRef(0);
  const operationCursor = useRef(0);
  const operationJournal = useRef<JournalledAlbumOperation[]>([]);
  const pendingInverse = useRef<QueuedAlbumInverse | null>(null);
  const canonicalAlbumRef = useRef<AlbumView | null>(null);
  const pendingStartInverse = useRef<{
    message: string;
    input: AlbumUndoInput;
    payload: AlbumInversePayload;
  } | null>(null);
  const loadCanonicalRef = useRef<((rejected: RejectedAlbumDraft) => Promise<AlbumView>) | null>(null);
  const queueRef = useRef<AutosaveQueue<AlbumQueueSnapshot> | null>(null);
  const queueLifecycle = useRef(0);
  const reconnectAttempt = useRef(0);
  const reconnectFailureOwnerRef = useRef<AlbumReconnectFailureOwner | null>(null);
  const audienceChangedRef = useRef(onAudienceChanged);

  useLayoutEffect(() => {
    audienceChangedRef.current = onAudienceChanged;
  }, [onAudienceChanged]);

  const adoptShare = useCallback((next: AlbumShareStatus) => {
    currentShare.current = next;
    setShare(next);
  }, []);

  function focusUndoFallback(fallback: HTMLElement | null): void {
    fallback?.focus({ preventScroll: true });
  }

  function fallbackForEntryKey(key: string | null): HTMLElement | null {
    if (key === null) return null;
    const entry = listRef.current?.querySelector<HTMLElement>(
      `[data-entry-key="${CSS.escape(key)}"]`,
    );
    for (const selector of [
      '.album-entry__remove:not(:disabled)',
      '.album-entry__cover:not(:disabled)',
      '.album-entry__move-earlier:not(:disabled)',
      '.album-entry__move-later:not(:disabled)',
      'input:not(:disabled)',
      'button:not(:disabled)',
    ]) {
      const control = entry?.querySelector<HTMLElement>(selector);
      if (control) return control;
    }
    return null;
  }

  function fallbackForRemovedEntry(context: RemovedEntryContext): HTMLElement | null {
    const orderedKeys = [context.nextKey, context.previousKey];
    for (const key of orderedKeys) {
      const fallback = fallbackForEntryKey(key);
      if (fallback) return fallback;
    }
    return leaveHeadingRef.current;
  }

  function presentAlbumInverse(
    message: string,
    input: AlbumUndoInput,
    fallback: HTMLElement | null,
    payload: AlbumInversePayload,
  ): boolean {
    return undo.present({
      eventId,
      message,
      durationMs: UNDO_WINDOW_MS,
      input,
      run: mountIndependentAlbumInverse(
        eventId,
        payload,
        invalidateGalleryAfterMutation,
      ),
    }, { fallback });
  }

  function presentPendingStartAlbumInverse(): void {
    const pending = pendingStartInverse.current;
    if (!pending) return;
    // Where Undo returns focus, not a request to edit anything. A phone with the
    // details folded away has no title input, and the chain then lands on a control
    // the host can actually see — opening the fold for a parking spot would push the
    // order back down for no reason.
    const fallback = titleRef.current
      ?? rootRef.current?.querySelector<HTMLElement>(
        '.album-order-heading button:not(:disabled), .album-exits button:not(:disabled)',
      )
      ?? leaveHeadingRef.current;
    if (!fallback) return;
    pendingStartInverse.current = null;
    focusUndoFallback(fallback);
    presentAlbumInverse(pending.message, pending.input, fallback, pending.payload);
  }

  function classifyAndPresentQueuedInverse(
    candidate: QueuedAlbumInverse,
    canonical: AlbumView,
  ): QueuedInverseClassification['kind'] | 'suppressed' {
    if (pendingInverse.current !== candidate || operationCursor.current !== candidate.cursor) {
      return 'suppressed';
    }
    const classification = classifyQueuedInverse(candidate, canonical);
    pendingInverse.current = null;
    if (classification.kind === 'offer') {
      presentAlbumInverse(
        candidate.message,
        candidate.input,
        candidate.fallback,
        classification.payload,
      );
    } else if (classification.kind === 'unrelated') {
      invalidateGalleryAfterMutation();
    }
    return classification.kind;
  }

  if (queueRef.current === null) {
    queueRef.current = createAutosaveQueue<AlbumQueueSnapshot>({
      baselineKey: 'album:not-loaded',
      debounceMs: AUTOSAVE_DEBOUNCE_MS,
      async save(snapshot, sent) {
        const inverseCandidate = pendingInverse.current;
        if (
          inverseCandidate
          && inverseCandidate.cursor === snapshot.operationCursor
          && inverseCandidate.key === sent.key
          && operationCursor.current === inverseCandidate.cursor
        ) {
          inverseCandidate.sentRevision = revisionRef.current;
          inverseCandidate.preState = inverseStateFromCapture(
            inverseCandidate.restored,
            revisionRef.current,
            true,
          );
        }
        const includedOperations = operationJournal.current.filter(
          ({ cursor }) => cursor <= snapshot.operationCursor,
        );
        // Membership writes notify immediately because their associated Album
        // save can still fail. A queue settlement only stays silent when every
        // operation it owns has already been notified; a coalesced metadata,
        // section, or order operation keeps its own confirmed-save callback.
        const audienceChangeNeedsNotification = includedOperations.length === 0
          || includedOperations.some(({ audienceChangeAlreadyConfirmed }) => (
            !audienceChangeAlreadyConfirmed
          ));
        const sentDraft = snapshot.draft;
        try {
          const result = await saveAlbumOrder(
            eventId,
            revisionRef.current,
            toEntryInput(sentDraft.entries),
            draftMetadata(sentDraft),
          );
          reconnectFailureOwnerRef.current = null;
          // This assignment is synchronous and happens before the queue can start
          // a coalesced successor from the resolved outcome.
          revisionRef.current = result.album.revision;
          operationJournal.current = operationJournal.current.filter(
            ({ cursor }) => cursor > snapshot.operationCursor,
          );
          canonicalAlbumRef.current = result.album;
          setAlbum(result.album);
          if (draftIntent(draftRef.current) === sent.intent) {
            const confirmed = draftFromAlbum(result.album);
            draftGeneration.current += 1;
            draftRef.current = confirmed;
            setDraft(confirmed);
          }
          if (inverseCandidate) classifyAndPresentQueuedInverse(inverseCandidate, result.album);
          if (audienceChangeNeedsNotification) audienceChangedRef.current?.();
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
        if (!(caught instanceof ClientApiError)) {
          const activeQueue = queueRef.current;
          if (caught instanceof TypeError && activeQueue) {
            const owner: AlbumReconnectFailureOwner = {
              queue: activeQueue,
              lifecycle: queueLifecycle.current,
              attempt: reconnectAttempt.current + 1,
              draftGeneration: draftGeneration.current,
              canonicalKey: draftKey(canonicalDraft(draftRef.current)),
            };
            reconnectAttempt.current = owner.attempt;
            reconnectFailureOwnerRef.current = owner;
          } else {
            reconnectFailureOwnerRef.current = null;
          }
          return { message: ALBUM_NETWORK_SAVE_MESSAGE, retryable: true };
        }
        reconnectFailureOwnerRef.current = null;
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
  const deadlineNow = useDeadlineClock(draft.entries.flatMap((entry) => (
    isRetainedEntry(entry) ? [entry.slot.restoreUntil] : []
  )));

  const adoptCanonical = useCallback((next: AlbumView, resetQueue = false) => {
    const nextDraft = draftFromAlbum(next);
    if (resetQueue) queue.discardPending();
    revisionRef.current = next.revision;
    draftGeneration.current += 1;
    draftRef.current = nextDraft;
    canonicalAlbumRef.current = next;
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
      canonicalAlbumRef.current = result.album;
      setAlbum(result.album);
      queue.adoptBaseline(draftKey(canonical));
      const inverseCandidate = pendingInverse.current;
      let usedManagerInvalidation = false;
      if (inverseCandidate?.cursor === rejected.snapshot.operationCursor) {
        usedManagerInvalidation = classifyAndPresentQueuedInverse(
          inverseCandidate,
          result.album,
        ) === 'unrelated';
      }
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
      // Canonical conflict recovery is a distinct authoritative adoption. The
      // fail-closed unrelated branch already invalidated every Manager owner;
      // avoid scheduling a duplicate audience read in that case.
      if (!usedManagerInvalidation) audienceChangedRef.current?.();
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
        if (shareGeneration !== shareRequestGeneration.current) return;
        adoptShare(result.share);
        if (result.share && createShareOpen.current) {
          createShareOpen.current = false;
          setCreateShareSnapshot(null);
          setCreateShareError(null);
          setCreateShareReturnFocusRequest((current) => current + 1);
        }
      },
      (caught: unknown) => {
        if (shareGeneration === shareRequestGeneration.current
          && !(caught instanceof DOMException && caught.name === 'AbortError')) {
          setNotice(errorMessage(caught, 'The Album link status could not be loaded.'));
        }
      },
    );
    return () => {
      controller.abort();
      // The workspace keys Album by event and Manager mutation generation. Retire
      // both local generations too, so an endpoint that ignores AbortSignal still
      // cannot adopt or announce a response after that owner has gone away.
      loadGeneration.current += 1;
      draftGeneration.current += 1;
    };
  }, [active, adoptShare, eventId, loadCanonical]);

  useEffect(() => {
    queueLifecycle.current += 1;
    return () => {
      const cleanupGeneration = ++queueLifecycle.current;
      // React StrictMode immediately replays passive effects without remounting the
      // component. Defer irreversible queue disposal by one microtask so the replayed
      // setup can claim this same queue; a real unmount has no successor and disposes it.
      queueMicrotask(() => {
        if (queueLifecycle.current !== cleanupGeneration) return;
        queue.dispose();
      });
    };
  }, [queue]);

  /**
   * The same containment the viewer and Cover Studio use. `aria-modal` on its own
   * leaves the editor behind either confirmation tabbable and readable. Both link
   * lifecycle decisions use this same containment contract.
   */
  useLayoutEffect(() => {
    if (!confirmingStopShare && createShareSnapshot === null) return;
    document.body.append(confirmHost);
    const inerted: HTMLElement[] = [];
    for (const sibling of Array.from(document.body.children)) {
      if (sibling === confirmHost || !(sibling instanceof HTMLElement)) continue;
      if (sibling.dataset.galleryLiveHost === 'true') continue;
      if (sibling.hasAttribute('inert')) continue;
      sibling.setAttribute('inert', '');
      inerted.push(sibling);
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      for (const sibling of inerted) sibling.removeAttribute('inert');
      document.body.style.overflow = previousOverflow;
      confirmHost.remove();
    };
  }, [confirmHost, confirmingStopShare, createShareSnapshot]);

  useEffect(() => {
    if (createShareSnapshot !== null) cancelCreateShareRef.current?.focus();
    else if (confirmingStopShare) keepSharingRef.current?.focus();
  }, [confirmingStopShare, createShareSnapshot]);

  useEffect(() => {
    if (createShareError) createShareErrorRef.current?.focus();
    else if (stopShareError) stopShareErrorRef.current?.focus();
  }, [createShareError, stopShareError]);

  useEffect(() => {
    if (createShareRecoveryRequest === 0 || createShareSnapshot !== null) return;
    focusBlockingRecovery(queue.state());
  }, [createShareRecoveryRequest, createShareSnapshot, queue]);

  useEffect(() => {
    if (createShareReturnFocusRequest === 0 || createShareSnapshot !== null || sharePending) return;
    createShareOriginRef.current?.focus();
    createShareOriginRef.current = null;
  }, [createShareReturnFocusRequest, createShareSnapshot, sharePending]);

  useEffect(() => {
    if (shareCopyFocusRequest === 0) return;
    shareCopyRef.current?.focus();
  }, [shareCopyFocusRequest]);

  /**
   * Where a host lands once the link is gone: on the action that makes a new one, or
   * — when there is nothing to share yet — on the heading of the section they were in.
   */
  useEffect(() => {
    if (stopShareFocusRequest === 0) return;
    const replacement = shareActionRef.current;
    if (replacement && !replacement.disabled) replacement.focus();
    else shareHeadingRef.current?.focus();
  }, [stopShareFocusRequest]);

  useEffect(() => {
    if (!confirmingStopShare && createShareSnapshot === null) return;
    const onKeyDown = (pressed: KeyboardEvent) => {
      if (pressed.key === 'Escape') {
        pressed.preventDefault();
        if (createShareSnapshot !== null) cancelCreateShare();
        else keepSharing();
        return;
      }
      if (pressed.key !== 'Tab') return;
      const focusable = shareConfirmRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable?.[0];
      const last = focusable?.[focusable.length - 1];
      if (!first || !last) return;
      if (pressed.shiftKey && document.activeElement === first) {
        pressed.preventDefault();
        last.focus();
      } else if (!pressed.shiftKey && document.activeElement === last) {
        pressed.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [confirmingStopShare, createShareSnapshot]);

  useEffect(() => {
    const blockingField = titleIsInvalid(draft)
      ? { label: 'Album title', message: 'Give this album a title.' }
      : null;
    const accessFailure = reconciliationFailure ?? loadFailure;
    const state = effectiveAlbumAutosaveState(
      autosave,
      loading,
      pendingOperationCount,
      accessFailure,
    );
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

  const recordOperations = useCallback((
    operations: readonly AlbumIntentOperation[],
    audienceChangeAlreadyConfirmed = false,
  ) => {
    if (operations.length > 0) dismissUndo();
    for (const operation of operations) {
      operationCursor.current += 1;
      operationJournal.current.push({
        cursor: operationCursor.current,
        operation,
        audienceChangeAlreadyConfirmed,
      });
    }
  }, [dismissUndo]);

  const applyDraft = useCallback((
    next: AlbumDraft,
    immediate = false,
    operations: readonly AlbumIntentOperation[] = [],
    options: {
      audienceChangeAlreadyConfirmed?: boolean;
      inverse?: QueuedAlbumInverseRequest;
    } = {},
  ) => {
    const cursorBeforeOperations = operationCursor.current;
    recordOperations(operations, options.audienceChangeAlreadyConfirmed);
    if (
      operationCursor.current > cursorBeforeOperations
      && pendingInverse.current
      && pendingInverse.current.cursor < operationCursor.current
    ) {
      pendingInverse.current = null;
    }
    draftGeneration.current += 1;
    draftRef.current = next;
    setDraft(next);
    const canonical = canonicalDraft(next);
    const key = draftKey(canonical);
    if (options.inverse) {
      pendingInverse.current = {
        ...options.inverse,
        cursor: operationCursor.current,
        key,
        forward: captureAlbumDraft(canonical),
        sentRevision: null,
        preState: null,
      };
    }
    queue.submit({
      key,
      intent: draftIntent(next),
      snapshot: titleIsInvalid(next) ? null : {
        draft: canonical,
        operationCursor: operationCursor.current,
      },
    }, immediate);
  }, [queue, recordOperations]);

  useLayoutEffect(() => {
    const retryOnReconnect = () => {
      const owner = reconnectFailureOwnerRef.current;
      if (!owner) return;
      const current = canonicalDraft(draftRef.current);
      if (
        reconnectFailureOwnerRef.current !== owner
        || owner.queue !== queue
        || queueRef.current !== owner.queue
        || queueLifecycle.current !== owner.lifecycle
        || reconnectAttempt.current !== owner.attempt
        || owner.queue.state().status !== 'failed'
        || draftGeneration.current !== owner.draftGeneration
        || titleIsInvalid(current)
        || draftKey(current) !== owner.canonicalKey
      ) return;
      reconnectFailureOwnerRef.current = null;
      applyDraft(draftRef.current, true);
    };

    window.addEventListener('online', retryOnReconnect);
    return () => window.removeEventListener('online', retryOnReconnect);
  }, [applyDraft, queue]);

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

  const invalidTitle = titleIsInvalid(draft);

  /**
   * `Fix the highlighted field to save` has to be able to point at something. An
   * empty title opens the fold wherever the refusal is raised, so the field, its
   * message and its `aria-invalid` are on screen with it.
   */
  useEffect(() => {
    if (invalidTitle) setAlbumDetailsOpen(true);
  }, [invalidTitle]);

  useEffect(() => {
    if (titleFocusRequest === 0) return;
    titleRef.current?.focus();
  }, [titleFocusRequest]);

  /**
   * Send focus to the Album title, opening the fold on the way. The direct call lands
   * whenever the fields are already on screen; the request carries the rest of the
   * way, after the render a closed fold needs before that input exists.
   */
  const focusAlbumTitle = useCallback(() => {
    setAlbumDetailsOpen(true);
    titleRef.current?.focus();
    setTitleFocusRequest((current) => current + 1);
  }, []);

  function focusBlockingRecovery(state: AutosaveState) {
    if (state.status === 'invalid') {
      focusAlbumTitle();
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

  const settleDraft = useCallback(async ({ focusRecovery = true }: { focusRecovery?: boolean } = {}): Promise<AlbumLeavePreparation> => {
    const beforeConflict = conflictEpoch.current;
    queue.flush();
    while (pendingOperations.current.size > 0) {
      await Promise.allSettled([...pendingOperations.current]);
    }
    queue.flush();
    const state = await queue.waitForSettled();
    let outcome: AlbumLeavePreparation;
    if (state.status === 'invalid') {
      outcome = { status: 'invalid', field: 'Album title' };
    } else if (state.status === 'saved'
      && conflictEpoch.current === beforeConflict
      && loadFailureRef.current === null
      && canonicalTrusted.current) {
      outcome = { status: 'ready' };
    } else {
      outcome = {
        status: 'failed',
        message: state.failure?.message
          ?? reconciliationFailureRef.current?.message
          ?? loadFailureRef.current?.message
          ?? (conflictEpoch.current !== beforeConflict
            ? 'The Album changed while leaving was being prepared. Try again.'
            : 'The Album could not be confirmed. Try again.'),
      };
    }
    if (outcome.status !== 'ready' && focusRecovery) {
      focusBlockingRecovery(state);
    } else if (outcome.status === 'failed') {
      // A prompt owns focus during imperative leave preparation, but a
      // credential/lifecycle refusal still belongs to Manager's established
      // access-recovery surface. Re-reporting it after dismissal keeps an exit
      // attempt from demoting a terminal access fact into a futile local Retry.
      if (reconciliationFailureRef.current && !reconciliationFailureRef.current.retryable) {
        onAccessFailure?.(reconciliationFailureRef.current);
      } else if (state.failure?.escalation) {
        onAccessFailure?.(state.failure.escalation);
      } else if (loadFailureRef.current && !loadFailureRef.current.retryable) {
        onAccessFailure?.(loadFailureRef.current);
      }
    }
    return outcome;
  }, [onAccessFailure, queue]);

  const discardPendingAlbumChanges = useCallback(() => {
    draftGeneration.current += 1;
    operationJournal.current = [];
    pendingInverse.current = null;
    pendingStartInverse.current = null;
    reconnectAttempt.current += 1;
    reconnectFailureOwnerRef.current = null;
    queue.discardPending();
  }, [queue]);

  const retryPendingAlbumChanges = useCallback(async () => {
    if (reconciliationFailureRef.current?.retryable) {
      await retryMembershipRefresh();
      return settleDraft({ focusRecovery: false });
    }
    if (loadFailureRef.current?.retryable) {
      try {
        await loadCanonical();
      } catch {
        // `loadCanonical` has already classified and retained the newest
        // failure. The terminal leave outcome below owns its presentation.
      }
      return settleDraft({ focusRecovery: false });
    }
    const state = queue.state();
    if (
      state.status === 'failed'
      && state.failure?.retryable === true
      && !titleIsInvalid(draftRef.current)
    ) {
      // Retry the queue's current draft through its existing immediate-submit
      // path. The leave coordinator observes the resulting settlement; it does
      // not own another save mechanism.
      applyDraft(draftRef.current, true);
    }
    return settleDraft({ focusRecovery: false });
  }, [applyDraft, loadCanonical, queue, settleDraft]);

  const restoreLeaveFocus = useCallback((outcome: AlbumLeavePreparation) => {
    if (outcome.status === 'invalid') {
      focusAlbumTitle();
      return;
    }
    leaveHeadingRef.current?.focus();
  }, [focusAlbumTitle]);

  useImperativeHandle(ref, () => ({
    prepareToLeave: () => settleDraft({ focusRecovery: false }),
    retryPendingAlbumChanges,
    discardPendingAlbumChanges,
    restoreLeaveFocus,
    captureAnchor: (effectiveVisibleTop) => rootRef.current
      ? captureRenderedGalleryAnchor(rootRef.current, 'album-entry', effectiveVisibleTop)
      : null,
    restoreAnchor: (anchor, effectiveVisibleTop) => {
      const root = rootRef.current;
      if ((loading && !hasLoaded.current) || root === null) return 'pending';
      return restoreRenderedGalleryAnchor(root, anchor, effectiveVisibleTop);
    },
  }), [discardPendingAlbumChanges, loading, restoreLeaveFocus, retryPendingAlbumChanges, settleDraft]);

  useLayoutEffect(() => {
    if (!active || loading || rootRef.current === null) return;
    onAnchorReady?.();
  }, [active, loading, onAnchorReady]);

  useEffect(() => {
    const request = reorderFocusRequest.current;
    if (!request) return;
    reorderFocusRequest.current = null;
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-entry-key="${CSS.escape(request.entryKey)}"] .album-entry__move-${request.direction}`,
      )
      ?.focus();
  }, [draft.entries]);

  useLayoutEffect(() => {
    const key = selectSectionKey.current;
    if (!key) return;
    selectSectionKey.current = null;
    const input = listRef.current
      ?.querySelector<HTMLInputElement>(`[data-entry-key="${CSS.escape(key)}"] input`);
    input?.scrollIntoView?.({ behavior: 'instant', block: 'center', inline: 'nearest' });
    input?.focus({ preventScroll: true });
    input?.select();
  }, [draft.entries]);

  function move(from: number, to: number, direction: ReorderDirection) {
    const entry = draftRef.current.entries[from];
    if (!entry || from === to || to < 0 || to >= draftRef.current.entries.length) return;
    const entries = moveEntryTo(draftRef.current.entries, from, to);
    const context = removedEntryContext(entries, entryKey(entry));
    if (!context) return;
    reorderFocusRequest.current = { entryKey: entryKey(entry), direction };
    applyDraft({ ...draftRef.current, entries }, false, [{
      kind: 'move-entry',
      key: entryKey(entry),
      entry,
      previousKey: context.previousKey,
      nextKey: context.nextKey,
      prefer: from < to ? 'previous' : 'next',
    }]);
    setAnnouncement(`${entryName(entry)} moved to position ${to + 1} of ${entries.length}.`);
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
    const anchorIndex = lastFocusedEntryKey.current === null
      ? -1
      : current.entries.findIndex((entry) => entryKey(entry) === lastFocusedEntryKey.current);
    const insertionIndex = anchorIndex >= 0 ? anchorIndex + 1 : current.entries.length;
    const entries = [
      ...current.entries.slice(0, insertionIndex),
      section,
      ...current.entries.slice(insertionIndex),
    ];
    const context = removedEntryContext(entries, entryKey(section));
    lastFocusedEntryKey.current = entryKey(section);
    selectSectionKey.current = entryKey(section);
    applyDraft({ ...current, entries }, false, context ? [{
      kind: 'insert-entry',
      entry: section,
      previousKey: context.previousKey,
      nextKey: context.nextKey,
      prefer: 'previous',
    }] : []);
    setAnnouncement(anchorIndex >= 0
      ? `Section added at position ${insertionIndex + 1} of ${entries.length}.`
      : `Section added at the end, position ${entries.length} of ${entries.length}.`);
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
    applyDraft(next, false, [{
      kind: 'rename-section',
      section: { ...section, heading },
      previousKey: context.previousKey,
      nextKey: context.nextKey,
      prefer: context.previousKey ? 'previous' : 'next',
    }]);
  }

  function commitSectionName(id: string) {
    const current = draftRef.current;
    const section = current.entries.find((entry) => entry.kind === 'section' && entry.id === id);
    if (!section || section.kind !== 'section') return;
    const heading = canonicalSectionHeading(section.heading);
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

  function removeSection(id: string, clickDetail: number) {
    if (!undo.canPresent) return;
    const before = draftRef.current;
    const context = removedEntryContext(before.entries, `section:${id}`);
    if (!context) return;
    const nextEntries = before.entries.filter((entry) => entry.kind !== 'section' || entry.id !== id);
    if (nextEntries.length === before.entries.length) return;
    const fallback = fallbackForRemovedEntry(context);
    focusUndoFallback(fallback);
    const message = 'Section removed.';
    applyDraft({ ...before, entries: nextEntries }, true, [{
      kind: 'remove-entry',
      key: `section:${id}`,
    }], {
      inverse: {
        kind: 'order',
        restored: captureAlbumDraft(before),
        message,
        input: undoInputFromClickDetail(clickDetail),
        fallback,
      },
    });
    setAnnouncement(message);
  }

  function resetOrder(clickDetail: number) {
    if (!undo.canPresent) return;
    const before = draftRef.current;
    const entries = timelineOrderedEntries(before.entries);
    const liveIds = livePhotoIds(entries);
    const next = {
      ...before,
      entries,
      coverMediaId: before.coverMediaId && liveIds.has(before.coverMediaId)
        ? before.coverMediaId
        : null,
    };
    if (draftKey(next) === draftKey(before)) return;
    const fallback = fallbackForEntryKey(entries[0] ? entryKey(entries[0]) : null)
      ?? leaveHeadingRef.current;
    focusUndoFallback(fallback);
    const message = 'Album order reset to the timeline. Sections were removed.';
    applyDraft(next, true, [{ kind: 'reset-entries' }], {
      inverse: {
        kind: 'order',
        restored: captureAlbumDraft(before),
        message,
        input: undoInputFromClickDetail(clickDetail),
        fallback,
      },
    });
    setAnnouncement(message);
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
      const inverseCandidate = pendingInverse.current;
      if (
        inverseCandidate?.kind === 'photo'
        && inverseCandidate.cursor === operationCursor.current
      ) {
        const classification = classifyQueuedInverse(inverseCandidate, refreshed.album);
        pendingInverse.current = null;
        if (classification.kind === 'unrelated') {
          canonicalTrusted.current = false;
          setNotice('The Album changed while the photo removal was being confirmed. Reload the Album before changing it again.');
          invalidateGalleryAfterMutation();
          return true;
        }
        adoptCanonical(refreshed.album, true);
        if (classification.kind === 'offer') {
          presentAlbumInverse(
            inverseCandidate.message,
            inverseCandidate.input,
            inverseCandidate.fallback,
            classification.payload,
          );
        }
        canonicalTrusted.current = true;
        reconciliationFailureRef.current = null;
        setReconciliationFailure(null);
        setNotice(null);
        onAccessFailure?.(null);
        return true;
      }
      if (queue.state().status === 'saved') {
        adoptCanonical(refreshed.album);
      } else {
        const merged = mergeCanonicalMembership(draftRef.current, refreshed.album);
        revisionRef.current = refreshed.album.revision;
        canonicalAlbumRef.current = refreshed.album;
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

  async function removePhoto(
    entry: Extract<AlbumEntryView, { kind: 'photo' }>,
    clickDetail: number,
  ) {
    const photoId = entry.photo.id;
    if (!undo.canPresent || pendingPickIds.has(photoId)) return;
    const context = removedEntryContext(draftRef.current.entries, `photo:${photoId}`);
    if (!context) return;
    const fallback = fallbackForRemovedEntry(context);
    // Claim the single recovery slot before the direct membership request can
    // yield; otherwise an older inverse could start and reject this replacement.
    undo.dismiss();
    focusUndoFallback(fallback);
    setPendingPickIds((current) => new Set(current).add(photoId));
    try {
      await setAlbumPicks(eventId, [photoId], false);
      const audienceChanged = audienceChangedRef.current;
      audienceChanged?.();
      canonicalTrusted.current = false;
      const current = draftRef.current;
      const currentContext = removedEntryContext(current.entries, `photo:${photoId}`);
      if (!currentContext) {
        await refreshAfterMembership('The photo was removed from Album, but the Album could not be refreshed. Try again in a moment.');
        onPicksChanged();
        return;
      }
      const next: AlbumDraft = {
        ...current,
        entries: current.entries.filter((item) => item.kind !== 'photo' || item.photo.id !== photoId),
        coverMediaId: current.coverMediaId === photoId ? null : current.coverMediaId,
      };
      const message = '1 photo removed from Album. The delivered photo remains.';
      applyDraft(next, true, [{ kind: 'remove-entry', key: `photo:${photoId}` }], {
        audienceChangeAlreadyConfirmed: audienceChanged !== undefined,
        inverse: {
          kind: 'photo',
          mediaId: photoId,
          restored: captureAlbumDraft(current),
          message,
          input: undoInputFromClickDetail(clickDetail),
          fallback,
        },
      });
      setAnnouncement(message);
      await queue.waitForSettled();
      await refreshAfterMembership('The photo was removed from Album, but the Album could not be refreshed. Use Undo or try again in a moment.');
      onPicksChanged();
    } catch (caught) {
      setNotice(errorMessage(caught, 'That photo could not be removed from Album.'));
    } finally {
      setPendingPickIds((current) => {
        const next = new Set(current);
        next.delete(photoId);
        return next;
      });
    }
  }

  async function choose(
    start: 'from-picks' | 'empty',
    clickDetail: number,
    observedAlbum: AlbumView | null = canonicalAlbumRef.current,
    automatic = false,
  ) {
    const expectedReconciliation = observedAlbum?.reconciliation;
    if (
      starting
      || !undo.canPresent
      || !observedAlbum
      || !expectedReconciliation
      || (start === 'from-picks' && expectedReconciliation.kind === 'over-capacity')
      || (automatic && autoStartAttemptedEvent.current === eventId)
    ) return;
    const startGeneration = draftGeneration.current;
    const request: AlbumStartRequest = {
      start,
      expectedReconciliation: expectedReconciliation.kind,
      expectedPickGeneration: observedAlbum.pickGeneration,
      expectedRevision: observedAlbum.revision,
    };
    let settledCurrentGeneration = false;
    const before = draftRef.current;
    const capturedBefore = captureAlbumDraft(before);
    undo.dismiss();
    setStarting(true);
    try {
      // Consume the StrictMode/event latch only after every shared owner permits
      // this exact observation to dispatch. A running Manager Undo can then settle
      // and let the still-current initialize projection make its one attempt.
      if (automatic) autoStartAttemptedEvent.current = eventId;
      const result = await startAlbum(eventId, request);
      if (startGeneration !== draftGeneration.current) return;
      settledCurrentGeneration = true;
      if (!result.started) {
        adoptCanonical(result.album, true);
        audienceChangedRef.current?.();
        onPicksChanged();
        setAnnouncement('The Album was already started. The current version is open now.');
        return;
      }
      if (start === 'empty') {
        const message = result.cleared.length > 0
          ? 'The Album starts empty. The Album picks were cleared.'
          : 'The Album starts empty.';
        setAnnouncement(message);
        const forward = inverseStateFromAlbum(result.album);
        const cleared = new Set(result.cleared);
        const capturedLiveIds = before.entries
          .filter(isPhotoEntry)
          .map((entry) => entry.photo.id);
        const exactForward = forward.saved
          && forward.entries.length === 0
          && forward.title === capturedBefore.title
          && forward.description === capturedBefore.description
          && forward.coverMediaId === null
          && cleared.size === result.cleared.length
          && cleared.size === capturedLiveIds.length
          && capturedLiveIds.every((mediaId) => cleared.has(mediaId));
        if (result.cleared.length > 0 && exactForward) {
            const membershipRestored = inverseStateFromCapture(
              capturedBefore,
              forward.revision,
              true,
            );
            const restored = inverseStateFromCapture(
              capturedBefore,
              forward.revision + 1,
              true,
            );
            pendingStartInverse.current = {
              message,
              input: undoInputFromClickDetail(clickDetail),
              payload: {
                kind: 'membership-order',
                mediaIds: [...result.cleared],
                forward,
                membershipRestored,
                restored,
              },
            };
        } else if (capturedLiveIds.length > 0 || result.cleared.length > 0) {
          invalidateGalleryAfterMutation();
        }
      } else {
        setAnnouncement(`The Album starts from ${result.album.photoCount} picked photo${result.album.photoCount === 1 ? '' : 's'}.`);
      }
      if (pendingStartInverse.current) {
        // Leave preparation is awaiting this tracked mutation. Commit the editor
        // before that promise can resume, then hand the frozen offer to Manager;
        // otherwise automatic batching can unmount Album before its layout work.
        flushSync(() => adoptCanonical(result.album, true));
        presentPendingStartAlbumInverse();
      } else {
        adoptCanonical(result.album, true);
      }
      audienceChangedRef.current?.();
      onPicksChanged();
    } catch (caught) {
      if (startGeneration !== draftGeneration.current) return;
      settledCurrentGeneration = true;
      if (caught instanceof ClientApiError && caught.code === 'REVISION_CONFLICT') {
        conflictEpoch.current += 1;
        canonicalTrusted.current = false;
        setNotice(caught.message);
        try {
          await loadCanonical();
        } catch {
          // The canonical loader owns classification and recovery. In particular,
          // do not turn a conflict into an automatic second Start attempt.
        }
        return;
      }
      setNotice(errorMessage(caught, 'The Album could not be started.'));
    } finally {
      if (settledCurrentGeneration) setStarting(false);
    }
  }

  useEffect(() => {
    if (!active || album?.reconciliation?.kind !== 'initialize') return;
    if (!undo.canPresent) return;
    if (autoStartAttemptedEvent.current === eventId) return;
    void trackOperation(() => choose('from-picks', 0, album, true));
  }, [active, album, eventId, undo.canPresent]);

  async function togglePreview() {
    if ((await settleDraft()).status !== 'ready') return;
    setPreviewOpen((current) => !current);
  }

  function requestCreateShare() {
    if (currentShare.current || shareOperationPending.current || createShareOpen.current) return;
    const active = document.activeElement;
    createShareOriginRef.current = active instanceof HTMLElement ? active : null;
    const current = draftRef.current;
    createShareOpen.current = true;
    setCreateShareError(null);
    setCreateShareSnapshot({
      photoCount: current.entries.filter(isPhotoEntry).length,
      publishedCaptionCount: current.entries.filter((entry) => (
        entry.kind === 'photo'
        && entry.photo.publicationStatus === 'published'
        && Boolean(entry.photo.caption?.trim())
      )).length,
    });
  }

  function cancelCreateShare() {
    if (shareOperationPending.current) return;
    createShareOpen.current = false;
    setCreateShareSnapshot(null);
    setCreateShareError(null);
    setCreateShareReturnFocusRequest((current) => current + 1);
  }

  /**
   * Opening either link confirmation sends nothing — not a credential request,
   * not a revocation, and not a draft flush. Only its explicit answer can write.
   */
  function requestStopShare() {
    if (!currentShare.current || shareOperationPending.current) return;
    const active = document.activeElement;
    stopShareOriginRef.current = active instanceof HTMLElement ? active : null;
    setStopShareError(null);
    setConfirmingStopShare(true);
  }

  function keepSharing() {
    if (shareOperationPending.current) return;
    setConfirmingStopShare(false);
    setStopShareError(null);
    stopShareOriginRef.current?.focus();
    stopShareOriginRef.current = null;
  }

  async function confirmStopShare() {
    // Two taps on one destructive control are one revocation. The ref is checked and
    // set synchronously, before any await, so the second activation cannot slip past.
    if (shareOperationPending.current || !currentShare.current) return;
    const operationGeneration = ++shareRequestGeneration.current;
    shareOperationPending.current = true;
    setSharePending(true);
    setStopShareError(null);
    try {
      await stopAlbumShare(eventId);
      audienceChangedRef.current?.();
      if (operationGeneration === shareRequestGeneration.current) adoptShare(null);
      setConfirmingStopShare(false);
      stopShareOriginRef.current = null;
      setNotice(null);
      setAnnouncement('The Album link was stopped. People with the old link cannot open it now, and the Album itself is unchanged.');
      setStopShareFocusRequest((current) => current + 1);
    } catch (caught) {
      setStopShareError(errorMessage(caught, 'The Album link could not be stopped.'));
    } finally {
      shareOperationPending.current = false;
      setSharePending(false);
    }
  }

  async function confirmCreateShare() {
    if (shareOperationPending.current || currentShare.current || !createShareOpen.current) return;
    shareOperationPending.current = true;
    setSharePending(true);
    setCreateShareError(null);
    try {
      const ready = await settleDraft({ focusRecovery: false });
      if (ready.status !== 'ready') {
        createShareOpen.current = false;
        setCreateShareSnapshot(null);
        setCreateShareError(null);
        createShareOriginRef.current = null;
        setCreateShareRecoveryRequest((current) => current + 1);
        return;
      }
      // The initial status read can settle while the draft does. A fetched active
      // share is authoritative and turns this confirmed attempt into no operation.
      if (currentShare.current || !createShareOpen.current) return;
      const operationGeneration = ++shareRequestGeneration.current;
      const result = await shareAlbum(eventId);
      audienceChangedRef.current?.();
      if (operationGeneration !== shareRequestGeneration.current) return;
      adoptShare(result.share);
      createShareOpen.current = false;
      setCreateShareSnapshot(null);
      setCreateShareError(null);
      createShareOriginRef.current = null;
      setNotice(null);
      setAnnouncement('Album link is Live.');
      setShareCopyFocusRequest((current) => current + 1);
    } catch (caught) {
      setCreateShareError(errorMessage(caught, 'The Album link could not be created.'));
    } finally {
      shareOperationPending.current = false;
      setSharePending(false);
    }
  }

  const prepareAlbumExport = useCallback(async () => {
    if ((await settleDraft()).status !== 'ready') return;
    await onPrepareExport();
  }, [onPrepareExport, settleDraft]);

  if (loading && !hasLoaded.current) return <LoadingState label="Opening the album…" live={false} />;
  if (loadFailure) {
    return <div className="gallery-album" ref={rootRef}>
      <h3 className="section-label" ref={leaveHeadingRef} tabIndex={-1}>Album</h3>
      <ErrorState
        message={loadFailure.message}
        recoveryHint={loadFailure.recoveryHint}
        onRetry={loadFailure.retryable ? () => { void loadCanonical(); } : undefined}
      />
    </div>;
  }

  const photos = draft.entries.filter(isPhotoEntry);
  const photoCount = photos.length;
  const emptySections = emptySectionIds(draft.entries);
  const retainedSlots = draft.entries.filter(isRetainedEntry);
  const retainedCount = retainedSlots.length;
  const explicitCover = draft.coverMediaId
    ? photos.find((entry) => entry.photo.id === draft.coverMediaId)?.photo ?? null
    : null;
  /**
   * The cover the host chose is in Recently deleted.
   *
   * The reference is kept rather than silently dropped, so a timely Restore returns
   * the same photograph to the cover; until then `effectiveCover` falls through to
   * the first visible photo, which is what a recipient would actually see.
   */
  const coverRetainedSlot: AlbumRetainedSlotView | null = draft.coverMediaId === null
    ? null
    : retainedSlots.find((entry) => entry.slot.mediaId === draft.coverMediaId)?.slot
      ?? (album?.coverRetained?.mediaId === draft.coverMediaId ? album.coverRetained : null);
  const coverRetainedExpired = coverRetainedSlot !== null && retainedSlotExpired(coverRetainedSlot, deadlineNow);
  const coverRetainedDeadline = coverRetainedSlot
    ? retentionDisplay(coverRetainedSlot.restoreUntil, eventTimezone)
    : null;
  const effectiveCover = explicitCover ?? photos[0]?.photo ?? null;
  const effectiveCoverId = effectiveCover?.id ?? null;
  const reconciliation = album?.reconciliation ?? null;
  const initializeRecoveryAvailable = reconciliation?.kind === 'initialize'
    && autoStartAttemptedEvent.current === eventId
    && !starting;
  const currentPickCount = photoCount + retainedCount;
  const overCapacityReason = reconciliation?.kind === 'over-capacity'
    ? `Start from picks is unavailable because ${reconciliation.pickCount} picks exceed the ${ALBUM_MAX_ENTRIES}-entry Album limit.`
    : null;
  const albumDetailsExpanded = wide || albumDetailsOpen;
  const visibleAutosave = effectiveAlbumAutosaveState(
    autosave,
    loading,
    pendingOperationCount,
    reconciliationFailure ?? loadFailure,
  );
  /**
   * One element, rendered in one of two places. Portalling it keeps the ref, the
   * disabled rule and both confirmations with the component that owns the link, so
   * the docked control is the same button rather than a copy of it.
   */
  const shareAction = <button
    type="button"
    ref={shareActionRef}
    className="button button--secondary"
    disabled={(!share && photoCount === 0) || sharePending}
    onClick={() => { if (share) requestStopShare(); else requestCreateShare(); }}
  ><Link aria-hidden="true" /> {share
    ? 'Stop Album link'
    : sharePending ? 'Creating Album link…' : 'Create Album link'}</button>;

  let photoPosition = 0;
  return <div className="gallery-album" ref={rootRef}>
    <h3 className="section-label" ref={leaveHeadingRef} tabIndex={-1}>Album</h3>
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

    {reconciliation?.kind === 'initialize'
      ? <>
          <p className="album-not-started">Not started yet</p>
          <section className="album-reconcile" aria-labelledby="album-reconcile-title">
            <p className="section-label">Preparing Album</p>
            <h3 id="album-reconcile-title">Starting your Album</h3>
            {initializeRecoveryAvailable
              ? <>
                  <p>The Album still needs to be started from the current picks.</p>
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={!undo.canPresent}
                    onClick={(click) => {
                      void trackOperation(() => choose('from-picks', click.detail, album));
                    }}
                  >Try starting from current picks</button>
                </>
              : <p role="status" aria-label="Starting the Album from current picks…">
                  Starting the Album from current picks…
                </p>}
          </section>
        </>
      : reconciliation?.kind === 'historical'
        ? <>
            <p className="album-not-started">Not started yet</p>
            <section className="album-reconcile" aria-labelledby="album-reconcile-title">
              <p className="section-label">Earlier Album picks</p>
              <h3 id="album-reconcile-title">
                {reconciliation.historicalPickCount} existing pick{reconciliation.historicalPickCount === 1 ? '' : 's'} from before this update.
              </h3>
              <p>
                This choice applies to every Album pick that exists now. Start from them to keep
                their timeline order and use the first visible photo as the cover. Nothing is
                published either way, and you can add or remove photos afterwards.
              </p>
              <div className="album-reconcile__actions">
                <button
                  type="button"
                  className="button button--primary"
                  disabled={starting || !undo.canPresent}
                  onClick={(click) => { void trackOperation(() => choose('from-picks', click.detail)); }}
                >Start the Album from {currentPickCount === 1 ? 'it' : 'them'}</button>
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={starting || !undo.canPresent}
                  onClick={(click) => { void trackOperation(() => choose('empty', click.detail)); }}
                >Start empty</button>
              </div>
              <small>Starting empty clears those Album picks. It never deletes a delivered photo.</small>
            </section>
          </>
        : reconciliation?.kind === 'over-capacity'
          ? <>
              <p className="album-not-started">Not started yet</p>
              <section className="album-reconcile" aria-labelledby="album-reconcile-title">
                <p className="section-label">Album capacity</p>
                <h3 id="album-reconcile-title">
                  {reconciliation.pickCount} existing picks cannot fit in this Album.
                </h3>
                <p id="album-reconcile-capacity-reason">{overCapacityReason}</p>
                <div className="album-reconcile__actions">
                  <button
                    type="button"
                    className="button button--primary"
                    aria-disabled="true"
                    aria-describedby="album-reconcile-capacity-reason"
                    onClick={(click) => click.preventDefault()}
                  >Start the Album from {reconciliation.pickCount === 1 ? 'it' : 'them'}</button>
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={starting || !undo.canPresent}
                    onClick={(click) => { void trackOperation(() => choose('empty', click.detail)); }}
                  >Start empty</button>
                </div>
                <small>Starting empty clears those Album picks. It never deletes a delivered photo.</small>
              </section>
            </>
          : <>
          <div className="album-autosave-row">
            <AutosaveStatus
              label="Album"
              state={visibleAutosave}
              blockingField={invalidTitle ? { label: 'Album title', message: 'Give this album a title.' } : null}
              onRetry={() => applyDraft(draftRef.current, true)}
              live={false}
            />
            {/* A trashed photo has not given its place back. Saying so here is the only
                honest version of "how full is this album", and it is where a host
                looks before deciding they have room for more. */}
            <span>{photoCount} photo{photoCount === 1 ? '' : 's'} In Album{retainedCount > 0
              ? `, and ${retainedCount} recently deleted photo${retainedCount === 1 ? '' : 's'} still holding a place`
              : ''}</span>
          </div>

          {previewOpen
            ? <AlbumPreview
                eventId={eventId}
                revision={album?.revision ?? 0}
                onAnnouncement={onAnnouncement}
              />
            : <div className="album-editor">
                <section className="album-metadata" aria-label="Album details">
                  {/*
                    A host opens the Album to reorder it, not to retype its title, so on a
                    phone the details fold away and the order starts near the top.

                    A real button over a conditional body, never a `<details>`: setting
                    `details.open` imperatively can strand a collapsed block from 761,
                    where the summary is hidden and nothing is left to reopen it.
                  */}
                  <button
                    type="button"
                    className="album-metadata__summary"
                    aria-expanded={albumDetailsExpanded}
                    aria-controls="album-metadata-body"
                    onClick={() => setAlbumDetailsOpen((current) => !current)}
                  >Album details</button>
                  {albumDetailsExpanded && <div className="album-metadata__body" id="album-metadata-body">
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
                      {coverRetainedSlot && coverRetainedDeadline && <small className="album-cover__retained">
                        <strong>Your chosen cover is a {RETAINED_SLOT_NAME.toLowerCase()}.</strong>{' '}
                        {coverRetainedExpired
                          ? <>{RETAINED_SLOT_EXPIRED}. Recovery ended{' '}
                              <RetentionInstant display={coverRetainedDeadline} />, so the first photo
                              stays the cover. Star another photo to choose a different one.</>
                          : <>Restore it in Recently deleted by{' '}
                              <RetentionInstant display={coverRetainedDeadline} /> and it is the cover
                              again. Until then people with the Album link see the first photo, and starring another photo
                              replaces the choice.</>}
                      </small>}
                      {(explicitCover || coverRetainedSlot) && <button
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
                        placeholder={eventName}
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
                      <small>People with the Album link see this. It is optional.</small>
                    </div>
                  </div>}
                </section>

                <div className="album-order-heading">
                  <button type="button" className="button button--secondary" onClick={addSection}>
                    <Plus aria-hidden="true" /> Add a section
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={!undo.canPresent}
                    aria-describedby="album-reset-consequence"
                    onClick={(click) => resetOrder(click.detail)}
                  >
                    Reset to timeline order
                  </button>
                </div>
                <small id="album-reset-consequence">
                  Reset removes every section and can be undone for {UNDO_WINDOW_MS / 1_000} seconds.
                </small>

                {draft.entries.length === 0
                  ? <div className="empty-state">
                      <h3>The Album is empty.</h3>
                      <p>Pick photos in Library. Each pick makes a photo In Album for every host on this event. It does not publish to the Guest gallery.</p>
                      <button type="button" className="button button--secondary" onClick={onGoToLibrary}>Go to Library</button>
                    </div>
                  : <ol
                      className="album-review-grid"
                      ref={listRef}
                      onFocusCapture={(focusEvent) => {
                        const focusedEntry = (focusEvent.target as HTMLElement)
                          .closest<HTMLElement>('[data-entry-key]');
                        const key = focusedEntry?.dataset.entryKey;
                        if (key) lastFocusedEntryKey.current = key;
                      }}
                    >
                      {draft.entries.map((entry, index) => {
                        const key = entryKey(entry);
                        const name = entryName(entry);
                        const earlierUnavailable = index === 0;
                        const laterUnavailable = index === draft.entries.length - 1;
                        // Retained slots are not numbered: the number is the guest's
                        // reading position, and the public album omits the marker.
                        if (entry.kind === 'photo') photoPosition += 1;
                        const position = photoPosition;
                        const isCover = entry.kind === 'photo' && entry.photo.id === effectiveCoverId;
                        const previewFailed = entry.kind === 'photo'
                          && failedPreviewIds.has(entry.photo.id);
                        const retainedDeadline = entry.kind === 'photo-retained'
                          ? retentionDisplay(entry.slot.restoreUntil, eventTimezone)
                          : null;
                        const retainedExpired = entry.kind === 'photo-retained'
                          && retainedSlotExpired(entry.slot, deadlineNow);
                        return <li
                          key={key}
                          data-entry-key={key}
                          data-gallery-anchor-id={key}
                          className={entry.kind === 'section'
                            ? 'album-review-grid__section'
                            : entry.kind === 'photo-retained'
                              ? 'album-review-grid__photo album-review-grid__photo--retained'
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
                            if (from >= 0 && to >= 0) move(from, to, from < to ? 'later' : 'earlier');
                          }}
                          onDragEnd={(dragEvent) => {
                            dragKey.current = null;
                            dragEvent.dataTransfer?.clearData();
                          }}
                        >
                          {entry.kind === 'section'
                            ? <>
                                <span className="album-section__marker" aria-hidden="true" />
                                <div className="album-section__field">
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
                                  {emptySections.has(entry.id) && <small className="album-section__empty-note">
                                    Empty section—omitted from the Album link
                                  </small>}
                                </div>
                                <span className="album-section__rule" aria-hidden="true" />
                              </>
                            : entry.kind === 'photo-retained'
                            /* Opaque on purpose. The host took this photograph out of
                               view, so no image, caption, contributor or filename
                               belongs here — only that the place is still held. */
                            ? <>
                                <div className="album-review-grid__preview">
                                  <div className="album-review-grid__fallback album-review-grid__retained" aria-hidden="true">
                                    <Trash2 />
                                    <span>Not shown</span>
                                  </div>
                                </div>
                                <span className="album-review-grid__meta">
                                  <strong>{RETAINED_SLOT_NAME}</strong>
                                </span>
                                <small className="album-entry__retained-note">
                                  {retainedExpired
                                    ? <>
                                        <span className="album-entry__retained-state">{RETAINED_SLOT_EXPIRED}</span>
                                        {' '}Recovery ended{' '}
                                        {retainedDeadline && <RetentionInstant display={retainedDeadline} />}
                                        . Its place is held here until cleanup runs.
                                      </>
                                    : <>
                                        Its place is held here. Recovery ends{' '}
                                        {retainedDeadline && <RetentionInstant display={retainedDeadline} />}
                                        .
                                      </>}
                                </small>
                                {!retainedExpired && onOpenRecentlyDeleted && <button
                                  type="button"
                                  className="text-button album-entry__retained-open"
                                  onClick={() => onOpenRecentlyDeleted(entry.slot.mediaId)}
                                >Restore in Recently deleted</button>}
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
                              aria-disabled={earlierUnavailable}
                              aria-label={`Move ${name} earlier`}
                              onClick={() => {
                                if (earlierUnavailable) return;
                                move(index, index - 1, 'earlier');
                              }}
                              onKeyDown={(pressed) => {
                                if (earlierUnavailable && (pressed.key === 'Enter' || pressed.key === ' ')) {
                                  pressed.preventDefault();
                                }
                              }}
                            >{entry.kind === 'section'
                              ? <ChevronUp aria-hidden="true" />
                              : <ChevronLeft aria-hidden="true" />}</button>
                            <button
                              type="button"
                              className="icon-button album-entry__move-later"
                              aria-disabled={laterUnavailable}
                              aria-label={`Move ${name} later`}
                              onClick={() => {
                                if (laterUnavailable) return;
                                move(index, index + 1, 'later');
                              }}
                              onKeyDown={(pressed) => {
                                if (laterUnavailable && (pressed.key === 'Enter' || pressed.key === ' ')) {
                                  pressed.preventDefault();
                                }
                              }}
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
                            {/* A retained slot has no Remove: the row is held for recovery, and
                                dropping the marker would be a deletion the host did not ask for.
                                Recently deleted owns what happens to it next. */}
                            {entry.kind !== 'photo-retained' && <button
                              type="button"
                              className="icon-button album-entry__remove"
                              disabled={!undo.canPresent
                                || (entry.kind === 'photo' && pendingPickIds.has(entry.photo.id))}
                              aria-label={entry.kind === 'section'
                                ? `Remove section ${name}`
                                : `Remove ${name} from Album`}
                              onClick={(click) => {
                                if (entry.kind === 'section') removeSection(entry.id, click.detail);
                                else void trackOperation(() => removePhoto(entry, click.detail));
                              }}
                            ><X aria-hidden="true" /></button>}
                          </span>
                        </li>;
                      })}
                    </ol>}
              </div>}

          <section className="album-exits" aria-labelledby="album-exits-title">
            <p className="section-label" id="album-exits-title" ref={shareHeadingRef} tabIndex={-1}>When the Album is right</p>
            <div className="album-exits__controls">
              <button
                type="button"
                className="button button--secondary"
                disabled={photoCount === 0}
                onClick={() => { void togglePreview(); }}
              ><Eye aria-hidden="true" /> {previewOpen ? 'Back to editing' : 'Preview album'}</button>
              {actionDock === null && shareAction}
              <AlbumExportControl
                job={exportJob}
                activeJob={activeExport}
                download={exportDownload}
                eventTimezone={eventTimezone ?? 'UTC'}
                currentSource={exportSource}
                onPrepare={prepareAlbumExport}
                onDownload={onDownloadExport}
                onRetry={onRetryExport}
                live={false}
              />
            </div>

            {actionDock !== null && createPortal(shareAction, actionDock)}

            {share && <div className="album-share">
              <p>
                People with the Album link can see the saved Album. The Guest gallery is separate,
                and this link does not change what event guests see there.
              </p>
              <CopyableLinkCard
                ref={shareCopyRef}
                label="Album link"
                controlNoun="Album link"
                value={share.url}
                sensitive
              />
            </div>}
          </section>
        </>}

    {/*
      Creation and revocation reuse the same focused Manager confirmation contract.
      Each dialog states its own consequence before any request is sent.
    */}
    {createShareSnapshot && createPortal(<div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(press) => { if (press.target === press.currentTarget) cancelCreateShare(); }}
    >
      <div
        className="modal-card"
        ref={shareConfirmRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="album-create-share-title"
        aria-describedby="album-create-share-body"
        aria-busy={sharePending}
      >
        <h2 id="album-create-share-title">Create the Album link?</h2>
        <div id="album-create-share-body">
          <p>
            This link will show {createShareSnapshot.photoCount} photo{createShareSnapshot.photoCount === 1 ? '' : 's'} and{' '}
            {createShareSnapshot.publishedCaptionCount} published caption{createShareSnapshot.publishedCaptionCount === 1 ? '' : 's'}{' '}
            to people with the Album link.
          </p>
          <p>
            The Album link is a live view. Later saved changes to Album membership, metadata,
            sections, and order affect what people see when they request it.
          </p>
          <p>
            The Guest gallery is separate. Creating this link does not publish photos there or
            change what event guests can see.
          </p>
        </div>
        {createShareError && <p
          className="form-error"
          role="alert"
          tabIndex={-1}
          ref={createShareErrorRef}
        >{createShareError}</p>}
        <div className="modal-actions">
          <button
            type="button"
            ref={cancelCreateShareRef}
            className="button button--secondary"
            aria-disabled={sharePending}
            onClick={cancelCreateShare}
          >Cancel</button>
          <button
            type="button"
            className="button button--primary"
            aria-disabled={sharePending}
            onClick={() => { void confirmCreateShare(); }}
          >{sharePending ? 'Creating Album link' : 'Create Album link'}</button>
        </div>
      </div>
    </div>, confirmHost)}

    {confirmingStopShare && share && createPortal(<div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(press) => { if (press.target === press.currentTarget) keepSharing(); }}
    >
      <div
        className="modal-card"
        ref={shareConfirmRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="album-stop-share-title"
        aria-describedby="album-stop-share-body"
        aria-busy={sharePending}
      >
        <h2 id="album-stop-share-title">Stop the Album link?</h2>
        <div id="album-stop-share-body">
          <p>
            Every request from people with the Album link stops working immediately, and so does
            every session already opened with it.
          </p>
          <p>
            A page someone still has open may keep the photographs it already loaded, and copies
            already loaded or downloaded cannot be recalled.
          </p>
          <p>This link cannot be brought back. You can create a new Album link afterwards.</p>
          <p>
            Delivered photos and the Album arrangement are unchanged. The Guest gallery is
            separate, and what event guests see there is unchanged.
          </p>
        </div>
        {stopShareError && <p
          className="form-error"
          role="alert"
          tabIndex={-1}
          ref={stopShareErrorRef}
        >{stopShareError}</p>}
        <div className="modal-actions">
          {/* Initial focus, and never the destructive one. */}
          <button
            type="button"
            ref={keepSharingRef}
            className="button button--secondary"
            onClick={keepSharing}
          >Keep sharing</button>
          <button
            type="button"
            className="button button--danger"
            aria-disabled={sharePending}
            onClick={() => { void confirmStopShare(); }}
          >{sharePending ? 'Stopping Album link' : 'Stop Album link'}</button>
        </div>
      </div>
    </div>, confirmHost)}
  </div>;
});
