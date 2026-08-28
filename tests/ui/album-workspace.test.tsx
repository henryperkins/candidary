import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createRef,
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_GUESTBOOK_PROMPT, MANAGER_BULK_SELECTION_MAX } from '../../shared/constants';
import type {
  AlbumEntryInput,
  AlbumEntryView,
  AlbumMetadataInput,
  AlbumRetainedSlotView,
  AlbumShareStatus,
  AlbumShareView,
  AlbumView,
  EventView,
  ExportKind,
  GalleryAudienceSummaryView,
  ManagerGalleryMediaView,
  PublicAlbumEntryView,
  PublicAlbumView,
} from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import {
  ManagerAlbum,
  type AlbumLeavePreparation,
  type ManagerAlbumHandle,
} from '../../src/features/gallery/ManagerAlbum';
import {
  ManagerGalleryWorkspace,
  type ManagerGalleryWorkspaceHandle,
} from '../../src/features/gallery/ManagerGalleryWorkspace';
import { ManagerSharedGallery } from '../../src/features/gallery/ManagerSharedGallery';
import { SelectionTray } from '../../src/features/gallery/SelectionTray';
import {
  ManagerUndoBar,
  ManagerUndoProvider,
  UNDO_FAILED_MESSAGE,
  UNDO_WINDOW_MS,
  useManagerUndo,
} from '../../src/features/gallery/undo';
import { useDeadlineClock } from '../../src/app/use-deadline-clock';
import { api } from '../../src/app/api';
import type { LoadFailure } from '../../src/components/States';
import { UnsavedSettingsPrompt } from '../../src/components/UnsavedSettingsPrompt';
import type { ExportDownloadView, ExportView, MediaView } from '../../src/app/types';
import { useManagerResource } from '../../src/features/manager/resources';
import type { GalleryMode } from '../../src/app/manager-location';
import {
  runAlbumInverse,
  toEntryInput,
  type AlbumInversePayload,
  type AlbumInverseState,
} from '../../src/features/gallery/album-api';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
});

function installClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

function success(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

function failure(message: string, status = 500, code = 'INTERNAL_ERROR') {
  return Promise.resolve(new Response(JSON.stringify({
    code, message, requestId: 'request-a',
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

const event: EventView = {
  id: 'event-a',
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.',
  guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
  cover: {
    config: { version: 1, source: { kind: 'none' } },
    revision: 0,
    hasCover: false,
    available2xProfiles: [],
    surfaceTreatment: 'none',
    preparation: null,
  },
  uploadsEnabled: true,
  galleryVisible: true,
  moderationRequired: true,
  reservedMediaCount: 0,
  storedMediaCount: 4,
  reservedBytes: 0,
  storedBytes: 1024,
  recoverableMediaCount: 0,
  recoverableBytes: 0,
  hostUploadAvailability: { enabled: true, reason: null },
  guestAccessExpiresAt: '2026-10-19T00:00:00Z',
  managementAccessExpiresAt: '2026-12-18T00:00:00Z',
  managerLinkRevision: 0,
  managerLinkRotationAvailability: { enabled: true, reason: null },
  purgeAfter: '2027-01-17T00:00:00Z',
  createdAt: '2026-08-01T00:00:00Z',
  deletedAt: null,
  eventTimezone: 'America/Chicago',
  eventStartAt: '2026-09-19T22:00:00.000Z',
  eventStartTime: '17:00',
  photosOpen: true,
  photoIntakeState: 'open',
  photoIntakeRecheckAfterMs: null,
  rsvpEnabled: false,
  rsvpDeadlineAt: null,
  rsvpDeadlineDate: null,
  rsvpRosterVersion: 0,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
};

type GalleryFixtureMedia = ManagerGalleryMediaView & Pick<MediaView, 'uploadState'>;

function photo(id: string, timelineAt: string, overrides: Partial<GalleryFixtureMedia> = {}): GalleryFixtureMedia {
  return {
    id,
    originalFilename: `${id}.jpg`,
    guestName: 'Jose',
    caption: null,
    publicationStatus: 'unpublished',
    uploadState: 'stored',
    previewAvailable: true,
    width: null,
    height: null,
    receivedAt: timelineAt,
    timelineAt,
    timelineSource: 'received',
    isFavorite: false,
    ...overrides,
  };
}

interface AlbumState {
  revision: number;
  saved: boolean;
  entries: AlbumEntryView[];
  pickGeneration?: number;
  reconciliation?: AlbumView['reconciliation'];
  title?: string;
  description?: string;
  coverMediaId?: string | null;
}

type AlbumStartRequest = {
  start: 'from-picks' | 'empty';
  expectedReconciliation: Exclude<AlbumView['reconciliation'], null>['kind'];
  expectedPickGeneration: number;
  expectedRevision: number;
};

/**
 * The media a slot holds, whether the photograph is still visible or retained.
 *
 * A retained slot occupies the same album position the photo did, so both kinds
 * answer with the same media id and only sections answer with none.
 */
function entryMediaId(entry: AlbumEntryView): string | null {
  if (entry.kind === 'photo') return entry.photo.id;
  if (entry.kind === 'photo-retained') return entry.slot.mediaId;
  return null;
}

/** What a written entry says it is: a media id for either photo kind, a heading for a section. */
function writtenEntry(entry: AlbumEntryView): string {
  return entryMediaId(entry) ?? (entry as Extract<AlbumEntryView, { kind: 'section' }>).heading;
}

/** The same, but sections identify themselves by id rather than heading. */
function writtenEntryId(entry: AlbumEntryView): string {
  return entryMediaId(entry) ?? (entry as Extract<AlbumEntryView, { kind: 'section' }>).id;
}

function retainedSlot(
  mediaId: string,
  restoreUntil: string,
  state: AlbumRetainedSlotView['state'] = 'recoverable',
  timelineAt = '2026-08-15T22:42:00.000Z',
): AlbumRetainedSlotView {
  return { mediaId, restoreUntil, state, timelineAt };
}

interface Harness {
  galleryRows: ManagerGalleryMediaView[];
  album: AlbumState;
  /**
   * Photos the host moved to Recently deleted, by media id.
   *
   * They are deliberately absent from `galleryRows` — Library does not list them —
   * yet the album still holds their position, so an entry naming one resolves to an
   * opaque retained slot instead of a photograph.
   */
  trashed: Record<string, AlbumRetainedSlotView>;
  albumReads: number;
  previewReads: number;
  albumReadGates: Array<Promise<void> | undefined>;
  albumReadErrors: Array<string | undefined>;
  albumReadErrorCodes: Array<string | undefined>;
  audienceSummary: GalleryAudienceSummaryView;
  audienceReads: number;
  audienceReadGates: Array<Promise<void> | undefined>;
  audienceReadErrors: Array<string | undefined>;
  audienceReadResults: Array<GalleryAudienceSummaryView | undefined>;
  orderWrites: AlbumEntryView[][];
  orderPaths: string[];
  orderRevisions: number[];
  metadataWrites: AlbumMetadataInput[];
  orderGates: Promise<void>[];
  orderErrors: Array<string | undefined>;
  orderErrorCodes: Array<string | undefined>;
  bytesById: Record<string, number>;
  pickWrites: { mediaIds: string[]; picked: boolean }[];
  pickGates: Array<Promise<void> | undefined>;
  pickErrors: Array<string | undefined>;
  startWrites: string[];
  startRequests: AlbumStartRequest[];
  startGates: Array<Promise<void> | undefined>;
  startFailures: Array<{
    message: string;
    code?: string;
    status?: number;
    album?: AlbumState;
  } | undefined>;
  startResults: Array<{
    started: boolean;
    album?: AlbumState;
    cleared?: string[];
  } | undefined>;
  share: AlbumShareStatus;
  shareWrites: Array<'share' | 'stop'>;
  shareGates: Array<Promise<void> | undefined>;
  shareErrors: Array<string | undefined>;
  shareRejects: Array<boolean | undefined>;
  shareReadGates: Array<Promise<void> | undefined>;
  shareReadRejects: Array<boolean | undefined>;
  shareReads: number;
  shareResults: AlbumShareView[];
  publicationWrites: Array<{ ids: string[]; action: 'publish' | 'hide' }>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

/**
 * A stand-in for the album endpoints that keeps the one invariant the real ones do:
 * membership lives in the pick bit, and the album is the picked set read in a stored
 * order. A stub that let the two drift would pass tests the product could not.
 */
function harness(overrides: Partial<Harness> = {}) {
  const state: Harness = {
    galleryRows: overrides.galleryRows ?? [
      photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' }),
      photo('p2', '2026-08-15T23:18:00.000Z'),
      photo('p3', '2026-08-16T04:48:00.000Z', { guestName: 'Maya' }),
    ],
    album: overrides.album ?? { revision: 0, saved: true, entries: [] },
    trashed: overrides.trashed ?? {},
    albumReads: 0,
    previewReads: 0,
    albumReadGates: overrides.albumReadGates ?? [],
    albumReadErrors: overrides.albumReadErrors ?? [],
    albumReadErrorCodes: overrides.albumReadErrorCodes ?? [],
    audienceSummary: overrides.audienceSummary ?? {
      albumPhotoCount: 0,
      albumEntryCount: 0,
      albumLink: { active: false, sharedAt: null },
      guestGalleryVisible: true,
      guestGalleryPublishedCount: 0,
    },
    audienceReads: 0,
    audienceReadGates: overrides.audienceReadGates ?? [],
    audienceReadErrors: overrides.audienceReadErrors ?? [],
    audienceReadResults: overrides.audienceReadResults ?? [],
    orderWrites: [],
    orderPaths: [],
    orderRevisions: [],
    metadataWrites: [],
    orderGates: overrides.orderGates ?? [],
    orderErrors: overrides.orderErrors ?? [],
    orderErrorCodes: overrides.orderErrorCodes ?? [],
    bytesById: overrides.bytesById ?? {},
    pickWrites: [],
    pickGates: overrides.pickGates ?? [],
    pickErrors: overrides.pickErrors ?? [],
    startWrites: [],
    startRequests: [],
    startGates: overrides.startGates ?? [],
    startFailures: overrides.startFailures ?? [],
    startResults: overrides.startResults ?? [],
    share: overrides.share ?? null,
    shareWrites: [],
    shareGates: overrides.shareGates ?? [],
    shareErrors: overrides.shareErrors ?? [],
    shareRejects: overrides.shareRejects ?? [],
    shareReadGates: overrides.shareReadGates ?? [],
    shareReadRejects: overrides.shareReadRejects ?? [],
    shareReads: 0,
    shareResults: overrides.shareResults ?? [],
    publicationWrites: [],
  };

  function resolvedAlbum(): AlbumView {
    const picked = state.galleryRows.filter((item) => item.isFavorite);
    const placed = new Set<string>();
    const entries: AlbumEntryView[] = [];
    for (const entry of state.album.entries) {
      if (entry.kind === 'section') { entries.push(entry); continue; }
      const mediaId = entryMediaId(entry)!;
      if (placed.has(mediaId)) continue;
      // A trashed row keeps its stored position and resolves to the opaque marker.
      // This is the one album read allowed to see a trashed row at all.
      const slot = state.trashed[mediaId];
      if (slot) {
        placed.add(mediaId);
        entries.push({ kind: 'photo-retained', slot });
        continue;
      }
      const live = picked.find((item) => item.id === mediaId);
      if (!live) continue;
      placed.add(live.id);
      entries.push({ kind: 'photo', photo: live });
    }
    for (const item of picked) {
      if (!placed.has(item.id)) entries.push({ kind: 'photo', photo: item });
    }
    const explicitCover = state.album.coverMediaId ?? null;
    const liveIds = new Set(entries.flatMap((entry) => {
      const mediaId = entryMediaId(entry);
      return mediaId === null ? [] : [mediaId];
    }));
    const coverMediaId = explicitCover && liveIds.has(explicitCover) ? explicitCover : null;
    const coverRetained = coverMediaId ? state.trashed[coverMediaId] ?? null : null;
    const firstPhoto = entries.find((entry) => entry.kind === 'photo');
    const firstVisibleId = firstPhoto?.kind === 'photo' ? firstPhoto.photo.id : null;
    const reconciliation = state.album.reconciliation !== undefined
      ? state.album.reconciliation
      : state.album.saved || entries.filter((entry) => entry.kind !== 'section').length === 0
        ? null
        : {
            kind: 'historical' as const,
            historicalPickCount: entries.filter((entry) => entry.kind !== 'section').length,
          };
    return {
      revision: state.album.revision,
      saved: state.album.saved,
      title: state.album.title ?? 'Album',
      description: state.album.description ?? '',
      coverMediaId,
      // The chosen cover keeps its reference while it is retained; what a recipient
      // would actually see falls through to the first visible photo.
      effectiveCoverMediaId: coverRetained ? firstVisibleId : coverMediaId ?? firstVisibleId,
      coverRetained,
      entries,
      photoCount: entries.filter((entry) => entry.kind === 'photo').length,
      retainedCount: entries.filter((entry) => entry.kind === 'photo-retained').length,
      sectionCount: entries.filter((entry) => entry.kind === 'section').length,
      totalBytes: entries.reduce((sum, entry) => (
        entry.kind === 'photo' ? sum + (state.bytesById[entry.photo.id] ?? 64) : sum
      ), 0),
      pickGeneration: state.album.pickGeneration ?? 0,
      reconciliation,
    };
  }

  /**
   * What the Manager Preview endpoint returns: the same projection a recipient link
   * serves. Retained slots are omitted entirely, a section left with no photographs
   * is dropped, and an unpublished caption never crosses the boundary.
   */
  function publicAlbum(): PublicAlbumView {
    const resolved = resolvedAlbum();
    const entries: PublicAlbumEntryView[] = [];
    for (const entry of resolved.entries) {
      if (entry.kind === 'photo-retained') continue;
      if (entry.kind === 'section') { entries.push(entry); continue; }
      entries.push({
        kind: 'photo',
        photo: {
          id: entry.photo.id,
          caption: entry.photo.publicationStatus === 'published' ? entry.photo.caption : null,
          previewAvailable: entry.photo.previewAvailable,
        },
      });
    }
    const kept = entries.filter((entry, index) => (
      entry.kind === 'photo' || entries[index + 1]?.kind === 'photo'
    ));
    return {
      title: resolved.title,
      description: resolved.description,
      coverMediaId: resolved.effectiveCoverMediaId,
      entries: kept,
      photoCount: resolved.photoCount,
    };
  }

  if (!overrides.audienceSummary) {
    const resolved = resolvedAlbum();
    state.audienceSummary = {
      albumPhotoCount: resolved.photoCount,
      albumEntryCount: resolved.entries.length,
      albumLink: state.share
        ? { active: true, sharedAt: state.share.sharedAt }
        : { active: false, sharedAt: null },
      guestGalleryVisible: true,
      guestGalleryPublishedCount: state.galleryRows.filter(
        ({ publicationStatus }) => publicationStatus === 'published',
      ).length,
    };
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://candidary.test');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (url.pathname.endsWith('/gallery/summary') && method === 'GET') {
      const read = state.audienceReads++;
      await state.audienceReadGates[read];
      const readError = state.audienceReadErrors[read];
      if (readError) return failure(readError, 503);
      return success({ summary: state.audienceReadResults[read] ?? state.audienceSummary });
    }
    if (url.pathname.endsWith('/gallery') && method === 'GET') {
      const favorites = url.searchParams.get('favorites') === '1';
      const result = favorites
        ? state.galleryRows.filter((item) => item.isFavorite)
        : state.galleryRows;
      return success({ media: result, nextCursor: null });
    }
    if (url.pathname.endsWith('/album') && method === 'GET') {
      const read = state.albumReads++;
      await state.albumReadGates[read];
      const readError = state.albumReadErrors[read];
      if (readError) return failure(readError, 401, state.albumReadErrorCodes[read]);
      return success({ album: resolvedAlbum() });
    }
    // Manager Preview. Authenticated as the manager, and deliberately not sharing:
    // it answers before a link exists, after one is stopped, and with nothing picked.
    if (url.pathname.endsWith('/album/preview') && method === 'GET') {
      state.previewReads += 1;
      return success({ album: publicAlbum() });
    }
    if (url.pathname.endsWith('/album') && method === 'PUT') {
      const entries = (body.entries as { kind: string; mediaId?: string; id?: string; heading?: string }[])
        .map((entry): AlbumEntryView => {
          if (entry.kind === 'section') {
            return { kind: 'section', id: entry.id!, heading: entry.heading! };
          }
          // A retained slot is written back as an ordinary photo entry naming the same
          // media id; the server resolves it to the marker again because the row is trashed.
          const slot = state.trashed[entry.mediaId!];
          if (slot) return { kind: 'photo-retained', slot };
          return { kind: 'photo', photo: state.galleryRows.find((item) => item.id === entry.mediaId)! };
        });
      state.orderWrites.push(entries);
      state.orderPaths.push(url.pathname);
      state.orderRevisions.push(body.revision as number);
      state.metadataWrites.push(body.metadata as AlbumMetadataInput);
      const write = state.orderWrites.length - 1;
      await state.orderGates[write];
      const writeError = state.orderErrors[write];
      if (writeError) return failure(writeError, 409, state.orderErrorCodes[write]);
      state.album = {
        revision: state.album.revision + 1,
        saved: true,
        entries,
        ...(body.metadata as AlbumMetadataInput),
      };
      state.audienceSummary = {
        ...state.audienceSummary,
        albumPhotoCount: entries.filter((entry) => entry.kind === 'photo').length,
        albumEntryCount: entries.length,
      };
      return success({ album: resolvedAlbum() });
    }
    if (url.pathname.endsWith('/album/picks') && method === 'POST') {
      state.pickWrites.push(body);
      const write = state.pickWrites.length - 1;
      await state.pickGates[write];
      const writeError = state.pickErrors[write];
      if (writeError) return failure(writeError, 503);
      const changed: ManagerGalleryMediaView[] = [];
      for (const id of body.mediaIds as string[]) {
        const item = state.galleryRows.find((candidate) => candidate.id === id);
        if (!item || item.isFavorite === body.picked) continue;
        item.isFavorite = body.picked;
        changed.push({ ...item });
      }
      const resolved = resolvedAlbum();
      state.audienceSummary = {
        ...state.audienceSummary,
        albumPhotoCount: resolved.photoCount,
        albumEntryCount: resolved.entries.length,
      };
      return success({ changed });
    }
    if (url.pathname.endsWith('/album/start') && method === 'POST') {
      const write = state.startWrites.length;
      state.startWrites.push(body.start);
      state.startRequests.push(body as AlbumStartRequest);
      await state.startGates[write];
      const configuredFailure = state.startFailures[write];
      if (configuredFailure) {
        if (configuredFailure.album) state.album = configuredFailure.album;
        return failure(
          configuredFailure.message,
          configuredFailure.status ?? 409,
          configuredFailure.code ?? 'REVISION_CONFLICT',
        );
      }
      const configured = state.startResults[write];
      if (configured) {
        if (configured.album) state.album = configured.album;
        return success({
          album: resolvedAlbum(),
          started: configured.started,
          cleared: configured.cleared ?? [],
        });
      }
      let cleared: string[] = [];
      if (body.start === 'empty') {
        cleared = state.galleryRows.filter((item) => item.isFavorite).map((item) => item.id);
        for (const item of state.galleryRows) item.isFavorite = false;
      }
      state.album = {
        ...state.album,
        revision: state.album.revision + 1,
        saved: true,
        reconciliation: null,
      };
      const resolved = resolvedAlbum();
      state.audienceSummary = {
        ...state.audienceSummary,
        albumPhotoCount: resolved.photoCount,
        albumEntryCount: resolved.entries.length,
      };
      return success({ album: resolved, started: true, cleared });
    }
    if (url.pathname.endsWith('/album/share') && method === 'GET') {
      const read = state.shareReads++;
      const share = state.share;
      await state.shareReadGates[read];
      if (state.shareReadRejects[read]) throw null;
      return success({ share });
    }
    if (url.pathname.endsWith('/album/share') && method === 'POST') {
      const creation = state.shareWrites.filter((write) => write === 'share').length;
      state.shareWrites.push('share');
      const write = state.shareWrites.length - 1;
      await state.shareGates[write];
      if (state.shareRejects[write]) throw null;
      const writeError = state.shareErrors[write];
      if (writeError) return failure(writeError, 503);
      state.share = state.shareResults[creation] ?? {
        active: true,
        url: 'https://candidary.test/album#share-id.share-secret',
        sharedAt: '2026-08-23T12:00:00.000Z',
      };
      state.audienceSummary = {
        ...state.audienceSummary,
        albumLink: { active: true, sharedAt: state.share.sharedAt },
      };
      return success({ share: state.share });
    }
    if (url.pathname.endsWith('/album/share') && method === 'DELETE') {
      state.shareWrites.push('stop');
      const write = state.shareWrites.length - 1;
      await state.shareGates[write];
      if (state.shareRejects[write]) throw null;
      const writeError = state.shareErrors[write];
      if (writeError) return failure(writeError, 503);
      state.share = null;
      state.audienceSummary = {
        ...state.audienceSummary,
        albumLink: { active: false, sharedAt: null },
      };
      return success({ share: null });
    }
    if (url.pathname.endsWith('/media/bulk') && method === 'POST') {
      state.publicationWrites.push({ ids: body.ids, action: body.action });
      const changed = state.galleryRows
        .filter(({ id }) => (body.ids as string[]).includes(id))
        .map((item) => {
          item.publicationStatus = body.action === 'publish' ? 'published' : 'hidden';
          return { ...item };
        });
      state.audienceSummary = {
        ...state.audienceSummary,
        guestGalleryPublishedCount: state.galleryRows.filter(
          ({ publicationStatus }) => publicationStatus === 'published',
        ).length,
      };
      return success({ changed });
    }
    if (url.pathname.includes('/media/') && method === 'PATCH') {
      const mediaId = url.pathname.split('/').at(-1)!;
      state.publicationWrites.push({ ids: [mediaId], action: body.action });
      const item = state.galleryRows.find(({ id }) => id === mediaId)!;
      item.publicationStatus = body.action === 'publish' ? 'published' : 'hidden';
      state.audienceSummary = {
        ...state.audienceSummary,
        guestGalleryPublishedCount: state.galleryRows.filter(
          ({ publicationStatus }) => publicationStatus === 'published',
        ).length,
      };
      return success({ media: { ...item } });
    }
    if (url.pathname.includes('/media') && method === 'GET') {
      const requestedStatus = url.searchParams.get('status');
      const media = requestedStatus
        ? state.galleryRows.filter(({ publicationStatus }) => publicationStatus === requestedStatus)
        : state.galleryRows;
      return success({ media, nextCursor: null });
    }
    if (url.pathname.endsWith('/favorite') && method === 'PUT') {
      const mediaId = url.pathname.split('/').at(-2)!;
      const item = state.galleryRows.find(({ id }) => id === mediaId)!;
      item.isFavorite = body.favorite;
      const resolved = resolvedAlbum();
      state.audienceSummary = {
        ...state.audienceSummary,
        albumPhotoCount: resolved.photoCount,
        albumEntryCount: resolved.entries.length,
      };
      return success({ media: { ...item } });
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
  });

  return { state, fetchMock };
}

const noop = () => Promise.resolve();

function renderWorkspace(fetchMock: ReturnType<typeof vi.fn>, exportOverrides: {
  job?: ExportView;
  albumJob?: ExportView;
  activeJob?: ExportView;
  download?: ExportDownloadView;
  albumDownload?: ExportDownloadView;
  onPrepare?: (kind?: ExportKind) => Promise<void>;
  } = {}, workspaceOverrides: {
  eventId?: string;
  onAlbumAccessFailure?: (failure: LoadFailure | null) => void;
  sharedSelected?: string[];
  sharedSelectionAtLimit?: boolean;
  onSharedSelectedChange?: (value: string[] | ((current: string[]) => string[])) => void;
    sharedStatus?: 'all' | 'unpublished' | 'published' | 'hidden';
    strictMode?: boolean;
    resourceBackedShared?: boolean;
    legacySharedMedia?: MediaView[];
    eventOverride?: Partial<EventView>;
    legacyOnBulk?: (action: 'publish' | 'hide') => Promise<void>;
    mode?: GalleryMode;
    onModeChange?: (mode: GalleryMode) => void;
    onAnchorReady?: (mode: GalleryMode) => void;
} = {}) {
  vi.stubGlobal('fetch', fetchMock);
  const onPrepare = exportOverrides.onPrepare ?? vi.fn(noop);
  const onPublicationChanged = vi.fn();
  const invalidateGalleryAfterMutation = vi.fn();
  const galleryRef = createRef<ManagerGalleryWorkspaceHandle>();
  let currentEventOverride = workspaceOverrides.eventOverride;
  let currentMode = workspaceOverrides.mode ?? 'library';
  let currentOnPublicationChanged = onPublicationChanged;
  let currentAudienceInvalidate = () => {};
  function TestManagerGalleryOwner({ eventId }: { eventId: string }) {
    const [ownedMode, setOwnedMode] = useState<GalleryMode>('library');
    const [albumLeaveAttempt, setAlbumLeaveAttempt] = useState<{
      mode: GalleryMode;
      outcome: AlbumLeavePreparation;
    } | null>(null);
    useEffect(() => {
      if (workspaceOverrides.mode === undefined) setOwnedMode('library');
    }, [eventId]);
    const [galleryMutationEpoch, setGalleryMutationEpoch] = useState(0);
    const invalidateOwnedGallery = useCallback(() => {
      invalidateGalleryAfterMutation();
      setGalleryMutationEpoch((current) => current + 1);
      currentAudienceInvalidate();
    }, []);
    const audienceResource = useManagerResource<GalleryAudienceSummaryView>({
      eventId,
      queryKey: 'gallery-audience-summary',
      fallbackMessage: 'The Gallery audience status could not be loaded.',
      onEscalate: () => {},
      load: useCallback(async (signal: AbortSignal) => (
        await api<{ summary: GalleryAudienceSummaryView }>(
          `/api/manage/events/${eventId}/gallery/summary`,
          { signal },
        )
      ).summary, [eventId]),
    });
    const summary = audienceResource.state.value;
    currentAudienceInvalidate = audienceResource.invalidate;
    const audience = useMemo(() => ({
      summary,
      freshness: audienceResource.state.status === 'ready' && summary !== null
        ? 'fresh' as const
        : summary !== null ? 'stale' as const : 'unavailable' as const,
      refreshing: summary !== null && audienceResource.state.status === 'loading',
      failure: audienceResource.state.failure,
      reload: audienceResource.reload,
      invalidate: audienceResource.invalidate,
    }), [audienceResource.invalidate, audienceResource.reload, audienceResource.state.failure, audienceResource.state.status, summary]);
    const [announcement, setAnnouncement] = useState('');
    const [liveHost] = useState(() => {
      const element = document.createElement('div');
      element.dataset.galleryLiveHost = 'true';
      return element;
    });
    useLayoutEffect(() => {
      document.body.append(liveHost);
      return () => { liveHost.remove(); };
    }, [liveHost]);

    async function beginAlbumLeave(mode: GalleryMode, retry = false) {
      setAlbumLeaveAttempt({ mode, outcome: { status: 'waiting' } });
      const outcome = retry
        ? await galleryRef.current?.retryPendingAlbumChanges() ?? { status: 'ready' } as const
        : await galleryRef.current?.prepareToLeave() ?? { status: 'ready' } as const;
      setAlbumLeaveAttempt({ mode, outcome });
      if (outcome.status === 'ready') {
        galleryRef.current?.retireAlbumLeavePreparation();
        setOwnedMode(mode);
        setAlbumLeaveAttempt(null);
      }
    }

    function requestMode(mode: GalleryMode) {
      if (workspaceOverrides.mode !== undefined) {
        workspaceOverrides.onModeChange?.(mode);
        return;
      }
      if (mode === ownedMode) return;
      if (galleryRef.current?.requiresAlbumLeavePreparation() !== true) {
        setOwnedMode(mode);
        return;
      }
      void beginAlbumLeave(mode);
    }

    function discardAlbumAndChangeMode() {
      const attempt = albumLeaveAttempt;
      if (!attempt || attempt.outcome.status === 'waiting') return;
      galleryRef.current?.discardPendingAlbumChanges();
      galleryRef.current?.retireAlbumLeavePreparation();
      setOwnedMode(attempt.mode);
      setAlbumLeaveAttempt(null);
    }

    function stayWithAlbum() {
      const attempt = albumLeaveAttempt;
      if (!attempt) return;
      galleryRef.current?.restoreAlbumLeaveFocus(attempt.outcome);
      setAlbumLeaveAttempt(null);
    }

    return <ManagerUndoProvider eventId={eventId}><>
      {createPortal(
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>,
        liveHost,
      )}
      {albumLeaveAttempt && <UnsavedSettingsPrompt
        domains={[]}
        albumOutcome={albumLeaveAttempt.outcome}
        focusKey={`gallery-mode:${albumLeaveAttempt.mode}`}
        leaveDisabled={albumLeaveAttempt.outcome.status === 'waiting'}
        onLeave={discardAlbumAndChangeMode}
        onDiscardAlbum={discardAlbumAndChangeMode}
        onRetryAlbum={() => { void beginAlbumLeave(albumLeaveAttempt.mode, true); }}
        onStay={stayWithAlbum}
      />}
      <ManagerGalleryWorkspace
        ref={galleryRef}
        event={{ ...event, ...currentEventOverride }}
        eventId={eventId}
        galleryMutationEpoch={galleryMutationEpoch}
        invalidateGalleryAfterMutation={invalidateOwnedGallery}
        audience={audience}
        onAnnouncement={setAnnouncement}
        onAlbumAccessFailure={workspaceOverrides.onAlbumAccessFailure}
        onAnchorReady={workspaceOverrides.onAnchorReady}
        mode={workspaceOverrides.mode === undefined ? ownedMode : currentMode}
        onModeChange={requestMode}
        shared={workspaceOverrides.resourceBackedShared ? {
          status: workspaceOverrides.sharedStatus,
          onPublicationChanged: currentOnPublicationChanged,
          onOpenSettings: vi.fn(),
          settingsBlocked: false,
        } : {
          media: workspaceOverrides.legacySharedMedia ?? [],
          status: 'unpublished',
          selected: workspaceOverrides.sharedSelected ?? [],
          selectionAtLimit: workspaceOverrides.sharedSelectionAtLimit ?? false,
          onStatusChange: vi.fn(),
          onSelectedChange: workspaceOverrides.onSharedSelectedChange ?? vi.fn(),
          onBulk: workspaceOverrides.legacyOnBulk ?? noop,
          onChangePublication: noop,
          onOpenSettings: vi.fn(),
          settingsBlocked: false,
          loadingMore: false,
          hasMore: false,
          onLoadMore: noop,
        }}
        exports={{
          status: 'ready',
          ...exportOverrides,
          onPrepare,
          onDownload: noop,
          onRetry: noop,
          currentSource: {
            count: (currentEventOverride?.storedMediaCount ?? event.storedMediaCount),
            freshness: 'fresh',
          },
        }}
      />
      <ManagerUndoBar />
    </></ManagerUndoProvider>;
  }
  const props = (eventId: string) => <TestManagerGalleryOwner eventId={eventId} />;
  const workspace = props(workspaceOverrides.eventId ?? 'event-a');
  const rendered = render(workspaceOverrides.strictMode
    ? <StrictMode>{workspace}</StrictMode>
    : workspace);
  return {
    invalidateGalleryAfterMutation,
    onPrepare,
    onPublicationChanged,
    galleryRef,
    invalidateAudienceSummary() { currentAudienceInvalidate(); },
    rerenderEvent(eventOverride: Partial<EventView>) {
      currentEventOverride = eventOverride;
      rendered.rerender(props(workspaceOverrides.eventId ?? 'event-a'));
    },
    rerenderPublicationCallback() {
      currentOnPublicationChanged = vi.fn(onPublicationChanged);
      rendered.rerender(props(workspaceOverrides.eventId ?? 'event-a'));
    },
    rerenderForEvent(eventId: string) { rendered.rerender(props(eventId)); },
    rerenderMode(mode: GalleryMode) {
      currentMode = mode;
      rendered.rerender(props(workspaceOverrides.eventId ?? 'event-a'));
    },
  };
}

async function openAlbum(user = userEvent.setup()) {
  await screen.findByRole('heading', { name: 'Private Gallery' });
  await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
    .getByRole('button', { name: /^Album/ }));
  return user;
}

function RunningUndoHarness({ eventId, settle }: {
  eventId: string;
  settle: Promise<void>;
}) {
  const { present, run } = useManagerUndo();
  const started = useRef(false);
  useLayoutEffect(() => {
    if (started.current) return;
    started.current = true;
    if (present({
      eventId,
      message: 'An earlier Manager change is being undone.',
      durationMs: UNDO_WINDOW_MS,
      input: 'pointer',
      run: () => settle,
    }, { fallback: null })) run();
  }, [eventId, present, run, settle]);
  return null;
}

/**
 * The album editor on its own, with the props only the Manager can answer: the event
 * name, its zone, and where Recently deleted lives. Album stores none of those local
 * navigation facts — a deadline read in the browser's zone is a different day for
 * half the world, and the destination belongs to whoever owns the navigation.
 */
function renderAlbum(fetchMock: ReturnType<typeof vi.fn>, overrides: {
  eventId?: string;
  eventName?: string;
  eventTimezone?: string;
  onOpenRecentlyDeleted?: (mediaId: string) => void;
  runningUndo?: Promise<void>;
} = {}) {
  vi.stubGlobal('fetch', fetchMock);
  const onAnnouncement = vi.fn();
  const onPicksChanged = vi.fn();
  const onGoToLibrary = vi.fn();
  const invalidateGalleryAfterMutation = vi.fn();
  const albumRef = createRef<ManagerAlbumHandle>();
  const eventId = overrides.eventId ?? 'event-a';
  render(<ManagerUndoProvider eventId={eventId}>
    {overrides.runningUndo && <RunningUndoHarness
      eventId={eventId}
      settle={overrides.runningUndo}
    />}
    <ManagerAlbum
      ref={albumRef}
      eventId={eventId}
      eventName={overrides.eventName ?? event.name}
      active
      eventTimezone={overrides.eventTimezone}
      onGoToLibrary={onGoToLibrary}
      onPicksChanged={onPicksChanged}
      invalidateGalleryAfterMutation={invalidateGalleryAfterMutation}
      onOpenRecentlyDeleted={overrides.onOpenRecentlyDeleted}
      exportSource={{ count: 0, freshness: 'fresh' }}
      onPrepareExport={noop}
      onDownloadExport={noop}
      onRetryExport={noop}
      onAnnouncement={onAnnouncement}
    />
    <ManagerUndoBar />
  </ManagerUndoProvider>);
  return {
    albumRef,
    invalidateGalleryAfterMutation,
    onAnnouncement,
    onGoToLibrary,
    onPicksChanged,
  };
}

function CappedUndoHarness({
  expiresAt,
  onRun = noop,
}: {
  expiresAt: string;
  onRun?: () => Promise<void>;
}) {
  const controller = useManagerUndo();
  const { present } = controller;
  const origin = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    present({
      eventId: 'event-a',
      message: 'Photo moved to Recently deleted.',
      run: onRun,
      durationMs: UNDO_WINDOW_MS,
      absoluteDeadline: expiresAt,
      input: 'pointer',
    }, { fallback: origin.current });
  }, [expiresAt, onRun, present]);
  return <button ref={origin} type="button">Return origin</button>;
}

function CappedUndoProviderHarness(props: Parameters<typeof CappedUndoHarness>[0]) {
  return <ManagerUndoProvider eventId="event-a">
    <CappedUndoHarness {...props} />
    <ManagerUndoBar />
  </ManagerUndoProvider>;
}

function DeadlineClockHarness({
  deadlines,
  onRender,
}: {
  deadlines: string[];
  onRender?: () => void;
}) {
  const now = useDeadlineClock(deadlines);
  const deadline = Date.parse(deadlines[0]!);
  onRender?.();
  return <output>{deadline <= now ? 'Recovery expired' : 'Recovery available'}</output>;
}

/** The one entry a marker occupies, found by the only words it is allowed to say. */
async function retainedMarker() {
  return (await screen.findByText('Recently deleted photo')).closest('li')!;
}

function anchorRect(top: number): DOMRect {
  return { top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON: () => ({}) };
}

describe('gallery modes', () => {
  it('waits for the controlled Gallery mode to be adopted', async () => {
    const { fetchMock } = harness();
    const onModeChange = vi.fn();
    const workspace = renderWorkspace(fetchMock, {}, { mode: 'library', onModeChange });
    const user = userEvent.setup();

    expect(await screen.findByText('First dance')).toBeVisible();
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album$/u }));

    expect(onModeChange).toHaveBeenCalledWith('album');
    expect(screen.getByText('First dance')).toBeVisible();

    workspace.rerenderMode('album');
    expect(await screen.findByRole('heading', { name: 'The Album is empty.' })).toBeVisible();
  });

  it('captures and restores the real requested Library, Album, and Guest-gallery roots', async () => {
    const anchoredPhoto = photo('anchor-p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({
      galleryRows: [anchoredPhoto],
      album: {
        revision: 2,
        saved: true,
        entries: [{ kind: 'photo', photo: anchoredPhoto }],
      },
    });
    const workspace = renderWorkspace(fetchMock, {}, { mode: 'library', resourceBackedShared: true });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    await screen.findByRole('button', { name: 'Open anchor-p1.jpg, from Jose' });
    const libraryTile = document.querySelector<HTMLElement>('[data-gallery-anchor-id="anchor-p1"]')!;
    expect(libraryTile).toHaveClass('gallery-mosaic__item');
    const libraryRect = vi.spyOn(libraryTile, 'getBoundingClientRect').mockReturnValue(anchorRect(100));
    expect(workspace.galleryRef.current?.captureAnchor('library')).toMatchObject({
      kind: 'media', mediaId: 'anchor-p1', viewportOffset: 100,
    });
    libraryRect.mockReturnValue(anchorRect(350));
    expect(workspace.galleryRef.current?.restoreAnchor('library', {
      kind: 'media', mediaId: 'anchor-p1', viewportOffset: 100, fallbackScrollY: 0, before: [], after: [],
    })).toBe('item');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 250, behavior: 'instant' });

    workspace.rerenderMode('album');
    const albumItem = await waitFor(() => {
      const item = document.querySelector<HTMLElement>('[data-gallery-anchor-id="photo:anchor-p1"]');
      expect(item).not.toBeNull();
      return item!;
    });
    expect(albumItem.tagName).toBe('LI');
    const albumRect = vi.spyOn(albumItem, 'getBoundingClientRect').mockReturnValue(anchorRect(150));
    expect(workspace.galleryRef.current?.captureAnchor('album')).toMatchObject({
      kind: 'album-entry', entryId: 'photo:anchor-p1', viewportOffset: 150,
    });
    albumRect.mockReturnValue(anchorRect(260));
    expect(workspace.galleryRef.current?.restoreAnchor('album', {
      kind: 'album-entry', entryId: 'photo:anchor-p1', viewportOffset: 150, fallbackScrollY: 0, before: [], after: [],
    })).toBe('item');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 110, behavior: 'instant' });

    workspace.rerenderMode('guest-gallery');
    const sharedItem = await waitFor(() => {
      const item = document.querySelector<HTMLElement>('.gallery-shared article[data-gallery-anchor-id="anchor-p1"]');
      expect(item).not.toBeNull();
      return item!;
    });
    expect(sharedItem.tagName).toBe('ARTICLE');
    const sharedRect = vi.spyOn(sharedItem, 'getBoundingClientRect').mockReturnValue(anchorRect(200));
    expect(workspace.galleryRef.current?.captureAnchor('guest-gallery')).toMatchObject({
      kind: 'media', mediaId: 'anchor-p1', viewportOffset: 200,
    });
    sharedRect.mockReturnValue(anchorRect(260));
    expect(workspace.galleryRef.current?.restoreAnchor('guest-gallery', {
      kind: 'media', mediaId: 'anchor-p1', viewportOffset: 200, fallbackScrollY: 0, before: [], after: [],
    })).toBe('item');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 60, behavior: 'instant' });
  });

  it('keeps an unmounted Album pending instead of searching retained Library or Guest-gallery roots', async () => {
    const anchoredPhoto = photo('unmounted-anchor', '2026-08-15T22:42:00.000Z');
    const { fetchMock } = harness({ galleryRows: [anchoredPhoto] });
    const workspace = renderWorkspace(fetchMock, {}, {
      mode: 'library',
      legacySharedMedia: [anchoredPhoto],
    });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    await screen.findByRole('button', { name: 'Open unmounted-anchor.jpg, from Jose' });
    const libraryTile = document.querySelector<HTMLElement>('[data-gallery-anchor-id="unmounted-anchor"]')!;
    const sharedItem = document.querySelector<HTMLElement>('.gallery-shared article[data-gallery-anchor-id="unmounted-anchor"]')!;
    vi.spyOn(libraryTile, 'getBoundingClientRect').mockReturnValue(anchorRect(300));
    vi.spyOn(sharedItem, 'getBoundingClientRect').mockReturnValue(anchorRect(500));

    expect(workspace.galleryRef.current?.restoreAnchor('album', {
      kind: 'album-entry', entryId: 'unmounted-anchor', viewportOffset: 0,
      fallbackScrollY: 0, before: [], after: [],
    })).toBe('pending');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('defers Library anchor restoration until its initial rows commit', async () => {
    const initialLoad = deferred();
    const controlled = harness();
    const originalFetch = controlled.fetchMock.getMockImplementation()!;
    controlled.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/gallery') && (init?.method ?? 'GET') === 'GET') {
        await initialLoad.promise;
      }
      return originalFetch(input, init);
    });
    const onAnchorReady = vi.fn();
    const workspace = renderWorkspace(controlled.fetchMock, {}, { mode: 'library', onAnchorReady });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    await waitFor(() => expect(controlled.fetchMock.mock.calls.some(([input, init]) => (
      new URL(String(input), 'https://candidary.test').pathname.endsWith('/gallery')
      && (init?.method ?? 'GET') === 'GET'
    ))).toBe(true));
    expect(workspace.galleryRef.current?.restoreAnchor('library', {
      kind: 'media', mediaId: 'p1', viewportOffset: 0, fallbackScrollY: 0, before: [], after: [],
    })).toBe('pending');
    expect(scrollTo).not.toHaveBeenCalled();
    expect(onAnchorReady).not.toHaveBeenCalled();

    await act(async () => { initialLoad.resolve(); });
    const tile = await waitFor(() => {
      const item = document.querySelector<HTMLElement>('[data-gallery-anchor-id="p1"]');
      expect(item).not.toBeNull();
      return item!;
    });
    vi.spyOn(tile, 'getBoundingClientRect').mockReturnValue(anchorRect(200));
    await waitFor(() => expect(onAnchorReady).toHaveBeenCalledWith('library'));
    expect(workspace.galleryRef.current?.restoreAnchor('library', {
      kind: 'media', mediaId: 'p1', viewportOffset: 0, fallbackScrollY: 0, before: [], after: [],
    })).toBe('item');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 200, behavior: 'instant' });
    expect(controlled.fetchMock.mock.calls.filter(([input, init]) => (
      new URL(String(input), 'https://candidary.test').pathname.endsWith('/gallery')
      && (init?.method ?? 'GET') === 'GET'
    ))).toHaveLength(1);
  });

  it('defers Album anchor restoration until its initial rows commit', async () => {
    const initialLoad = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: { revision: 1, saved: true, entries: [{ kind: 'photo', photo: p1 }] },
      albumReadGates: [initialLoad.promise],
    });
    const onAnchorReady = vi.fn();
    const workspace = renderWorkspace(controlled.fetchMock, {}, { mode: 'album', onAnchorReady });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    await waitFor(() => expect(controlled.state.albumReads).toBe(1));
    expect(workspace.galleryRef.current?.restoreAnchor('album', {
      kind: 'album-entry', entryId: 'photo:p1', viewportOffset: 0, fallbackScrollY: 0, before: [], after: [],
    })).toBe('pending');
    expect(scrollTo).not.toHaveBeenCalled();
    expect(onAnchorReady).not.toHaveBeenCalled();

    await act(async () => { initialLoad.resolve(); });
    const item = await waitFor(() => {
      const entry = document.querySelector<HTMLElement>('[data-gallery-anchor-id="photo:p1"]');
      expect(entry).not.toBeNull();
      return entry!;
    });
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(anchorRect(220));
    await waitFor(() => expect(onAnchorReady).toHaveBeenCalledWith('album'));
    expect(workspace.galleryRef.current?.restoreAnchor('album', {
      kind: 'album-entry', entryId: 'photo:p1', viewportOffset: 0, fallbackScrollY: 0, before: [], after: [],
    })).toBe('item');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 220, behavior: 'instant' });
    expect(controlled.state.albumReads).toBe(1);
  });

  it('defers Guest-gallery anchor restoration until its current initial query settles', async () => {
    const initialLoad = deferred();
    const controlled = harness({ galleryRows: [] });
    const originalFetch = controlled.fetchMock.getMockImplementation()!;
    controlled.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/media') && (init?.method ?? 'GET') === 'GET') {
        await initialLoad.promise;
      }
      return originalFetch(input, init);
    });
    const onAnchorReady = vi.fn();
    const workspace = renderWorkspace(controlled.fetchMock, {}, {
      mode: 'guest-gallery',
      resourceBackedShared: true,
      onAnchorReady,
    });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    await waitFor(() => expect(controlled.fetchMock.mock.calls.some(([input, init]) => (
      new URL(String(input), 'https://candidary.test').pathname.endsWith('/media')
      && (init?.method ?? 'GET') === 'GET'
    ))).toBe(true));
    expect(workspace.galleryRef.current?.restoreAnchor('guest-gallery', {
      kind: 'media', mediaId: 'missing', viewportOffset: 0, fallbackScrollY: 0, before: [], after: [],
    })).toBe('pending');
    expect(scrollTo).not.toHaveBeenCalled();
    expect(onAnchorReady).not.toHaveBeenCalled();

    await act(async () => { initialLoad.resolve(); });
    await screen.findByText('No unpublished photos.');
    await waitFor(() => expect(onAnchorReady).toHaveBeenCalledWith('guest-gallery'));
    expect(workspace.galleryRef.current?.restoreAnchor('guest-gallery', {
      kind: 'media', mediaId: 'missing', viewportOffset: 0, fallbackScrollY: 0, before: [], after: [],
    })).toBe('fallback');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
    expect(controlled.fetchMock.mock.calls.filter(([input, init]) => (
      new URL(String(input), 'https://candidary.test').pathname.endsWith('/media')
      && (init?.method ?? 'GET') === 'GET'
    ))).toHaveLength(1);
  });

  it.each([
    [
      {
        albumPhotoCount: 12,
        albumEntryCount: 14,
        albumLink: { active: true, sharedAt: '2026-08-23T12:00:00.000Z' },
        guestGalleryVisible: true,
        guestGalleryPublishedCount: 8,
      },
      'Album: 12 photos · Link: Live · Guest gallery: On, 8 published',
    ],
    [
      {
        albumPhotoCount: 0,
        albumEntryCount: 0,
        albumLink: { active: false, sharedAt: null },
        guestGalleryVisible: false,
        guestGalleryPublishedCount: 0,
      },
      'Album: 0 photos · Link: Off · Guest gallery: Off, 0 published',
    ],
    [
      {
        albumPhotoCount: 1,
        albumEntryCount: 1,
        albumLink: { active: false, sharedAt: null },
        guestGalleryVisible: true,
        guestGalleryPublishedCount: 1,
      },
      'Album: 1 photo · Link: Off · Guest gallery: On, 1 published',
    ],
  ] satisfies Array<[GalleryAudienceSummaryView, string]>)('renders the persistent audience summary %#', async (audienceSummary, expected) => {
    const { fetchMock } = harness({ audienceSummary });
    renderWorkspace(fetchMock);

    expect(await screen.findByText(expected)).toBeVisible();
  });

  it('keeps the live Album status visible without repeating its consequence copy', async () => {
    const { fetchMock } = harness({
      audienceSummary: {
        albumPhotoCount: 1,
        albumEntryCount: 1,
        albumLink: { active: true, sharedAt: '2026-08-23T12:00:00.000Z' },
        guestGalleryVisible: true,
        guestGalleryPublishedCount: 0,
      },
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    const consequence = 'Album link live—later saved membership, metadata, sections, and order changes affect what people with the Album link see when they request it.';
    const summary = 'Album: 1 photo · Link: Live · Guest gallery: On, 0 published';

    expect(await screen.findByText(summary)).toBeVisible();
    expect(screen.queryByText(consequence)).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/u }));

    expect(screen.getByText(summary)).toBeVisible();
    expect(screen.queryByText(consequence)).not.toBeInTheDocument();
  });

  it('keeps Library and exports usable when the first audience-summary read fails', async () => {
    const { state, fetchMock } = harness({ audienceReadErrors: ['Summary unavailable.'] });
    renderWorkspace(fetchMock);

    expect(await screen.findByRole('alert')).toHaveTextContent('Summary unavailable.');
    expect(await screen.findByText('First dance')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download all' })).toBeEnabled();
    expect(state.albumReads).toBe(0);
  });

  it('keeps the last trusted summary visible when an invalidation retry fails', async () => {
    const trusted: GalleryAudienceSummaryView = {
      albumPhotoCount: 12,
      albumEntryCount: 14,
      albumLink: { active: true, sharedAt: '2026-08-23T12:00:00.000Z' },
      guestGalleryVisible: true,
      guestGalleryPublishedCount: 8,
    };
    const albumJob: ExportView = {
      id: 'album-ready', kind: 'album', state: 'ready', attempt: 1,
      snapshotAt: '2026-08-23T12:00:00.000Z', mediaCount: 10, totalBytes: 640,
      createdAt: '2026-08-23T12:00:01.000Z', startedAt: '2026-08-23T12:00:02.000Z',
      completedAt: '2026-08-23T12:00:03.000Z', processedMediaCount: 10,
      processedBytes: 640, progressUpdatedAt: '2026-08-23T12:00:02.500Z',
      errorCode: null, partCount: 1, expiresAt: '2026-08-24T12:00:00.000Z',
      guestbookEntryCount: null, guestbookSharedCount: null, guestbookEventName: null,
      guestbookEventDate: null, guestbookEventTimezone: null, guestbookPrompt: null,
      guestbookGalleryVisible: null,
    };
    const { state, fetchMock } = harness({
      audienceSummary: trusted,
      audienceReadErrors: [undefined, 'The refreshed summary failed.'],
    });
    renderWorkspace(fetchMock, { albumJob });
    const line = await screen.findByText(
      'Album: 12 photos · Link: Live · Guest gallery: On, 8 published',
    );

    await userEvent.setup().click(await screen.findByRole('button', {
      name: 'Pick First dance for the Album',
    }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The refreshed summary failed.');
    expect(line).toBeVisible();
    expect(state.audienceReads).toBe(2);

    await userEvent.setup().click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));
    expect(await screen.findByText(
      'Last known current Album: 12 photos. Current Album count unavailable.',
    )).toBeVisible();
    expect(screen.queryByText('Current Album: 12 photos (+2 photos).')).not.toBeInTheDocument();
  });

  it('does not let a late event-A audience response enter event B', async () => {
    const eventA = deferred();
    const summaryA: GalleryAudienceSummaryView = {
      albumPhotoCount: 12,
      albumEntryCount: 12,
      albumLink: { active: true, sharedAt: '2026-08-23T12:00:00.000Z' },
      guestGalleryVisible: true,
      guestGalleryPublishedCount: 8,
    };
    const summaryB: GalleryAudienceSummaryView = {
      albumPhotoCount: 1,
      albumEntryCount: 1,
      albumLink: { active: false, sharedAt: null },
      guestGalleryVisible: false,
      guestGalleryPublishedCount: 0,
    };
    const controlled = harness({
      audienceReadGates: [eventA.promise],
      audienceReadResults: [summaryA, summaryB],
    });
    const rendered = renderWorkspace(controlled.fetchMock);
    await waitFor(() => expect(controlled.state.audienceReads).toBe(1));

    rendered.rerenderForEvent('event-b');
    expect(await screen.findByText(
      'Album: 1 photo · Link: Off · Guest gallery: Off, 0 published',
    )).toBeVisible();
    eventA.resolve();
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText(
      'Album: 12 photos · Link: Live · Guest gallery: On, 8 published',
    )).not.toBeInTheDocument();
  });

  it('offers Library, Album and Guest gallery without redundant mode explanations', async () => {
    const { fetchMock } = harness();
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });

    const modes = screen.getByRole('group', { name: 'Gallery mode' });
    expect(within(modes).getAllByRole('button')).toHaveLength(3);
    expect(within(modes).getByRole('button', { name: 'Guest gallery' })).toBeVisible();
    expect(within(modes).queryByRole('button', { name: 'Shared' })).not.toBeInTheDocument();
    expect(screen.queryByText('About this Gallery view')).not.toBeInTheDocument();
    expect(screen.queryByText(/Delivered photos stay private to hosts/u)).not.toBeInTheDocument();

    await user.click(within(modes).getByRole('button', { name: /^Album/ }));
    expect(await screen.findByRole('heading', { name: 'Album' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add a section' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'The order people with the Album link will see' }))
      .not.toBeInTheDocument();
  });

  it('stacks the three-mode switch at the narrowest layout', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    expect(styles).toMatch(/@media \(max-width: 360px\) \{(?:(?!@media)[\s\S])*?\.gallery-mode-switch--three \{ grid-template-columns: 1fr; \}\s*\}/u);
  });

  it('clears Guest-gallery selection only after controlled Library adoption', async () => {
    const { fetchMock } = harness();
    const onSharedSelectedChange = vi.fn();
    const onModeChange = vi.fn();
    const workspace = renderWorkspace(fetchMock, {}, {
      sharedSelected: ['p1'],
      onSharedSelectedChange,
      mode: 'guest-gallery',
      onModeChange,
    });
    const user = userEvent.setup();
    const modes = await screen.findByRole('group', { name: 'Gallery mode' });

    await user.click(within(modes).getByRole('button', { name: 'Library' }));
    expect(onModeChange).toHaveBeenCalledWith('library');
    expect(onSharedSelectedChange).not.toHaveBeenCalled();

    workspace.rerenderMode('library');

    await waitFor(() => expect(onSharedSelectedChange).toHaveBeenCalledOnce());
    expect(onSharedSelectedChange).toHaveBeenCalledWith([]);
  });

  it.each([
    [0, '0 of 50 selected'],
    [1, '1 of 50 selected'],
    [49, '49 of 50 selected'],
    [50, '50 of 50 selected. Remove one to choose another.'],
  ] as const)('uses the same Library and Guest-gallery selection copy at %i selections', (count, expected) => {
    const selected = Array.from({ length: count }, (_, index) => `photo-${index}`);
    render(<>
      <SelectionTray count={count} busy={false} onAdd={vi.fn()} onRemove={vi.fn()} onClear={vi.fn()} />
      <ManagerSharedGallery
        guestGalleryVisible={event.galleryVisible}
        media={[]}
        status="unpublished"
        selected={selected}
        selectionAtLimit={count === MANAGER_BULK_SELECTION_MAX}
        onStatusChange={vi.fn()}
        onSelectedChange={vi.fn()}
        onBulk={noop}
        onChangePublication={noop}
        onOpenSettings={vi.fn()}
        settingsBlocked={false}
        loadingMore={false}
        hasMore={false}
        onLoadMore={noop}
      />
    </>);

    expect(document.querySelector('.selection-tray__count strong')).toHaveTextContent(expected);
    expect(document.getElementById('bulk-selection-status')).toHaveTextContent(expected);
  });

  it('clears a Guest-gallery filter selection through the canonical transition and announces it once', async () => {
    const controlled = harness();
    renderWorkspace(controlled.fetchMock, {}, { resourceBackedShared: true });
    const user = userEvent.setup();
    const modes = await screen.findByRole('group', { name: 'Gallery mode' });
    await user.click(within(modes).getByRole('button', { name: 'Guest gallery' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Select First dance' }));
    await user.click(screen.getByRole('button', { name: /^Published$/ }));

    expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('Selection cleared.');
    expect(document.getElementById('bulk-selection-status')).toHaveTextContent('0 of 50 selected');
    expect(document.querySelectorAll('[data-gallery-live-host] [role="status"]')).toHaveLength(1);
    expect(document.querySelector('.gallery-shared [role="status"]')).toBeNull();
  });

  it('safety ladder reversible: publishes and hides immediately with precise inverse feedback', async () => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' })],
    });
    renderWorkspace(controlled.fetchMock, {}, { resourceBackedShared: true });
    const user = userEvent.setup();
    const modes = await screen.findByRole('group', { name: 'Gallery mode' });

    await user.click(within(modes).getByRole('button', { name: 'Guest gallery' }));
    expect(screen.queryByText('About this Gallery view')).not.toBeInTheDocument();
    expect(screen.getByText('Published photos are visible to event guests.')).toBeVisible();
    expect(screen.queryByText('Publish and Hide change what event guests see. They do not change Album membership or the Album link.'))
      .not.toBeInTheDocument();
    const unpublishedActions = screen.getByRole('button', { name: 'Publish p1.jpg' }).parentElement!;
    expect(Array.from(unpublishedActions.querySelectorAll('button')).map((button) => button.textContent?.trim()))
      .toEqual(['Publish', 'Hide']);
    expect(screen.getByRole('button', { name: 'Publish p1.jpg' })).toHaveClass('button--approve');
    expect(screen.getByRole('button', { name: 'Hide p1.jpg' })).toHaveClass('button--secondary');

    expect(controlled.state.publicationWrites).toEqual([]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish p1.jpg' }));
    await waitFor(() => expect(controlled.state.publicationWrites).toEqual([
      { ids: ['p1'], action: 'publish' },
    ]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('First dance is Published in the Guest gallery for event guests. Hide it to reverse this.'));
    expect(controlled.state.galleryRows[0]).toMatchObject({ publicationStatus: 'published', isFavorite: false });
    expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .not.toHaveTextContent('Publishing finished.');

    await user.click(within(modes).getByRole('button', { name: 'Library' }));
    expect(await screen.findByRole('button', { name: 'Pick First dance for the Album' })).toBeVisible();
    expect(screen.getByText('Guest gallery · Published')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Pick First dance for the Album' }));
    await waitFor(() => expect(controlled.state.galleryRows[0]).toMatchObject({
      publicationStatus: 'published', isFavorite: true,
    }));

    await user.click(within(modes).getByRole('button', { name: 'Guest gallery' }));
    await user.click(screen.getByRole('button', { name: /^Published$/ }));
    const hide = await screen.findByRole('button', { name: 'Hide p1.jpg' });
    expect(hide).toHaveClass('button--primary');
    await user.click(hide);
    await waitFor(() => expect(controlled.state.publicationWrites).toEqual([
      { ids: ['p1'], action: 'publish' },
      { ids: ['p1'], action: 'hide' },
    ]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('First dance is Hidden from event guests in the Guest gallery. Publish it to reverse this.'));
    expect(controlled.state.galleryRows[0]).toMatchObject({ publicationStatus: 'hidden', isFavorite: true });
    await user.click(screen.getByRole('button', { name: /^Hidden$/ }));
    expect(await screen.findByRole('button', { name: 'Publish p1.jpg' })).toHaveClass('button--approve');
  });

  it('announces exact bulk results and the Guest-gallery-off consequence', async () => {
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' }),
        photo('p2', '2026-08-15T22:43:00.000Z'),
      ],
      audienceSummary: {
        albumPhotoCount: 0,
        albumEntryCount: 0,
        albumLink: { active: false, sharedAt: null },
        guestGalleryVisible: false,
        guestGalleryPublishedCount: 0,
      },
    });
    renderWorkspace(controlled.fetchMock, {}, {
      resourceBackedShared: true,
      eventOverride: { galleryVisible: false },
    });
    const user = userEvent.setup();
    const modes = await screen.findByRole('group', { name: 'Gallery mode' });
    await user.click(within(modes).getByRole('button', { name: 'Guest gallery' }));

    expect(screen.getByText('Publication choices are saved, but the Guest gallery is off.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeVisible();
    await user.click(await screen.findByRole('checkbox', { name: 'Select First dance' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select p2.jpg' }));
    await user.click(screen.getByRole('button', { name: 'Publish selected' }));

    await waitFor(() => expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('2 photos are Published in the Guest gallery. The Guest gallery is off, so event guests cannot see this choice yet. Hide them to reverse this.'));
    expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .not.toHaveTextContent('Publishing finished.');
  });

  it('projects a confirmed local Guest-gallery-off change while the retained summary refresh fails', async () => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' })],
      audienceSummary: {
        albumPhotoCount: 0,
        albumEntryCount: 0,
        albumLink: { active: false, sharedAt: null },
        guestGalleryVisible: true,
        guestGalleryPublishedCount: 0,
      },
      audienceReadErrors: [undefined, 'The visibility refresh failed.', 'The publication refresh failed.'],
    });
    const rendered = renderWorkspace(controlled.fetchMock, {}, { resourceBackedShared: true });
    await screen.findByText('Album: 0 photos · Link: Off · Guest gallery: On, 0 published');

    rendered.rerenderEvent({ galleryVisible: false });
    rendered.invalidateAudienceSummary();
    expect(await screen.findByRole('alert')).toHaveTextContent('The visibility refresh failed.');
    expect(screen.getByText('Album: 0 photos · Link: Off · Guest gallery: Off, 0 published')).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Guest gallery' }));
    expect(screen.getByText('Publication choices are saved, but the Guest gallery is off.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeVisible();
    await user.click(await screen.findByRole('button', { name: 'Publish p1.jpg' }));

    await waitFor(() => expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('First dance is Published in the Guest gallery. The Guest gallery is off, so event guests cannot see this choice yet. Hide it to reverse this.'));
  });

  it('adopts a newer authoritative visibility before a delayed bulk settlement', async () => {
    const summary = deferred();
    const bulk = deferred();
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z')],
      audienceReadGates: [summary.promise],
      audienceSummary: {
        albumPhotoCount: 0,
        albumEntryCount: 0,
        albumLink: { active: false, sharedAt: null },
        guestGalleryVisible: true,
        guestGalleryPublishedCount: 0,
      },
    });
    const originalFetch = controlled.fetchMock.getMockImplementation()!;
    controlled.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/media/bulk')) await bulk.promise;
      return originalFetch(input, init);
    });
    renderWorkspace(controlled.fetchMock, {}, {
      resourceBackedShared: true,
      eventOverride: { galleryVisible: false },
    });
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Guest gallery' }));
    expect(screen.getByText('Publication choices are saved, but the Guest gallery is off.')).toBeVisible();
    await user.click(await screen.findByRole('checkbox', { name: 'Select p1.jpg' }));
    await user.click(screen.getByRole('button', { name: 'Publish selected' }));

    summary.resolve();
    expect(await screen.findByText('Published photos are visible to event guests.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open settings' })).not.toBeInTheDocument();
    expect(screen.getByText('Album: 0 photos · Link: Off · Guest gallery: On, 0 published')).toBeVisible();

    bulk.resolve();
    await waitFor(() => expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('1 photo is Published in the Guest gallery for event guests. Hide it to reverse this.'));
  });

  it('keeps authoritative visibility when only the publication callback identity changes', async () => {
    const controlled = harness({
      audienceSummary: {
        albumPhotoCount: 0,
        albumEntryCount: 0,
        albumLink: { active: false, sharedAt: null },
        guestGalleryVisible: true,
        guestGalleryPublishedCount: 0,
      },
    });
    const rendered = renderWorkspace(controlled.fetchMock, {}, {
      resourceBackedShared: true,
      eventOverride: { galleryVisible: false },
    });
    await screen.findByText('Album: 0 photos · Link: Off · Guest gallery: On, 0 published');

    rendered.rerenderPublicationCallback();

    expect(screen.getByText('Album: 0 photos · Link: Off · Guest gallery: On, 0 published')).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Guest gallery' }));
    expect(screen.getByText('Published photos are visible to event guests.')).toBeVisible();
  });

  it('announces a terminal legacy bulk failure after the child progressive message', async () => {
    renderWorkspace(harness().fetchMock, {}, {
      sharedSelected: ['p1'],
      legacyOnBulk: async () => { throw new Error('legacy failed'); },
    });
    const user = userEvent.setup();
    await user.click((await screen.findByRole('group', { name: 'Gallery mode' }))
      .querySelector<HTMLButtonElement>('button:last-child')!);
    await user.click(screen.getByRole('button', { name: 'Publish selected' }));

    await waitFor(() => expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('Publishing could not be completed.'));
  });
});

describe('audience summary invalidation boundaries', () => {
  it('reloads after a confirmed single Pick and not before the write settles', async () => {
    const write = deferred();
    const controlled = harness();
    const originalFetch = controlled.fetchMock.getMockImplementation()!;
    controlled.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/favorite') && (init?.method ?? 'GET') === 'PUT') await write.promise;
      return originalFetch(input, init);
    });
    renderWorkspace(controlled.fetchMock);
    await waitFor(() => expect(controlled.state.audienceReads).toBe(1));

    await userEvent.setup().click(await screen.findByRole('button', {
      name: 'Pick First dance for the Album',
    }));
    expect(controlled.state.audienceReads).toBe(1);
    write.resolve();
    await waitFor(() => expect(controlled.state.audienceReads).toBe(2));
  });

  it('reloads once after a confirmed bulk Pick', async () => {
    const controlled = harness();
    renderWorkspace(controlled.fetchMock);
    const user = userEvent.setup();
    await screen.findByText('First dance');
    await waitFor(() => expect(controlled.state.audienceReads).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select First dance, from Jose' }));
    await user.click(screen.getByRole('button', { name: 'Pick for Album (1)' }));

    await waitFor(() => expect(controlled.state.audienceReads).toBe(2));
  });

  it('reloads only after a debounced Album save is confirmed', async () => {
    const save = deferred();
    const controlled = harness({ orderGates: [save.promise] });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();
    await waitFor(() => expect(controlled.state.audienceReads).toBe(1));
    const title = await screen.findByLabelText('Album title');
    vi.useFakeTimers();

    fireEvent.change(title, { target: { value: 'Saved title' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(controlled.state.audienceReads).toBe(1);
    save.resolve();
    vi.useRealTimers();

    await waitFor(() => expect(controlled.state.audienceReads).toBe(2));
  });

  it('reloads after a section change is confirmed, not when it is queued', async () => {
    const save = deferred();
    const controlled = harness({ orderGates: [save.promise] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await waitFor(() => expect(controlled.state.audienceReads).toBe(1));

    await user.click(await screen.findByRole('button', { name: 'Add a section' }));
    expect(controlled.state.audienceReads).toBe(1);
    save.resolve();

    await waitFor(() => expect(controlled.state.audienceReads).toBe(2));
  });

  it('reloads after a successful Album-link start', async () => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await waitFor(() => expect(controlled.state.audienceReads).toBe(1));

    await user.click(await screen.findByRole('button', { name: 'Create Album link' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Create the Album link?' }))
      .getByRole('button', { name: 'Create Album link' }));

    await waitFor(() => expect(controlled.state.audienceReads).toBe(2));
  });

  it('reloads after a confirmed Album-link stop but not after cancellation', async () => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      share: {
        active: true,
        url: 'https://candidary.test/album#share-id.share-secret',
        sharedAt: '2026-08-23T12:00:00.000Z',
      },
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await waitFor(() => expect(controlled.state.audienceReads).toBe(1));

    await user.click(await screen.findByRole('button', { name: 'Stop Album link' }));
    await user.click(await screen.findByRole('button', { name: 'Keep sharing' }));
    expect(controlled.state.audienceReads).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Stop Album link' }));
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Stop the Album link?' }))
      .getByRole('button', { name: 'Stop Album link' }));

    await waitFor(() => expect(controlled.state.audienceReads).toBe(2));
  });

  it.each([
    ['publish', 'unpublished', 'Publish p1.jpg'],
    ['hide', 'published', 'Hide p1.jpg'],
  ] as const)('reloads after a confirmed single %s', async (_action, status, buttonName) => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { publicationStatus: status })],
    });
    renderWorkspace(controlled.fetchMock, {}, { resourceBackedShared: true });
    const user = userEvent.setup();
    await user.click((await screen.findByRole('group', { name: 'Gallery mode' }))
      .querySelector<HTMLButtonElement>('button:last-child')!);
    if (status === 'published') {
      await user.click(await screen.findByRole('button', { name: 'Published' }));
    }
    await user.click(await screen.findByRole('button', { name: buttonName }));

    await waitFor(() => expect(controlled.state.audienceReads).toBe(2));
  });

  it('settles a deferred single write into the current filter and parent after the filter changes', async () => {
    const write = deferred();
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' })],
    });
    const originalFetch = controlled.fetchMock.getMockImplementation()!;
    controlled.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/media/p1') && (init?.method ?? 'GET') === 'PATCH') await write.promise;
      return originalFetch(input, init);
    });
    const rendered = renderWorkspace(controlled.fetchMock, {}, { resourceBackedShared: true });
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Guest gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Publish p1.jpg' }));
    await user.click(screen.getByRole('button', { name: /^Published$/ }));
    expect(await screen.findByRole('heading', { name: 'No published photos.' })).toBeVisible();

    write.resolve();

    expect(await screen.findByRole('button', { name: 'Hide p1.jpg' })).toBeVisible();
    expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('First dance is Published in the Guest gallery for event guests. Hide it to reverse this.');
    expect(rendered.onPublicationChanged).toHaveBeenCalledOnce();
    expect(rendered.onPublicationChanged).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'p1', publicationStatus: 'published' }),
    ]);
    await waitFor(() => expect(controlled.state.audienceReads).toBe(2));
    const publishedReads = controlled.fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(String(input), 'https://candidary.test');
      return url.pathname.endsWith('/media')
        && url.searchParams.get('status') === 'published'
        && (init?.method ?? 'GET') === 'GET';
    });
    expect(publishedReads).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Library' }));
    expect(await screen.findByText('Guest gallery · Published')).toBeVisible();
    const libraryReads = controlled.fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(String(input), 'https://candidary.test');
      return url.pathname.endsWith('/gallery') && (init?.method ?? 'GET') === 'GET';
    });
    expect(libraryReads).toHaveLength(2);
  });

  it('drops a deferred single confirmation after its event workspace is replaced', async () => {
    const write = deferred();
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' })],
    });
    const originalFetch = controlled.fetchMock.getMockImplementation()!;
    controlled.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/media/p1') && (init?.method ?? 'GET') === 'PATCH') await write.promise;
      return originalFetch(input, init);
    });
    const rendered = renderWorkspace(controlled.fetchMock, {}, { resourceBackedShared: true });
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Guest gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Publish p1.jpg' }));
    await waitFor(() => expect(controlled.state.publicationWrites).toHaveLength(0));

    rendered.rerenderForEvent('event-b');
    await waitFor(() => expect(controlled.state.audienceReads).toBe(2));
    write.resolve();
    await act(async () => { await Promise.resolve(); });

    expect(rendered.onPublicationChanged).not.toHaveBeenCalled();
    expect(controlled.state.audienceReads).toBe(2);
    expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .not.toHaveTextContent('First dance is Published');
  });

  it.each([
    ['publish', 'unpublished', 'Publish selected'],
    ['hide', 'published', 'Hide selected'],
  ] as const)('reloads after a confirmed bulk %s', async (_action, status, buttonName) => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { publicationStatus: status })],
    });
    renderWorkspace(controlled.fetchMock, {}, { resourceBackedShared: true });
    const user = userEvent.setup();
    await user.click((await screen.findByRole('group', { name: 'Gallery mode' }))
      .querySelector<HTMLButtonElement>('button:last-child')!);
    if (status === 'published') {
      await user.click(await screen.findByRole('button', { name: 'Published' }));
    }
    await user.click(await screen.findByRole('checkbox', { name: 'Select p1.jpg' }));
    await user.click(screen.getByRole('button', { name: buttonName }));

    await waitFor(() => expect(controlled.state.audienceReads).toBe(2));
  });

  it('reloads once for a successful mixed-status bulk publication attempt', async () => {
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { publicationStatus: 'unpublished' }),
        photo('p2', '2026-08-15T23:18:00.000Z', { publicationStatus: 'hidden' }),
      ],
    });
    renderWorkspace(controlled.fetchMock, {}, { resourceBackedShared: true, sharedStatus: 'all' });
    const user = userEvent.setup();
    await user.click((await screen.findByRole('group', { name: 'Gallery mode' }))
      .querySelector<HTMLButtonElement>('button:last-child')!);
    await user.click(await screen.findByRole('checkbox', { name: 'Select p1.jpg' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Select p2.jpg' }));
    await waitFor(() => expect(controlled.state.audienceReads).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Publish selected' }));

    await waitFor(() => expect(controlled.state.publicationWrites).toHaveLength(2));
    expect(controlled.state.audienceReads).toBe(2);
  });

  it('continues a deferred mixed bulk and reconciles the current filter once after it changes', async () => {
    const firstGroup = deferred();
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { publicationStatus: 'unpublished' }),
        photo('p2', '2026-08-15T23:18:00.000Z', { publicationStatus: 'hidden' }),
      ],
    });
    const originalFetch = controlled.fetchMock.getMockImplementation()!;
    let bulkAttempts = 0;
    controlled.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/media/bulk')) {
        bulkAttempts += 1;
        if (bulkAttempts === 1) await firstGroup.promise;
      }
      return originalFetch(input, init);
    });
    const rendered = renderWorkspace(controlled.fetchMock, {}, {
      resourceBackedShared: true,
      sharedStatus: 'all',
    });
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Guest gallery' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Select p1.jpg' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Select p2.jpg' }));
    await user.click(screen.getByRole('button', { name: 'Publish selected' }));
    await user.click(screen.getByRole('button', { name: /^Published$/ }));
    expect(await screen.findByRole('heading', { name: 'No published photos.' })).toBeVisible();

    firstGroup.resolve();

    await waitFor(() => expect(bulkAttempts).toBe(2));
    expect(await screen.findByRole('button', { name: 'Hide p1.jpg' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide p2.jpg' })).toBeVisible();
    expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('2 photos are Published in the Guest gallery for event guests. Hide them to reverse this.');
    expect(rendered.onPublicationChanged).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(controlled.state.audienceReads).toBe(2));
    const publishedReads = controlled.fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(String(input), 'https://candidary.test');
      return url.pathname.endsWith('/media')
        && url.searchParams.get('status') === 'published'
        && (init?.method ?? 'GET') === 'GET';
    });
    expect(publishedReads).toHaveLength(2);
  });

  it('reloads once for a partially successful mixed bulk attempt and once for its retry', async () => {
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { publicationStatus: 'unpublished' }),
        photo('p2', '2026-08-15T23:18:00.000Z', { publicationStatus: 'hidden' }),
      ],
    });
    const originalFetch = controlled.fetchMock.getMockImplementation()!;
    let bulkAttempts = 0;
    controlled.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/media/bulk')) {
        bulkAttempts += 1;
        if (bulkAttempts === 2) return failure('The hidden group failed.', 503);
      }
      return originalFetch(input, init);
    });
    renderWorkspace(controlled.fetchMock, {}, { resourceBackedShared: true, sharedStatus: 'all' });
    const user = userEvent.setup();
    await user.click((await screen.findByRole('group', { name: 'Gallery mode' }))
      .querySelector<HTMLButtonElement>('button:last-child')!);
    await user.click(await screen.findByRole('checkbox', { name: 'Select p1.jpg' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Select p2.jpg' }));
    await waitFor(() => expect(controlled.state.audienceReads).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Publish selected' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The hidden group failed.');
    expect(document.querySelector('[data-gallery-live-host] [role="status"]')).toHaveTextContent(
      '1 photo is Published in the Guest gallery for event guests. Hide it to reverse this. 1 remaining photo could not be published. Try again to continue.',
    );
    expect(controlled.state.audienceReads).toBe(2);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bulkAttempts).toBe(3));
    await waitFor(() => expect(controlled.state.audienceReads).toBe(3));
    expect(document.querySelector('[data-gallery-live-host] [role="status"]')).toHaveTextContent(
      '1 photo is Published in the Guest gallery for event guests. Hide it to reverse this.',
    );
  });

  it('reloads once for a confirmed Album membership removal and its associated save', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: { revision: 2, saved: true, entries: [{ kind: 'photo', photo: p1 }] },
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await waitFor(() => expect(controlled.state.audienceReads).toBe(1));

    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));

    await waitFor(() => expect(controlled.state.albumReads).toBe(2));
    expect(controlled.state.orderWrites).toHaveLength(1);
    expect(controlled.state.audienceReads).toBe(2);
  });

  it('reloads after a membership save conflict adopts a newer canonical Album', async () => {
    const conflictRead = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z');
    const controlled = harness({
      galleryRows: [p1, p2],
      album: { revision: 2, saved: true, entries: [{ kind: 'photo', photo: p1 }] },
      audienceSummary: {
        albumPhotoCount: 1,
        albumEntryCount: 1,
        albumLink: { active: false, sharedAt: null },
        guestGalleryVisible: true,
        guestGalleryPublishedCount: 0,
      },
      albumReadGates: [undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await screen.findByText('Album: 1 photo · Link: Off · Guest gallery: On, 0 published');

    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    await screen.findByText('Album: 0 photos · Link: Off · Guest gallery: On, 0 published');
    await waitFor(() => expect(controlled.state.albumReads).toBe(2));

    controlled.state.galleryRows[1]!.isFavorite = true;
    controlled.state.album = {
      revision: 3,
      saved: true,
      entries: [
        { kind: 'photo', photo: controlled.state.galleryRows[1]! },
        { kind: 'section', id: 'co-host-section', heading: 'After party' },
      ],
    };
    controlled.state.audienceSummary = {
      ...controlled.state.audienceSummary,
      albumPhotoCount: 1,
      albumEntryCount: 2,
    };
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.audienceReads).toBe(3));
    expect(await screen.findByText(
      'Album: 1 photo · Link: Off · Guest gallery: On, 0 published',
    )).toBeVisible();
  });

  it('still reloads for an unrelated metadata edit coalesced into a membership save', async () => {
    const membership = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: { revision: 2, saved: true, entries: [{ kind: 'photo', photo: p1 }] },
      pickGates: [membership.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await waitFor(() => expect(controlled.state.audienceReads).toBe(1));

    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    await waitFor(() => expect(controlled.state.pickWrites).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Album title'), { target: { value: 'Coalesced title' } });
    membership.resolve();

    await waitFor(() => expect(controlled.state.albumReads).toBe(2));
    expect(controlled.state.metadataWrites.at(-1)?.title).toBe('Coalesced title');
    expect(controlled.state.audienceReads).toBe(3);
  });

  it('verifies a confirmed Album membership Undo and reloads its Manager owner', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: { revision: 2, saved: true, entries: [{ kind: 'photo', photo: p1 }] },
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(2));
    const readsAfterRemove = controlled.state.audienceReads;

    const albumReadsAfterRemove = controlled.state.albumReads;
    await user.click(await screen.findByRole('button', { name: 'Undo' }));

    // The mount-independent inverse verifies before membership, verifies after it,
    // then the Manager invalidator reloads the mounted Album owner.
    await waitFor(() => expect(controlled.state.albumReads - albumReadsAfterRemove).toBe(3));
    expect(controlled.state.orderWrites).toHaveLength(2);
    expect(controlled.state.audienceReads - readsAfterRemove).toBe(1);
  });

  it('does not reload after a failed Pick write', async () => {
    const controlled = harness({ pickErrors: ['Pick failed.'] });
    renderWorkspace(controlled.fetchMock);
    const user = userEvent.setup();
    await screen.findByText('First dance');
    await waitFor(() => expect(controlled.state.audienceReads).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select First dance, from Jose' }));
    await user.click(screen.getByRole('button', { name: 'Pick for Album (1)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick failed.');
    expect(controlled.state.audienceReads).toBe(1);
  });
});

describe('selecting photos into the album', () => {
  it('safety ladder reversible: uses literal Pick and Remove from Album actions with canonical bulk results', async () => {
    const { state, fetchMock } = harness();
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByText('First dance');

    expect(screen.queryByRole('region', { name: 'Album' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Select photos/ }));
    await user.click(await screen.findByRole('button', { name: /^Select First dance/ }));

    const tray = await screen.findByRole('region', { name: 'Album' });
    expect(within(tray).getByText('1 of 50 selected')).toBeVisible();
    expect(within(tray).getByText(
      'Pick changes Album membership only. Remove from Album keeps every delivered photo in Library; neither action publishes to the Guest gallery.',
    )).toBeVisible();
    const remove = within(tray).getByRole('button', { name: 'Remove from Album (1)' });
    expect(remove.querySelector('.lucide-minus')).not.toBeNull();
    expect(remove.querySelector('.lucide-check')).toBeNull();
    const galleryStatus = document.querySelector<HTMLElement>('[data-gallery-live-host] [role="status"]');
    expect(galleryStatus).toHaveTextContent('First dance selected. 1 selected.');

    expect(state.pickWrites).toEqual([]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(within(tray).getByRole('button', { name: 'Pick for Album (1)' }));
    await waitFor(() => expect(state.pickWrites).toEqual([{ mediaIds: ['p1'], picked: true }]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Album' })).not.toBeInTheDocument());
    expect(galleryStatus).toHaveTextContent(
      '1 photo picked for Album.',
    );
    expect(document.querySelector('.album-undo [role="status"]')).toHaveTextContent(
      '1 photo picked for Album. Nothing was published. Undo is available for nine seconds.',
    );
    expect(document.querySelectorAll('[data-gallery-live-host] [role="status"]')).toHaveLength(1);
  });

  it('names pick and selection state independently without a duplicate Album badge', async () => {
    const { fetchMock } = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', {
          caption: 'First dance',
          isFavorite: true,
        }),
        photo('p2', '2026-08-15T22:43:00.000Z'),
      ],
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByText('First dance');

    expect(screen.getByRole('button', {
      name: 'Remove First dance from Album',
    })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', {
      name: 'Pick p2.jpg for the Album',
    })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('In the album')).not.toBeInTheDocument();
    expect(screen.queryByText('Not in the album')).not.toBeInTheDocument();
    expect(screen.getByText('In Album')).toBeVisible();
    expect(document.querySelector('.gallery-mosaic__album-badge')).toBeNull();

    const picks = screen.getByRole('button', { name: 'Album picks (1)' });
    expect(picks.querySelector('.lucide-check')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    const first = screen.getByRole('button', { name: 'Select First dance, from Jose' });
    await user.click(first);
    expect(screen.getByRole('button', {
      name: 'Deselect First dance, from Jose',
    })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(screen.getByRole('region', { name: 'Album' }))
      .getByRole('button', { name: 'Clear selection' }));
    expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('Selection cleared.');
  });

  it('selects and clears an entire collapsed moment, including at the selection cap', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => photo(
      `p${index + 1}`,
      new Date(Date.parse('2026-08-15T22:42:00.000Z') + index * 1_000).toISOString(),
    ));
    const { fetchMock } = harness({ galleryRows: rows });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByText('p1.jpg');

    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    expect(document.querySelectorAll('.gallery-mosaic__item')).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: 'Select this moment' }));
    expect(await screen.findByRole('region', { name: 'Album' }))
      .toHaveTextContent('50 of 50 selected. Remove one to choose another.');
    expect(screen.getByRole('button', { name: 'Clear this moment' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Clear this moment' }));
    expect(screen.queryByRole('region', { name: 'Album' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select this moment' })).toBeEnabled();
  });

  it('clears Library selection when its Gallery mode is left', async () => {
    const { fetchMock } = harness();
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByText('First dance');

    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select First dance, from Jose' }));
    expect(screen.getByRole('region', { name: 'Album' })).toBeVisible();

    const modes = screen.getByRole('group', { name: 'Gallery mode' });
    await user.click(within(modes).getByRole('button', { name: 'Guest gallery' }));
    await user.click(within(modes).getByRole('button', { name: 'Library' }));
    expect(screen.queryByRole('region', { name: 'Album' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Select First dance, from Jose',
    })).toHaveAttribute('aria-pressed', 'false');
  });

  it('restores focus after Clear, a completed bulk action, and Dismiss remove their bars', async () => {
    const { fetchMock } = harness();
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    const selectPhotos = await screen.findByRole('button', { name: 'Select photos' });

    await user.click(selectPhotos);
    await user.click(screen.getByRole('button', { name: 'Select First dance, from Jose' }));
    const clear = within(screen.getByRole('region', { name: 'Album' }))
      .getByRole('button', { name: 'Clear selection' });
    clear.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(selectPhotos).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Select First dance, from Jose' }));
    const add = within(screen.getByRole('region', { name: 'Album' }))
      .getByRole('button', { name: 'Pick for Album (1)' });
    add.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());

    const dismiss = await screen.findByRole('button', { name: 'Dismiss' });
    dismiss.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(selectPhotos).toHaveFocus());
  });

  it('uses canonical Album-membership result copy and reverses only what changed', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByText('First dance');

    await user.click(screen.getByRole('button', { name: /Select photos/ }));
    await user.click(await screen.findByRole('button', { name: /^Select First dance/ }));
    await user.click(await screen.findByRole('button', { name: /^Select p2\.jpg/ }));
    await user.click(await screen.findByRole('button', { name: 'Pick for Album (2)' }));

    // p2 was already In Album, so only p1 changed and only p1 comes back out.
    expect(await screen.findByText('1 photo picked for Album. Nothing was published.')).toBeVisible();
    const galleryStatus = document.querySelector<HTMLElement>('[data-gallery-live-host] [role="status"]');
    expect(galleryStatus).toHaveTextContent(
      '1 photo picked for Album.',
    );
    expect(document.querySelector('.album-undo [role="status"]')).toHaveTextContent(
      '1 photo picked for Album. Nothing was published. Undo is available for nine seconds.',
    );
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(state.pickWrites.at(-1)).toEqual({ mediaIds: ['p1'], picked: false }));
    expect(document.querySelector('.album-undo [role="status"]'))
      .toHaveTextContent('Change undone.');
    expect(document.querySelectorAll('[data-gallery-live-host] [role="status"]')).toHaveLength(1);
    expect(state.galleryRows.find((item) => item.id === 'p2')?.isFavorite).toBe(true);
  });
});

describe('the album', () => {
  it('uses the event name as the first-run Album title and keeps a cleared title invalid and unsaved', async () => {
    const controlled = harness({
      album: {
        revision: 0,
        saved: false,
        entries: [],
        title: event.name,
      },
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();
    const title = await screen.findByLabelText('Album title');

    expect(title).toHaveValue(event.name);
    expect(title).toHaveAttribute('placeholder', event.name);

    vi.useFakeTimers();
    fireEvent.change(title, { target: { value: '' } });
    fireEvent.blur(title);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(title).toHaveValue('');
    expect(title).toHaveAttribute('placeholder', event.name);
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Give this album a title.')).toBeVisible();
    expect(controlled.state.metadataWrites).toEqual([]);
  });

  it('keeps an existing customized Album title while retaining the event-name placeholder', async () => {
    const controlled = harness({
      album: {
        revision: 4,
        saved: true,
        entries: [],
        title: 'The evening',
      },
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();

    const title = await screen.findByLabelText('Album title');
    expect(title).toHaveValue('The evening');
    expect(title).toHaveAttribute('placeholder', event.name);
    expect(controlled.state.metadataWrites).toEqual([]);
  });

  it('uses only Album-pick terminology in the exact one-time reconciliation state', async () => {
    const { fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      album: {
        revision: 4,
        saved: false,
        entries: [],
        pickGeneration: 12,
        reconciliation: { kind: 'historical', historicalPickCount: 1 },
      },
    });
    renderWorkspace(fetchMock);
    await openAlbum();

    expect(await screen.findByText('Not started yet')).toBeVisible();
    expect(screen.getByText('Earlier Album picks')).toBeVisible();
    expect(screen.getByRole('heading', {
      name: '1 existing pick from before this update.',
    })).toBeVisible();
    expect(screen.getByText(/This choice applies to every Album pick that exists now/)).toBeVisible();
    expect(screen.getByText('Starting empty clears those Album picks. It never deletes a delivered photo.')).toBeVisible();
    expect(document.querySelector('.album-reconcile'))
      .not.toHaveTextContent(/before Albums|favorites?|favorited|hearts?/iu);
    expect(screen.getByRole('button', { name: 'Start the Album from it' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Preview album' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create Album link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download album photos' })).not.toBeInTheDocument();
  });

  it('reconciliation auto-starts one StrictMode observation once and adopts the advanced revision', async () => {
    const start = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: {
        revision: 7,
        saved: false,
        entries: [],
        pickGeneration: 41,
        reconciliation: { kind: 'initialize' },
      },
      startGates: [start.promise],
    });
    renderWorkspace(controlled.fetchMock, {}, { strictMode: true });
    await openAlbum();

    expect(await screen.findByRole('status', { name: 'Starting the Album from current picks…' }))
      .toBeVisible();
    await waitFor(() => expect(controlled.state.startRequests).toEqual([{
      start: 'from-picks',
      expectedReconciliation: 'initialize',
      expectedPickGeneration: 41,
      expectedRevision: 7,
    }]));
    expect(screen.queryByText('Earlier Album picks')).not.toBeInTheDocument();

    start.resolve();
    const description = await screen.findByLabelText('Description');
    vi.useFakeTimers();
    fireEvent.change(description, { target: { value: 'Saved after automatic start.' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(controlled.state.startWrites).toEqual(['from-picks']);
    expect(controlled.state.orderRevisions).toEqual([8]);
  });

  it('reconciliation waits for running Manager Undo before its single auto-start', async () => {
    const undo = deferred();
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      album: {
        revision: 13,
        saved: false,
        entries: [],
        pickGeneration: 29,
        reconciliation: { kind: 'initialize' },
      },
    });
    renderAlbum(controlled.fetchMock, { runningUndo: undo.promise });

    expect(await screen.findByRole('button', { name: 'Undoing…' })).toBeDisabled();
    expect(await screen.findByRole('status', { name: 'Starting the Album from current picks…' }))
      .toBeVisible();
    expect(controlled.state.startRequests).toEqual([]);

    undo.resolve();

    await waitFor(() => expect(controlled.state.startRequests).toEqual([{
      start: 'from-picks',
      expectedReconciliation: 'initialize',
      expectedPickGeneration: 29,
      expectedRevision: 13,
    }]));
  });

  it.each([
    ['from-picks', 'Start the Album from it'],
    ['empty', 'Start empty'],
  ] as const)('reconciliation manual %s sends the complete observed expectation triple', async (
    start,
    buttonName,
  ) => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      album: {
        revision: 5,
        saved: false,
        entries: [],
        pickGeneration: 23,
        reconciliation: { kind: 'historical', historicalPickCount: 1 },
      },
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: buttonName }));

    expect(controlled.state.startRequests).toEqual([{
      start,
      expectedReconciliation: 'historical',
      expectedPickGeneration: 23,
      expectedRevision: 5,
    }]);
  });

  it('reconciliation obeys an over-capacity projection with zero historical picks', async () => {
    const controlled = harness({
      galleryRows: [],
      album: {
        revision: 9,
        saved: false,
        entries: [],
        pickGeneration: 37,
        reconciliation: {
          kind: 'over-capacity',
          pickCount: 501,
          historicalPickCount: 0,
        },
      },
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    const fromPicks = await screen.findByRole('button', { name: 'Start the Album from them' });
    const reason = 'Start from picks is unavailable because 501 picks exceed the 500-entry Album limit.';
    expect(fromPicks).toBeEnabled();
    expect(fromPicks).toHaveAttribute('aria-disabled', 'true');
    expect(fromPicks).toHaveAccessibleDescription(reason);
    expect(screen.getByText(reason)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeEnabled();

    await user.click(fromPicks);
    expect(controlled.state.startRequests).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Start empty' }));
    expect(controlled.state.startRequests).toEqual([{
      start: 'empty',
      expectedReconciliation: 'over-capacity',
      expectedPickGeneration: 37,
      expectedRevision: 9,
    }]);
  });

  it('reconciliation null with zero picks renders the ordinary empty Album', async () => {
    const controlled = harness({
      galleryRows: [],
      album: {
        revision: 3,
        saved: false,
        entries: [],
        pickGeneration: 18,
        reconciliation: null,
      },
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();

    expect(await screen.findByRole('heading', { name: 'The Album is empty.' })).toBeVisible();
    expect(screen.queryByText('Earlier Album picks')).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Starting the Album from current picks…' }))
      .not.toBeInTheDocument();
    expect(controlled.state.startRequests).toEqual([]);
  });

  it('reconciliation conflict reloads canonical state once without silently retrying auto-start', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: {
        revision: 7,
        saved: false,
        entries: [],
        pickGeneration: 41,
        reconciliation: { kind: 'initialize' },
      },
      startFailures: [{
        message: 'The Album changed before it could be started.',
        code: 'REVISION_CONFLICT',
        album: {
          revision: 8,
          saved: true,
          entries: [{ kind: 'photo', photo: p1 }],
          pickGeneration: 42,
          reconciliation: null,
        },
      }],
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();

    expect(await screen.findByText('The Album changed before it could be started.')).toBeVisible();
    expect(await screen.findByLabelText('Album title')).toBeVisible();
    expect(controlled.state.albumReads).toBe(2);
    expect(controlled.state.startRequests).toHaveLength(1);
    expect(controlled.state.startWrites).toEqual(['from-picks']);
  });

  it('reconciliation exposes explicit retry after conflict reload remains initialize', async () => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      album: {
        revision: 7,
        saved: false,
        entries: [],
        pickGeneration: 41,
        reconciliation: { kind: 'initialize' },
      },
      startFailures: [{
        message: 'The Album changed before it could be started.',
        code: 'REVISION_CONFLICT',
        album: {
          revision: 8,
          saved: false,
          entries: [],
          pickGeneration: 42,
          reconciliation: { kind: 'initialize' },
        },
      }],
    });
    renderAlbum(controlled.fetchMock);

    expect(await screen.findByText('The Album changed before it could be started.')).toBeVisible();
    await waitFor(() => expect(controlled.state.albumReads).toBe(2));
    await act(async () => { await Promise.resolve(); });
    expect(controlled.state.startRequests).toEqual([{
      start: 'from-picks',
      expectedReconciliation: 'initialize',
      expectedPickGeneration: 41,
      expectedRevision: 7,
    }]);

    await userEvent.setup().click(screen.getByRole('button', {
      name: 'Try starting from current picks',
    }));

    expect(controlled.state.startRequests).toEqual([
      {
        start: 'from-picks',
        expectedReconciliation: 'initialize',
        expectedPickGeneration: 41,
        expectedRevision: 7,
      },
      {
        start: 'from-picks',
        expectedReconciliation: 'initialize',
        expectedPickGeneration: 42,
        expectedRevision: 8,
      },
    ]);
  });

  it('reconciliation drops a late auto-start response from a retired event generation', async () => {
    const start = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const first = harness({
      galleryRows: [p1],
      album: {
        revision: 2,
        saved: false,
        entries: [],
        pickGeneration: 4,
        reconciliation: { kind: 'initialize' },
      },
      startGates: [start.promise],
    });
    const second = harness({
      galleryRows: [],
      album: {
        revision: 11,
        saved: true,
        entries: [],
        title: 'Second event Album',
        pickGeneration: 0,
        reconciliation: null,
      },
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => (
      String(input).includes('/events/event-a/')
        ? first.fetchMock(input, init)
        : second.fetchMock(input, init)
    ));
    vi.stubGlobal('fetch', fetchMock);
    const onPicksChanged = vi.fn();
    const onAudienceChanged = vi.fn();

    function EventAlbum({ eventId }: { eventId: string }) {
      return <ManagerUndoProvider key={eventId} eventId={eventId}>
        <ManagerAlbum
          key={eventId}
          eventId={eventId}
          eventName={eventId === 'event-a' ? event.name : 'Second event'}
          active
          onGoToLibrary={vi.fn()}
          onPicksChanged={onPicksChanged}
          invalidateGalleryAfterMutation={vi.fn()}
          onAudienceChanged={onAudienceChanged}
          exportSource={{ count: 0, freshness: 'fresh' }}
          onPrepareExport={noop}
          onDownloadExport={noop}
          onRetryExport={noop}
        />
      </ManagerUndoProvider>;
    }

    const rendered = render(<EventAlbum eventId="event-a" />);
    await waitFor(() => expect(first.state.startRequests).toHaveLength(1));
    rendered.rerender(<EventAlbum eventId="event-b" />);
    expect(await screen.findByDisplayValue('Second event Album')).toBeVisible();
    onPicksChanged.mockClear();
    onAudienceChanged.mockClear();

    start.resolve();
    await waitFor(() => expect(first.state.album.saved).toBe(true));

    expect(onPicksChanged).not.toHaveBeenCalled();
    expect(onAudienceChanged).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Second event Album')).toBeVisible();
  });

  it('debounces one complete metadata draft for 600ms and composes overlapping edits against the returned revision', async () => {
    const firstSave = deferred();
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      album: {
        revision: 7,
        saved: true,
        entries: [],
        title: 'Album',
        description: '',
        coverMediaId: null,
      },
      orderGates: [firstSave.promise],
    });
    renderWorkspace(fetchMock);
    await openAlbum();
    const title = await screen.findByLabelText('Album title');
    const description = screen.getByLabelText('Description');

    vi.useFakeTimers();
    fireEvent.change(title, { target: { value: 'The evening' } });
    act(() => { vi.advanceTimersByTime(599); });
    expect(state.orderWrites).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(1); });
    expect(state.orderWrites).toHaveLength(1);
    expect(state.orderRevisions).toEqual([7]);
    expect(state.metadataWrites[0]).toEqual({
      title: 'The evening',
      description: '',
      coverMediaId: null,
    });

    fireEvent.change(description, { target: { value: 'The photographs we kept together.' } });
    fireEvent.change(title, { target: { value: 'After party' } });
    act(() => { vi.advanceTimersByTime(600); });
    expect(state.orderWrites).toHaveLength(1);
    vi.useRealTimers();

    await act(async () => { firstSave.resolve(); });
    await waitFor(() => expect(state.orderWrites).toHaveLength(2));
    expect(state.orderRevisions).toEqual([7, 8]);
    expect(state.metadataWrites[1]).toEqual({
      title: 'After party',
      description: 'The photographs we kept together.',
      coverMediaId: null,
    });
  });

  it('keeps the album autosave queue usable after StrictMode effect replay', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const { state, fetchMock } = harness({
      galleryRows: [p1],
      album: {
        revision: 2,
        saved: true,
        entries: [{ kind: 'photo', photo: p1 }],
      },
    });
    renderWorkspace(fetchMock, {}, { strictMode: true });
    await openAlbum();
    const title = await screen.findByLabelText('Album title');
    vi.useFakeTimers();

    fireEvent.change(title, { target: { value: 'Strict album' } });
    expect(screen.getByText('Saving…')).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(state.metadataWrites.at(-1)).toMatchObject({ title: 'Strict album' });
  });

  it('normalizes an offline Album save to one Retry without a competing notice', async () => {
    const controlled = harness();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/album') && init?.method === 'PUT') {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return controlled.fetchMock(input, init);
    });
    renderWorkspace(fetchMock);
    await openAlbum();
    const title = await screen.findByLabelText('Album title');

    fireEvent.change(title, { target: { value: 'Offline album' } });
    fireEvent.blur(title);

    const retry = await screen.findByRole('button', { name: 'Retry album' });
    const status = retry.closest('.autosave-status');
    expect(status).not.toBeNull();
    expect(status).toHaveTextContent(
      'Couldn’t save. Check your connection, then try saving the Album again.',
    );
    expect(screen.getAllByRole('button', { name: 'Retry album' })).toHaveLength(1);
    expect(screen.queryByText(/Failed to fetch/iu)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries only the newest failed Album draft once on reconnect', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const controlled = harness();
    const requests: Array<{ metadata: AlbumMetadataInput }> = [];
    let offline = true;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/album') && init?.method === 'PUT') {
        requests.push(JSON.parse(String(init.body)) as { metadata: AlbumMetadataInput });
        if (offline) return Promise.reject(new TypeError('Failed to fetch'));
      }
      return controlled.fetchMock(input, init);
    });
    renderWorkspace(fetchMock);
    await openAlbum();
    const title = await screen.findByLabelText('Album title');
    const description = screen.getByLabelText('Description');

    // Keep replacing the pending snapshot before the first rejected request
    // settles. The queue must expose and later retry only the last complete one.
    fireEvent.change(title, { target: { value: 'First offline title' } });
    fireEvent.blur(title);
    fireEvent.change(description, { target: { value: 'Newest offline description.' } });
    fireEvent.blur(description);
    fireEvent.change(title, { target: { value: 'Newest offline title' } });
    fireEvent.blur(title);

    await screen.findByRole('button', { name: 'Retry album' });
    await waitFor(() => expect(addEventListener)
      .toHaveBeenCalledWith('online', expect.any(Function)));
    expect(requests).toHaveLength(2);
    expect(requests.at(-1)?.metadata).toMatchObject({
      title: 'Newest offline title',
      description: 'Newest offline description.',
    });

    offline = false;
    act(() => { window.dispatchEvent(new Event('online')); });

    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests.at(-1)?.metadata).toMatchObject({
      title: 'Newest offline title',
      description: 'Newest offline description.',
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry album' }))
      .not.toBeInTheDocument());

    act(() => { window.dispatchEvent(new Event('online')); });
    await act(async () => { await Promise.resolve(); });
    expect(requests).toHaveLength(3);
  });

  it('catches reconnect before failed-save passive effects and retries the newest draft once', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const controlled = harness();
    const requests: Array<{ metadata: AlbumMetadataInput }> = [];
    let offline = true;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/album') && init?.method === 'PUT') {
        requests.push(JSON.parse(String(init.body)) as { metadata: AlbumMetadataInput });
        if (offline) return Promise.reject(new TypeError('Failed to fetch'));
      }
      return controlled.fetchMock(input, init);
    });
    renderWorkspace(fetchMock);
    await openAlbum();

    // A mounted listener must exist before any request can reject. Observing the
    // failed-state DOM then fires in the browser microtask checkpoint, before
    // React can install a passive effect for that same commit.
    expect(addEventListener.mock.calls.filter(([type]) => type === 'online')).toHaveLength(1);
    let dispatched = false;
    const reconnectObserved = new Promise<void>((resolveReconnect) => {
      const observer = new MutationObserver(() => {
        if (dispatched || !screen.queryByRole('button', { name: 'Retry album' })) return;
        dispatched = true;
        observer.disconnect();
        offline = false;
        window.dispatchEvent(new Event('online'));
        resolveReconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });

    const title = await screen.findByLabelText('Album title');
    const description = screen.getByLabelText('Description');
    fireEvent.change(title, { target: { value: 'First disconnected title' } });
    fireEvent.blur(title);
    fireEvent.change(description, { target: { value: 'Newest disconnected description.' } });
    fireEvent.blur(description);
    fireEvent.change(title, { target: { value: 'Newest disconnected title' } });
    fireEvent.blur(title);

    await reconnectObserved;
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests.at(-1)?.metadata).toMatchObject({
      title: 'Newest disconnected title',
      description: 'Newest disconnected description.',
    });

    window.dispatchEvent(new Event('online'));
    await act(async () => { await Promise.resolve(); });
    expect(requests).toHaveLength(3);
  });

  it('retries a conflict-rebased newest Album draft on reconnect', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const conflictRead = deferred();
    const controlled = harness({
      albumReadGates: [undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    const requests: Array<{ metadata: AlbumMetadataInput }> = [];
    let putAttempt = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/album') && init?.method === 'PUT') {
        putAttempt += 1;
        requests.push(JSON.parse(String(init.body)) as { metadata: AlbumMetadataInput });
        if (putAttempt === 2) return Promise.reject(new TypeError('Failed to fetch'));
      }
      return controlled.fetchMock(input, init);
    });
    renderWorkspace(fetchMock);
    await openAlbum();
    const title = await screen.findByLabelText('Album title');

    fireEvent.change(title, { target: { value: 'Rejected title' } });
    fireEvent.blur(title);
    await waitFor(() => expect(controlled.state.albumReads).toBe(2));

    const description = screen.getByLabelText('Description');
    fireEvent.change(description, { target: { value: 'Newest edit during conflict recovery.' } });
    fireEvent.blur(description);
    act(() => { conflictRead.resolve(); });

    await screen.findByRole('button', { name: 'Retry album' });
    await waitFor(() => expect(addEventListener)
      .toHaveBeenCalledWith('online', expect.any(Function)));
    expect(requests).toHaveLength(2);
    expect(requests.at(-1)?.metadata).toMatchObject({
      title: 'Album',
      description: 'Newest edit during conflict recovery.',
    });

    act(() => { window.dispatchEvent(new Event('online')); });

    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests.at(-1)?.metadata).toMatchObject({
      title: 'Album',
      description: 'Newest edit during conflict recovery.',
    });
  });

  it('returns a terminal ready outcome only after the current Album generation settles', async () => {
    const save = deferred();
    const controlled = harness({ orderGates: [save.promise] });
    const { albumRef } = renderAlbum(controlled.fetchMock);
    const title = await screen.findByLabelText('Album title');
    fireEvent.change(title, { target: { value: 'Settled before leaving' } });

    let settled = false;
    const preparation = albumRef.current!.prepareToLeave().then((outcome) => {
      settled = true;
      return outcome;
    });
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(1));
    expect(settled).toBe(false);

    act(() => { save.resolve(); });
    await expect(preparation).resolves.toEqual({ status: 'ready' });
  });

  it('returns exact invalid and failed Album leave outcomes', async () => {
    const invalid = harness();
    const invalidView = renderAlbum(invalid.fetchMock);
    const title = await screen.findByLabelText('Album title');
    fireEvent.change(title, { target: { value: '' } });

    await expect(invalidView.albumRef.current!.prepareToLeave()).resolves.toEqual({
      status: 'invalid',
      field: 'Album title',
    });

    cleanup();
    const failed = harness({
      orderErrors: ['This management session has expired.'],
      orderErrorCodes: ['SESSION_EXPIRED'],
    });
    const failedView = renderAlbum(failed.fetchMock);
    const failedTitle = await screen.findByLabelText('Album title');
    fireEvent.change(failedTitle, { target: { value: 'Cannot save' } });
    fireEvent.blur(failedTitle);
    await screen.findByText('This management session has expired.');

    await expect(failedView.albumRef.current!.prepareToLeave()).resolves.toEqual({
      status: 'failed',
      message: 'This management session has expired.',
    });
  });

  it('discards scheduled Album work while allowing an already-sent request to finish', async () => {
    const scheduled = harness();
    const scheduledView = renderAlbum(scheduled.fetchMock);
    const scheduledTitle = await screen.findByLabelText('Album title');
    vi.useFakeTimers();
    fireEvent.change(scheduledTitle, { target: { value: 'Never sent' } });

    scheduledView.albumRef.current!.discardPendingAlbumChanges();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(scheduled.state.orderWrites).toHaveLength(0);

    cleanup();
    vi.useRealTimers();
    const inFlight = deferred();
    const sent = harness({ orderGates: [inFlight.promise] });
    const sentView = renderAlbum(sent.fetchMock);
    const sentTitle = await screen.findByLabelText('Album title');
    fireEvent.change(sentTitle, { target: { value: 'Already sent' } });
    fireEvent.blur(sentTitle);
    await waitFor(() => expect(sent.state.orderWrites).toHaveLength(1));

    sentView.albumRef.current!.discardPendingAlbumChanges();
    act(() => { inFlight.resolve(); });
    await waitFor(() => expect(sent.state.album.title).toBe('Already sent'));
    expect(sent.state.orderWrites).toHaveLength(1);
  });

  it('offers Retry, Stay, and exact-destination discard for an invalid Album mode exit', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    const title = await screen.findByLabelText('Album title');

    await user.clear(title);
    expect(screen.getByText('Give this album a title.')).toBeVisible();
    expect(title).toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    expect(screen.queryByText('What people with the Album link see')).not.toBeInTheDocument();
    expect(title).toHaveFocus();

    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));
    const prompt = await screen.findByRole('region', { name: 'Album changes are not saved yet' });
    expect(prompt).toHaveFocus();
    expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ })).toHaveAttribute('aria-pressed', 'true');
    const retry = within(prompt).getByRole('button', { name: 'Retry' });
    expect(within(prompt).getByRole('button', { name: 'Stay in Album' })).toBeEnabled();
    expect(within(prompt).queryByRole('button', { name: 'Stay and fix settings' }))
      .not.toBeInTheDocument();
    expect(within(prompt).getByRole('button', {
      name: 'Discard unsent Album changes and leave',
    })).toBeEnabled();

    await user.click(retry);
    await waitFor(() => expect(retry).toHaveFocus());
    await user.click(within(prompt).getByRole('button', { name: 'Stay in Album' }));
    expect(screen.queryByRole('region', { name: 'Album changes are not saved yet' }))
      .not.toBeInTheDocument();
    expect(title).toHaveFocus();

    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));
    await user.click(within(await screen.findByRole('region', { name: 'Album changes are not saved yet' }))
      .getByRole('button', { name: 'Discard unsent Album changes and leave' }));
    expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true');
    expect(state.orderWrites).toHaveLength(0);
  });

  it('keeps the requested Gallery-mode destination stable while Album settlement is active', async () => {
    const save = deferred();
    const controlled = harness({ orderGates: [save.promise] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    fireEvent.change(await screen.findByLabelText('Album title'), {
      target: { value: 'Newest mode wins' },
    });
    const modes = within(screen.getByRole('group', { name: 'Gallery mode' }));

    await user.click(modes.getByRole('button', { name: 'Library' }));
    const prompt = await screen.findByRole('region', {
      name: 'Album changes are not saved yet',
    });
    expect(within(prompt).getByRole('button', {
      name: 'Discard unsent Album changes and leave',
    })).toBeDisabled();
    expect(within(prompt).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(within(prompt).getByRole('button', { name: 'Stay in Album' })).toBeEnabled();
    expect(modes.getByRole('button', { name: 'Guest gallery' })).toBeDisabled();
    await user.click(modes.getByRole('button', { name: 'Guest gallery' }));
    expect(modes.getByRole('button', { name: /^Album/ })).toHaveAttribute('aria-pressed', 'true');

    act(() => { save.resolve(); });
    await waitFor(() => expect(modes.getByRole('button', { name: 'Library' }))
      .toHaveAttribute('aria-pressed', 'true'));
    expect(modes.getByRole('button', { name: 'Guest gallery' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('region', { name: 'Album changes are not saved yet' }))
      .not.toBeInTheDocument();
  });

  it('retries the existing failed Album draft and keeps Retry stable until it settles', async () => {
    const retrySave = deferred();
    const controlled = harness({
      orderGates: [Promise.resolve(), retrySave.promise],
      orderErrors: ['The Album save could not reach Candidary.'],
      orderErrorCodes: ['INTERNAL_ERROR'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    const title = await screen.findByLabelText('Album title');
    fireEvent.change(title, { target: { value: 'Retry this exact draft' } });
    fireEvent.blur(title);
    await screen.findByText('The Album save could not reach Candidary.');

    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));
    const prompt = await screen.findByRole('region', {
      name: 'Album changes are not saved yet',
    });
    const retry = within(prompt).getByRole('button', { name: 'Retry' });
    await user.click(retry);

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.metadataWrites.at(-1)?.title).toBe('Retry this exact draft');
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(retry).toHaveTextContent('Retrying Album…');
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(controlled.state.orderWrites).toHaveLength(2);
    act(() => { retrySave.resolve(); });

    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('renders explicit and fallback covers, photo-only numbers, and independent failed preview tiles', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', {
      caption: 'First dance',
      isFavorite: true,
    });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', {
      isFavorite: true,
      previewAvailable: false,
    });
    const { fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 3,
        saved: true,
        entries: [
          { kind: 'section', id: 's1', heading: 'Dancing' },
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
        ],
        coverMediaId: 'p2',
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    expect(screen.getByText('People with the Album link see this. It is optional.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'The order people with the Album link will see' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a section' })).toBeVisible();
    expect(await screen.findByText('Cover · p2.jpg')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Use the first photo instead' })).toBeEnabled();
    const grid = document.querySelector('.album-review-grid');
    expect(grid).not.toBeNull();
    expect(within(grid as HTMLElement).getAllByTestId('album-photo-position').map((pill) => pill.textContent))
      .toEqual(['1', '2']);
    expect(within(grid as HTMLElement).getByRole('img', { name: 'p2.jpg, from Jose' }))
      .toHaveTextContent('Preview unavailable');
    expect(within(grid as HTMLElement).getByText('Cover')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Use the first photo instead' }));
    expect(screen.getByText(/Cover · first photo, until you star another · First dance/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'First dance is the album cover' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('moves entries with earlier/later controls and equivalent native drag/drop', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 1,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p2 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Move First dance later' }));
    expect(screen.getAllByRole('status').some((status) => (
      status.textContent?.includes('First dance moved to position 2 of 3.')
    ))).toBe(true);

    const firstDance = document.querySelector('[data-entry-key="photo:p1"]');
    const p2Card = document.querySelector('[data-entry-key="photo:p2"]');
    expect(firstDance).not.toBeNull();
    expect(p2Card).not.toBeNull();
    fireEvent.dragStart(firstDance as Element);
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    p2Card!.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    fireEvent.drop(p2Card as Element);

    expect(screen.getAllByRole('status').some((status) => (
      status.textContent?.includes('First dance moved to position 3 of 3.')
    ))).toBe(true);
    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['section:s1', 'photo:p2', 'photo:p1']);
  });

  it('keeps the invoked reorder direction focused and announces item plus position', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { state, fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 1,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    const earlier = await screen.findByRole('button', { name: 'Move p2.jpg earlier' });
    earlier.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Move p2.jpg earlier' }),
    ).toHaveFocus());
    expect(screen.getAllByRole('status').some((status) => (
      status.textContent === 'p2.jpg moved to position 1 of 2.'
    ))).toBe(true);

    const boundaryEarlier = screen.getByRole('button', { name: 'Move p2.jpg earlier' });
    expect(boundaryEarlier).toHaveAttribute('aria-disabled', 'true');
    expect(boundaryEarlier).not.toBeDisabled();
    const galleryStatus = document.querySelector<HTMLElement>('[data-gallery-live-host] [role="status"]');
    expect(galleryStatus).not.toBeNull();
    await waitFor(() => {
      expect(state.orderWrites).toHaveLength(1);
      expect(state.orderRevisions).toEqual([1]);
      expect(state.album.revision).toBe(2);
      expect(galleryStatus).toHaveTextContent('Album saved');
    });
    const savedEntriesBeforeSecondEnter = state.orderWrites.map((entries) => entries.map(writtenEntryId));
    const savedRevisionsBeforeSecondEnter = [...state.orderRevisions];
    const orderBeforeSecondEnter = Array.from(document.querySelectorAll('.album-review-grid > li'))
      .map((entry) => entry.getAttribute('data-entry-key'));
    const secondEnterAnnouncements: string[] = [];
    const observer = new MutationObserver(() => {
      const announcement = galleryStatus?.textContent?.trim() ?? '';
      if (secondEnterAnnouncements.at(-1) !== announcement) secondEnterAnnouncements.push(announcement);
    });
    observer.observe(galleryStatus!, { childList: true, characterData: true, subtree: true });

    boundaryEarlier.focus();
    await user.keyboard('{Enter}');
    await act(async () => { await new Promise((resolve) => { window.setTimeout(resolve, 650); }); });
    observer.disconnect();

    expect(secondEnterAnnouncements).toEqual([]);
    expect(state.orderWrites.map((entries) => entries.map(writtenEntryId)))
      .toEqual(savedEntriesBeforeSecondEnter);
    expect(state.orderRevisions).toEqual(savedRevisionsBeforeSecondEnter);
    expect(Array.from(document.querySelectorAll('.album-review-grid > li'))
      .map((entry) => entry.getAttribute('data-entry-key')))
      .toEqual(orderBeforeSecondEnter);
  });

  it('uses the focused Album entry as the new section insertion anchor', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const p3 = photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true });
    const { state, fetchMock } = harness({
      galleryRows: [p1, p2, p3],
      album: {
        revision: 3,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
          { kind: 'photo', photo: p3 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    const middleEntryControl = await screen.findByRole('button', { name: 'Move p2.jpg earlier' });
    middleEntryControl.focus();
    await user.click(screen.getByRole('button', { name: 'Add a section' }));

    const sectionName = screen.getByLabelText('Section name') as HTMLInputElement;
    await waitFor(() => {
      expect(sectionName).toHaveFocus();
      expect(sectionName.selectionStart).toBe(0);
      expect(sectionName.selectionEnd).toBe('New section'.length);
    });
    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')?.startsWith('section:') ? 'New section' : item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p1', 'photo:p2', 'New section', 'photo:p3']);
    expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('Section added at position 3 of 4.');
    await waitFor(() => expect(state.orderWrites).toHaveLength(1));
    expect(state.orderWrites[0]?.map(writtenEntry)).toEqual(['p1', 'p2', 'New section', 'p3']);
  });

  it('makes an inserted section the context for an immediate next section', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const p3 = photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({
      galleryRows: [p1, p2, p3],
      album: {
        revision: 3,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
          { kind: 'photo', photo: p3 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    await openAlbum();

    vi.useFakeTimers();
    screen.getByRole('button', { name: 'Move p2.jpg earlier' }).focus();
    const addSection = screen.getByRole('button', { name: 'Add a section' });
    fireEvent.click(addSection);
    const firstSectionKey = screen.getByLabelText('Section name').closest('li')
      ?.getAttribute('data-entry-key');
    fireEvent.click(addSection);
    const sectionKeys = screen.getAllByLabelText('Section name').map((input) => (
      input.closest('li')?.getAttribute('data-entry-key')
    ));

    expect(firstSectionKey).toMatch(/^section:/u);
    expect(sectionKeys).toHaveLength(2);
    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p1', 'photo:p2', sectionKeys[0], sectionKeys[1], 'photo:p3']);
    expect(sectionKeys[0]).toBe(firstSectionKey);
  });

  it('appends a new section when no Album entry has received focus', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { state, fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 2,
        saved: true,
        entries: [{ kind: 'photo', photo: p1 }, { kind: 'photo', photo: p2 }],
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Add a section' }));

    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')?.startsWith('section:') ? 'New section' : item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p1', 'photo:p2', 'New section']);
    expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('Section added at the end, position 3 of 3.');
    await waitFor(() => expect(state.orderWrites).toHaveLength(1));
    expect(state.orderWrites[0]?.map(writtenEntry)).toEqual(['p1', 'p2', 'New section']);
  });

  it('uses the surviving removal fallback as the next section insertion anchor', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { state, fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 2,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 'stale', heading: 'Remove me' },
          { kind: 'photo', photo: p2 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    const staleSection = await screen.findByDisplayValue('Remove me');
    staleSection.focus();
    await user.click(screen.getByRole('button', { name: 'Remove section Remove me' }));
    await user.click(screen.getByRole('button', { name: 'Add a section' }));

    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')?.startsWith('section:') ? 'New section' : item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p1', 'photo:p2', 'New section']);
    expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('Section added at position 3 of 3.');
    await waitFor(() => expect(state.orderWrites).toHaveLength(2));
    expect(state.orderWrites[1]?.map(writtenEntry)).toEqual(['p1', 'p2', 'New section']);
  });

  it('flags every empty section while only live photos make a section nonempty', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const slot = retainedSlot('p9', '2099-09-19T04:00:00.000Z');
    const { fetchMock } = harness({
      galleryRows: [p1, p2],
      trashed: { p9: slot },
      album: {
        revision: 4,
        saved: true,
        entries: [
          { kind: 'section', id: 'leading-empty', heading: 'Leading empty' },
          { kind: 'section', id: 'filled-one', heading: 'Filled one' },
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 'middle-empty', heading: 'Middle empty' },
          { kind: 'section', id: 'filled-two', heading: 'Filled two' },
          { kind: 'photo', photo: p2 },
          { kind: 'section', id: 'retained-only', heading: 'Retained only' },
          { kind: 'photo-retained', slot },
          { kind: 'section', id: 'trailing-empty', heading: 'Trailing empty' },
        ],
      },
    });
    renderWorkspace(fetchMock);
    await openAlbum();

    const emptyNote = 'Empty section—omitted from the Album link';
    for (const heading of ['Leading empty', 'Middle empty', 'Retained only', 'Trailing empty']) {
      const input = await screen.findByDisplayValue(heading);
      expect(input).toBeEnabled();
      expect(input).not.toHaveAttribute('readonly');
      expect(within(input.closest('li')!).getByText(emptyNote)).toBeVisible();
    }
    for (const heading of ['Filled one', 'Filled two']) {
      const input = screen.getByDisplayValue(heading);
      expect(within(input.closest('li')!).queryByText(emptyNote)).not.toBeInTheDocument();
    }
  });

  it('trims section names and keeps section removal undoable for nine seconds while focus is inside', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const { state, fetchMock } = harness({
      galleryRows: [p1],
      album: {
        revision: 2,
        saved: true,
        entries: [
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p1 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    await openAlbum();

    const sectionName = await screen.findByLabelText('Section name');
    vi.useFakeTimers();
    fireEvent.change(sectionName, { target: { value: '  Speeches  ' } });
    fireEvent.blur(sectionName);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(state.orderWrites.at(-1)?.[0]).toMatchObject({ kind: 'section', heading: 'Speeches' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove section Speeches' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const undoButton = screen.getByRole('button', { name: 'Undo' });
    expect(screen.getAllByText('Section removed.')
      .some((node) => node.classList.contains('album-undo__message'))).toBe(true);
    undoButton.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(undoButton).toBeVisible();

    await act(async () => {
      fireEvent.click(undoButton);
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue('Speeches')).toBeVisible();
    vi.useRealTimers();
  });

  it('queues section renames while the field stays focused and reports the pending save', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const { state, fetchMock } = harness({
      galleryRows: [p1],
      album: {
        revision: 2,
        saved: true,
        entries: [
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p1 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    await openAlbum();
    const sectionName = await screen.findByLabelText('Section name');
    vi.useFakeTimers();
    sectionName.focus();
    fireEvent.change(sectionName, { target: { value: 'Speeches' } });
    expect(sectionName).toHaveFocus();
    expect(screen.getByText('Saving…')).toBeVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(state.orderWrites.at(-1)?.[0]).toMatchObject({
      kind: 'section',
      heading: 'Speeches',
    });
    expect(sectionName).toHaveFocus();
  });

  it('uses the derived saving state in the visible chip during membership work', async () => {
    const removal = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({
      galleryRows: [p1],
      album: {
        revision: 2,
        saved: true,
        entries: [{ kind: 'photo', photo: p1 }],
      },
      pickGates: [removal.promise],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    expect(screen.getByText('Saving…')).toBeVisible();
    removal.resolve();
    await waitFor(() => expect(screen.getByText('Saved')).toBeVisible());
  });

  it('retains a visible focus indicator for section-name inputs', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    expect(styles).toMatch(/\.album-section__input:focus-visible\s*\{[^}]*outline:/u);
  });

  it('resets to timeline order without sections and restores the whole draft with Undo', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({
      galleryRows: [p2, p1],
      album: {
        revision: 5,
        saved: true,
        title: 'The evening',
        description: 'In our order.',
        entries: [
          { kind: 'photo', photo: p2 },
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p1 },
        ],
        coverMediaId: 'p2',
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Reset to timeline order' }));
    expect(screen.queryByLabelText('Section name')).not.toBeInTheDocument();
    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p1', 'photo:p2']);
    expect(screen.getAllByText('Album order reset to the timeline. Sections were removed.')
      .some((node) => node.classList.contains('album-undo__message'))).toBe(true);
    expect(screen.getByText('Cover · p2.jpg')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByDisplayValue('Reception')).toBeVisible();
    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p2', 'section:s1', 'photo:p1']);
    expect(screen.getByLabelText('Album title')).toHaveValue('The evening');
    expect(screen.getByLabelText('Description')).toHaveValue('In our order.');
    expect(screen.getByText('Cover · p2.jpg')).toBeVisible();
  });

  it('orders live and retained slots together during reconciliation-era Reset with truthful copy', async () => {
    const first = photo('first', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const last = photo('last', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const slot = retainedSlot(
      'retained',
      '2026-09-15T00:00:00.000Z',
      'recoverable',
      '2026-08-15T22:55:00.000Z',
    );
    const { fetchMock } = harness({
      galleryRows: [last, first],
      trashed: { retained: slot },
      album: {
        revision: 5,
        saved: true,
        entries: [
          { kind: 'photo', photo: last },
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo-retained', slot },
          { kind: 'photo', photo: first },
        ],
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Reset to timeline order' }));

    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['photo:first', 'photo:retained', 'photo:last']);
    expect(screen.getAllByText('Album order reset to the timeline. Sections were removed.')
      .some((node) => node.classList.contains('album-undo__message'))).toBe(true);
    expect(document.querySelector('.album-undo__message')).not.toHaveTextContent(/moved to the end/iu);
  });

  it('keeps a removed cover photo undoable with its original position and explicit cover', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 2,
        saved: true,
        entries: [{ kind: 'photo', photo: p1 }, { kind: 'photo', photo: p2 }],
        coverMediaId: 'p2',
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Remove p2.jpg from Album' }));
    expect((await screen.findAllByText('1 photo removed from Album. The delivered photo remains.'))
      .some((node) => node.classList.contains('album-undo__message'))).toBe(true);
    expect(screen.getByText(/Cover · first photo, until you star another · p1.jpg/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Remove p2.jpg from Album' })).toBeEnabled();
    expect(screen.getByText('Cover · p2.jpg')).toBeVisible();
    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p1', 'photo:p2']);
  });

  it('retires a photo inverse before a newer cover draft can replay its stale snapshot', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const p3 = photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true });
    const { state, fetchMock } = harness({
      galleryRows: [p1, p2, p3],
      album: {
        revision: 2,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
          { kind: 'photo', photo: p3 },
        ],
        coverMediaId: 'p2',
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Remove p2.jpg from Album' }));
    await screen.findByRole('button', { name: 'Undo' });
    await user.click(screen.getByRole('button', { name: 'Use p3.jpg as the album cover' }));
    await user.click(screen.getByRole('button', { name: 'Use the first photo instead' }));

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    await waitFor(() => expect(state.metadataWrites.at(-1)?.coverMediaId).toBeNull());
    expect(state.pickWrites).toEqual([{ mediaIds: ['p2'], picked: false }]);
    expect(screen.queryByRole('button', { name: 'Remove p2.jpg from Album' })).not.toBeInTheDocument();
    expect(screen.getByText(/Cover · first photo, until you star another · p1.jpg/)).toBeVisible();
  });

  it('previews the recipient projection the server returns, without touching sharing', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true, previewAvailable: false });
    const { state, fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 2,
        saved: true,
        title: 'The evening',
        description: 'The photographs we kept together.',
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p2 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Preview album' }));
    expect(await screen.findByText('What people with the Album link see')).toBeVisible();
    const preview = screen.getByRole('region', { name: 'What people with the Album link see' });
    expect(within(preview).getByRole('heading', { name: 'The evening' })).toBeVisible();
    expect(within(preview).getByText('The photographs we kept together.')).toBeVisible();
    expect(within(preview).getByRole('heading', { name: 'Reception' })).toBeVisible();
    expect(within(preview).getByRole('img', { name: 'Album photo 2' })).toHaveTextContent('Preview unavailable');
    // The recipient's view is the server's answer, not the editor's draft: an
    // unpublished caption, the contributor, and the uploader's filename all stop here.
    expect(within(preview).queryByText('First dance')).not.toBeInTheDocument();
    expect(within(preview).queryByText(/Jose/)).not.toBeInTheDocument();
    expect(within(preview).queryByText(/\.jpg/)).not.toBeInTheDocument();
    // Preview is Manager-authenticated. It is not sharing, and it created nothing.
    expect(state.previewReads).toBe(1);
    expect(state.shareWrites).toEqual([]);
    expect(screen.queryByLabelText('Album title')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to editing' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Back to editing' }));
    expect(await screen.findByLabelText('Album title')).toHaveValue('The evening');
  });

  it('opens an Album link confirmation with draft counts and sends nothing until explicit confirmation', async () => {
    const published = photo('p1', '2026-08-15T22:42:00.000Z', {
      caption: 'Published caption',
      isFavorite: true,
      publicationStatus: 'published',
    });
    const whitespace = photo('p2', '2026-08-15T23:18:00.000Z', {
      caption: '   ',
      isFavorite: true,
      publicationStatus: 'published',
    });
    const unpublished = photo('p3', '2026-08-16T04:48:00.000Z', {
      caption: 'Not public',
      isFavorite: true,
      publicationStatus: 'unpublished',
    });
    const { state, fetchMock } = harness({
      galleryRows: [published, whitespace, unpublished],
      album: {
        revision: 3,
        saved: true,
        entries: [
          { kind: 'photo', photo: published },
          { kind: 'section', id: 's1', heading: 'Dinner' },
          { kind: 'photo', photo: whitespace },
          { kind: 'photo', photo: unpublished },
        ],
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    const invoking = await screen.findByRole('button', { name: 'Create Album link' });

    await user.click(invoking);

    const dialog = await screen.findByRole('dialog', { name: 'Create the Album link?' });
    expect(state.shareWrites).toEqual([]);
    expect(state.orderWrites).toEqual([]);
    expect(within(dialog).getByText(
      'This link will show 3 photos and 1 published caption to people with the Album link.',
    )).toBeVisible();
    expect(within(dialog).getByText(
      'The Album link is a live view. Later saved changes to Album membership, metadata, sections, and order affect what people see when they request it.',
    )).toBeVisible();
    expect(within(dialog).getByText(
      'The Guest gallery is separate. Creating this link does not publish photos there or change what event guests can see.',
    )).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Create Album link' })).toHaveAttribute('type', 'button');
    expect(within(dialog).getByRole('button', { name: 'Create Album link' }).closest('form')).toBeNull();
  });

  it.each([
    ['Escape', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
    ['Cancel', async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(within(screen.getByRole('dialog', { name: 'Create the Album link?' }))
        .getByRole('button', { name: 'Cancel' }));
    }],
    ['backdrop', async () => {
      const dialog = screen.getByRole('dialog', { name: 'Create the Album link?' });
      fireEvent.mouseDown(dialog.parentElement!);
    }],
  ])('cancels Album link creation with %s without a request and restores the invoker', async (_route, cancel) => {
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    const invoking = await screen.findByRole('button', { name: 'Create Album link' });
    await user.click(invoking);
    await screen.findByRole('dialog', { name: 'Create the Album link?' });

    await cancel(user);

    expect(screen.queryByRole('dialog', { name: 'Create the Album link?' })).not.toBeInTheDocument();
    expect(state.shareWrites).toEqual([]);
    expect(state.orderWrites).toEqual([]);
    expect(invoking).toHaveFocus();
  });

  it('creates one sensitive Album link after draft settlement and focuses its Copy action', async () => {
    const save = deferred();
    const create = deferred();
    const url = 'https://candidary.test/album#share-id.share-secret';
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      orderGates: [save.promise],
      shareGates: [create.promise],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Ready to share' } });
    await user.click(screen.getByRole('button', { name: 'Create Album link' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create the Album link?' });
    const confirm = within(dialog).getByRole('button', { name: 'Create Album link' });

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(state.metadataWrites.at(-1)?.title).toBe('Ready to share');
    expect(state.shareWrites).toEqual([]);
    await act(async () => { save.resolve(); });
    await waitFor(() => expect(state.shareWrites).toEqual(['share']));
    await user.keyboard('{Escape}');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.mouseDown(dialog.parentElement!);
    expect(dialog).toBeVisible();
    expect(state.shareWrites).toEqual(['share']);
    fireEvent.click(confirm);
    expect(state.shareWrites).toEqual(['share']);
    await act(async () => { create.resolve(); });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create the Album link?' })).not.toBeInTheDocument());
    const copy = screen.getByRole('button', { name: 'Copy Album link' });
    expect(copy).toHaveFocus();
    expect(screen.getByText('Album link')).toBeVisible();
    expect(screen.getByText('••••••••••••')).toBeVisible();
    expect(screen.queryByText(url)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(url)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(url);
    expect(document.querySelector('[data-gallery-live-host] [role="status"]')).toHaveTextContent('Album link is Live.');
    expect(state.audienceReads).toBeGreaterThan(1);
  });

  it('keeps an Album link request failure scoped and focused, then allows retry and cancellation', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      shareErrors: ['The Album link could not be created.', undefined],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    const createAction = await screen.findByRole('button', { name: 'Create Album link' });
    await user.click(createAction);
    let dialog = await screen.findByRole('dialog', { name: 'Create the Album link?' });

    await user.click(within(dialog).getByRole('button', { name: 'Create Album link' }));

    const error = await within(dialog).findByRole('alert');
    expect(error).toHaveTextContent('The Album link could not be created.');
    expect(error).toHaveFocus();
    expect(within(dialog).getAllByRole('alert')).toHaveLength(1);
    expect(document.querySelector('.manager-action-error')).toBeNull();
    expect(state.share).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Create the Album link?' })).not.toBeInTheDocument();
    expect(createAction).toHaveFocus();
    expect(state.shareWrites).toEqual(['share']);

    await user.click(createAction);
    dialog = await screen.findByRole('dialog', { name: 'Create the Album link?' });
    await user.click(within(dialog).getByRole('button', { name: 'Create Album link' }));
    await waitFor(() => expect(state.shareWrites).toEqual(['share', 'share']));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create the Album link?' })).not.toBeInTheDocument());
  });

  it('closes the Album link dialog before focusing existing draft recovery', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      orderErrors: ['The album could not be saved.'],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Unsaved' } });
    await user.click(screen.getByRole('button', { name: 'Create Album link' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create the Album link?' });

    await user.click(within(dialog).getByRole('button', { name: 'Create Album link' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create the Album link?' })).not.toBeInTheDocument());
    expect(state.shareWrites).toEqual([]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry album' })).toHaveFocus());
    expect(document.querySelector('[data-album-confirm-host]')).not.toBeInTheDocument();
  });

  it('adopts a late active Album link during confirmed settlement without posting or stealing Copy focus', async () => {
    const initialRead = deferred();
    const save = deferred();
    const activeShare = {
      active: true as const,
      url: 'https://candidary.test/album#existing-id.existing-secret',
      sharedAt: '2026-08-23T12:00:00.000Z',
    };
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      share: activeShare,
      shareReadGates: [initialRead.promise],
      orderGates: [save.promise],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Settling draft' } });
    await user.click(await screen.findByRole('button', { name: 'Create Album link' }));
    const dialog = screen.getByRole('dialog', { name: 'Create the Album link?' });
    await user.click(within(dialog).getByRole('button', { name: 'Create Album link' }));
    expect(state.metadataWrites.at(-1)?.title).toBe('Settling draft');
    expect(state.shareWrites).toEqual([]);

    await act(async () => { initialRead.resolve(); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create the Album link?' })).not.toBeInTheDocument());
    await act(async () => { save.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(state.shareWrites).toEqual([]);
    expect(screen.getByRole('button', { name: 'Stop Album link' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Copy Album link' })).not.toHaveFocus();
    expect(screen.queryByText(activeShare.url)).not.toBeInTheDocument();
  });

  it('creates, copies, and stops the Album link without changing Guest-gallery publication', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    installClipboard(writeText);

    await user.click(await screen.findByRole('button', { name: 'Create Album link' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Create the Album link?' }))
      .getByRole('button', { name: 'Create Album link' }));
    expect(await screen.findByText(/People with the Album link can see the saved Album/u)).toBeVisible();
    expect(state.shareWrites).toEqual(['share']);
    expect(screen.queryByText('https://candidary.test/album#share-id.share-secret')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy Album link' }));
    await act(async () => { await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith('https://candidary.test/album#share-id.share-secret');
    expect(screen.getByText('Copied')).toHaveAttribute('role', 'status');

    await user.click(screen.getByRole('button', { name: 'Stop Album link' }));
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Stop the Album link?' }))
      .getByRole('button', { name: 'Stop Album link' }));
    await waitFor(() => expect(state.shareWrites).toEqual(['share', 'stop']));
    expect(screen.queryByText('https://candidary.test/album#share-id.share-secret')).not.toBeInTheDocument();
    expect(state.galleryRows[0]?.publicationStatus).toBe('unpublished');
  });

  it('waits for the newest complete draft before creating a share credential', async () => {
    const save = deferred();
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      orderGates: [save.promise],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Ready to share' } });
    await user.click(screen.getByRole('button', { name: 'Create Album link' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Create the Album link?' }))
      .getByRole('button', { name: 'Create Album link' }));
    expect(state.metadataWrites.at(-1)?.title).toBe('Ready to share');
    expect(state.shareWrites).toEqual([]);

    await act(async () => { save.resolve(); });
    await waitFor(() => expect(state.shareWrites).toEqual(['share']));
  });

  it('flushes the latest draft before preview and before leaving Album', async () => {
    const save = deferred();
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      orderGates: [save.promise],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Latest draft' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    expect(state.metadataWrites.at(-1)?.title).toBe('Latest draft');
    expect(screen.queryByText('What people with the Album link see')).not.toBeInTheDocument();
    await act(async () => { save.resolve(); });
    expect(await screen.findByText('What people with the Album link see')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Back to editing' }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Still saving.' } });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));
    await waitFor(() => expect(state.metadataWrites.at(-1)?.description).toBe('Still saving.'));
    expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('reloads and keeps Album active when a flushed draft loses the revision race', async () => {
    const { fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      album: { revision: 9, saved: true, entries: [], title: 'Canonical', description: '' },
      orderErrors: ['This album changed while you were arranging it. Reopen Album to see the current order.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing draft' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This album changed while you were arranging it.');
    expect(screen.getByLabelText('Album title')).toHaveValue('Canonical');
    expect(screen.queryByText('What people with the Album link see')).not.toBeInTheDocument();
  });

  it('keeps Album active and focuses recovery when a flushed save and its canonical reload fail', async () => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      orderErrors: ['That album changed before this draft was saved.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    const recoveryRead = controlled.state.albumReads;
    controlled.state.albumReadErrors[recoveryRead] = 'The canonical album could not be reloaded.';
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Unsaved title' } });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));

    const prompt = await screen.findByRole('region', {
      name: 'Album changes are not saved yet',
    });
    expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ })).toHaveAttribute('aria-pressed', 'true');
    expect(prompt).toHaveFocus();
    const readsBeforeRetry = controlled.state.albumReads;
    await user.click(within(prompt).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(controlled.state.albumReads).toBeGreaterThan(readsBeforeRetry));
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('navigates an empty album back to Library', async () => {
    const { fetchMock } = harness();
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    expect(await screen.findByRole('heading', { name: 'The Album is empty.' })).toBeVisible();
    expect(screen.getByText('Pick photos in Library. Each pick makes a photo In Album for every host on this event. It does not publish to the Guest gallery.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Go to Library' }));
    expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('starts an album-only export with the exact kind selector and disables an empty album', async () => {
    const pickedHarness = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    const onPrepare = vi.fn(noop);
    renderWorkspace(pickedHarness.fetchMock, { onPrepare });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await user.click(await screen.findByRole('button', { name: 'Download album photos' }));
    expect(onPrepare).toHaveBeenCalledOnce();
    expect(onPrepare).toHaveBeenCalledWith('album');

    cleanup();
    const emptyHarness = harness();
    renderWorkspace(emptyHarness.fetchMock);
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));
    expect(await screen.findByRole('button', { name: 'Download album photos' })).toBeDisabled();
  });

  it('uses the audience summary rather than loaded Album rows to guard an empty export', async () => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      audienceSummary: {
        albumPhotoCount: 0,
        albumEntryCount: 0,
        albumLink: { active: false, sharedAt: null },
        guestGalleryVisible: true,
        guestGalleryPublishedCount: 0,
      },
    });
    const onPrepare = vi.fn(noop);
    renderWorkspace(controlled.fetchMock, { onPrepare });
    const user = await openAlbum();

    expect(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' })).toBeVisible();
    const prepare = screen.getByRole('button', { name: 'Download album photos' });
    expect(prepare.closest('.album-export')).toHaveTextContent('Current Album: 0 photos.');
    expect(prepare).toBeDisabled();
    expect(screen.getByText('Add a photo to the Album before preparing it.')).toBeVisible();
    await user.click(prepare);
    expect(onPrepare).not.toHaveBeenCalled();
  });

  it('drains the current and coalesced successor order saves before creating an album export', async () => {
    const firstSave = deferred();
    const successorSave = deferred();
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
        photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true }),
      ],
      orderGates: [firstSave.promise, successorSave.promise],
    });
    const onPrepare = vi.fn(noop);
    renderWorkspace(controlled.fetchMock, { onPrepare });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await user.click(await screen.findByRole('button', { name: /^Move First dance later/ }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /^Move First dance later/ }));
    await user.click(screen.getByRole('button', { name: 'Download album photos' }));
    expect(onPrepare).not.toHaveBeenCalled();

    await act(async () => { firstSave.resolve(); });
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(onPrepare).not.toHaveBeenCalled();

    await act(async () => { successorSave.resolve(); });
    await waitFor(() => expect(onPrepare).toHaveBeenCalledWith('album'));
    expect(controlled.state.orderWrites[1]?.map(writtenEntryId)).toEqual(['p2', 'p3', 'p1']);
  });

  it('keeps export preparation behind the canonical reload after an order save fails', async () => {
    const save = deferred();
    const reload = deferred();
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
      orderGates: [save.promise],
      orderErrors: ['That album changed before this order was saved.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    const onPrepare = vi.fn(noop);
    renderWorkspace(controlled.fetchMock, { onPrepare });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await screen.findByRole('button', { name: /^Move First dance later/ });
    const recoveryRead = controlled.state.albumReads;
    controlled.state.albumReadGates[recoveryRead] = reload.promise;
    await user.click(screen.getByRole('button', { name: /^Move First dance later/ }));
    await user.click(screen.getByRole('button', { name: 'Download album photos' }));
    await act(async () => { save.resolve(); });
    await waitFor(() => expect(controlled.state.albumReads).toBe(recoveryRead + 1));

    const prepare = screen.getByRole('button', { name: 'Preparing album download…' });
    expect(prepare).toBeDisabled();
    await user.click(prepare);
    expect(onPrepare).not.toHaveBeenCalled();

    await act(async () => { reload.resolve(); });
    await waitFor(() => expect(prepare).toBeEnabled());
    expect(onPrepare).not.toHaveBeenCalled();
    await user.click(prepare);
    expect(onPrepare).toHaveBeenCalledOnce();
  });

  it('does not prepare from an untrusted order when canonical reload fails and retries the reload', async () => {
    const save = deferred();
    const failedReload = deferred();
    const retryReload = deferred();
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
      orderGates: [save.promise],
      orderErrors: ['That album changed before this order was saved.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    const onPrepare = vi.fn(noop);
    renderWorkspace(controlled.fetchMock, { onPrepare });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await screen.findByRole('button', { name: /^Move First dance later/ });
    const recoveryRead = controlled.state.albumReads;
    controlled.state.albumReadGates[recoveryRead] = failedReload.promise;
    controlled.state.albumReadErrors[recoveryRead] = 'The canonical album could not be reloaded.';
    controlled.state.albumReadGates[recoveryRead + 1] = retryReload.promise;
    await user.click(screen.getByRole('button', { name: /^Move First dance later/ }));
    await user.click(screen.getByRole('button', { name: 'Download album photos' }));
    await act(async () => { save.resolve(); });
    await waitFor(() => expect(controlled.state.albumReads).toBe(recoveryRead + 1));
    expect(screen.getByRole('button', { name: 'Preparing album download…' })).toBeDisabled();
    expect(onPrepare).not.toHaveBeenCalled();
    await act(async () => { failedReload.resolve(); });

    expect(await screen.findByText('The canonical album could not be reloaded.')).toBeVisible();
    expect(onPrepare).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(recoveryRead + 2));
    expect(onPrepare).not.toHaveBeenCalled();

    await act(async () => { retryReload.resolve(); });
    await screen.findByRole('button', { name: 'Download album photos' });
    await user.click(screen.getByRole('button', { name: 'Download album photos' }));
    expect(onPrepare).toHaveBeenCalledOnce();
  });

  it('disables complete prepare and retry for an active album while keeping ready downloads usable', async () => {
    const activeAlbum: ExportView = {
      id: 'album-active', kind: 'album', state: 'running', attempt: 1,
      snapshotAt: '2026-08-23T12:00:00.000Z', mediaCount: 1, totalBytes: 64,
      createdAt: '2026-08-23T12:00:01.000Z', startedAt: '2026-08-23T12:00:02.000Z',
      completedAt: null, processedMediaCount: 0, processedBytes: 0,
      progressUpdatedAt: '2026-08-23T12:00:02.000Z', errorCode: null,
      partCount: 0, expiresAt: null, guestbookEntryCount: null, guestbookSharedCount: null,
      guestbookEventName: null, guestbookEventDate: null, guestbookEventTimezone: null,
      guestbookPrompt: null, guestbookGalleryVisible: null,
    };
    const completeJob = (state: 'failed' | 'ready'): ExportView => ({
      id: `complete-${state}`, kind: 'complete', state, attempt: 1,
      snapshotAt: '2026-08-22T12:00:00.000Z', mediaCount: 2, totalBytes: 128,
      createdAt: '2026-08-22T12:00:01.000Z', startedAt: '2026-08-22T12:00:02.000Z',
      completedAt: '2026-08-22T12:00:03.000Z', processedMediaCount: 2,
      processedBytes: 128, progressUpdatedAt: '2026-08-22T12:00:02.500Z',
      errorCode: state === 'failed' ? 'EXPORT_FAILED' : null,
      partCount: state === 'ready' ? 1 : 0,
      expiresAt: state === 'ready' ? '2026-08-24T12:00:00.000Z' : null,
      guestbookEntryCount: 0, guestbookSharedCount: 0, guestbookEventName: 'Maya & Theo',
      guestbookEventDate: '2026-09-19', guestbookEventTimezone: 'America/Chicago',
      guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT, guestbookGalleryVisible: true,
    });

    renderWorkspace(harness().fetchMock, { activeJob: activeAlbum });
    expect(await screen.findByRole('button', { name: 'Download all' })).toBeDisabled();

    cleanup();
    renderWorkspace(harness().fetchMock, { job: completeJob('failed'), activeJob: activeAlbum });
    expect(await screen.findByRole('button', { name: 'Retry this prepared export' })).toBeDisabled();
    expect(screen.getByText('Album export is Running. Prepare and retry actions will be available when it finishes.'))
      .toBeVisible();

    cleanup();
    renderWorkspace(harness().fetchMock, { job: completeJob('ready'), activeJob: activeAlbum });
    expect(await screen.findByRole('button', { name: 'Get download links' })).toBeEnabled();
  });

  it('renders ordered album part links and never offers Guestbook artifacts', async () => {
    const pickedHarness = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    const albumJob: ExportView = {
      id: 'album-export', kind: 'album', state: 'ready',
      snapshotAt: '2026-08-23T12:00:00.000Z', mediaCount: 2, totalBytes: 128,
      createdAt: '2026-08-23T12:00:01.000Z', startedAt: '2026-08-23T12:00:02.000Z',
      completedAt: '2026-08-23T12:00:03.000Z', processedMediaCount: 2,
      processedBytes: 128, progressUpdatedAt: '2026-08-23T12:00:02.500Z', errorCode: null,
      attempt: 1, partCount: 2, expiresAt: '2026-08-24T12:00:00.000Z',
      guestbookEntryCount: null, guestbookSharedCount: null, guestbookEventName: null,
      guestbookEventDate: null, guestbookEventTimezone: null, guestbookPrompt: null,
      guestbookGalleryVisible: null,
    };
    const albumDownload: ExportDownloadView = {
      manifest: { url: '/manifest', expiresAt: albumJob.expiresAt!, filename: 'manifest.csv' },
      parts: [
        { partNumber: 1, mediaCount: 1, sourceBytes: 64, url: '/part-1', expiresAt: albumJob.expiresAt!, filename: 'part-1.zip' },
        { partNumber: 2, mediaCount: 1, sourceBytes: 64, url: '/part-2', expiresAt: albumJob.expiresAt!, filename: 'part-2.zip' },
      ],
      printableGuestbook: { url: '/must-not-render.html', expiresAt: albumJob.expiresAt!, filename: 'guestbook.html' },
      privateGuestbook: { url: '/must-not-render.csv', expiresAt: albumJob.expiresAt!, filename: 'guestbook.csv' },
    };
    renderWorkspace(pickedHarness.fetchMock, { albumJob, albumDownload });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    expect(await screen.findByRole('link', { name: /Photo part 1 of 2/ })).toHaveAttribute('href', '/part-1');
    expect(screen.getByRole('link', { name: /Photo part 2 of 2/ })).toHaveAttribute('href', '/part-2');
    expect(screen.getByRole('link', { name: 'Photo manifest' })).toHaveAttribute('href', '/manifest');
    expect(screen.queryByRole('link', { name: /guestbook/i })).not.toBeInTheDocument();
  });

  it('asks once before adopting historical picks', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      album: { revision: 0, saved: false, entries: [] },
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    expect(await screen.findByRole('heading', { name: '1 existing pick from before this update.' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Start the Album from it' }));
    await waitFor(() => expect(state.startWrites).toEqual(['from-picks']));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '1 existing pick from before this update.' })).not.toBeInTheDocument());
  });

  it('adopts a co-host reconciliation loser without false success or an invalid Undo', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const { state, fetchMock } = harness({
      galleryRows: [p1],
      album: { revision: 0, saved: false, entries: [] },
      startResults: [{
        started: false,
        album: { revision: 0, saved: true, entries: [{ kind: 'photo', photo: p1 }] },
      }],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Start empty' }));

    expect(await screen.findByText('The Album was already started. The current version is open now.'))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryByText('The Album starts empty. The Album picks were cleared.')).not.toBeInTheDocument();
    expect(state.pickWrites).toEqual([]);
  });

  it('reorders with buttons and saves the arrangement it is showing', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await screen.findByRole('button', { name: /^Move First dance later/ });
    await user.click(screen.getByRole('button', { name: /^Move First dance later/ }));

    await waitFor(() => expect(state.orderWrites.at(-1)?.map(writtenEntryId)).toEqual(['p2', 'p1']));
  });

  it('adds a host-authored section rather than guessing one', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await user.click(await screen.findByRole('button', { name: 'Add a section' }));
    await waitFor(() => expect(state.orderWrites.at(-1)?.some((entry) => entry.kind === 'section')).toBe(true));
    expect(screen.getByLabelText('Section name')).toHaveValue('New section');
  });

  it('names the delivered original when a photo leaves the album', async () => {
    const { fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true })],
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await user.click(await screen.findByRole('button', { name: 'Remove First dance from Album' }));
    expect((await screen.findAllByText('1 photo removed from Album. The delivered photo remains.'))
      .some((node) => node.classList.contains('album-undo__message'))).toBe(true);
  });

  it('adopts the authoritative audience count after a photo leaves the album', async () => {
    const { fetchMock } = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
      bytesById: { p1: 1024, p2: 2048 },
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));
    const exportControl = (await screen.findByRole('button', { name: 'Download album photos' }))
      .closest('.album-export');
    expect(exportControl).toHaveTextContent('Current Album: 2 photos.');

    await user.click(screen.getByRole('button', { name: 'Remove p2.jpg from Album' }));

    await waitFor(() => expect(exportControl).toHaveTextContent('Current Album: 1 photo.'));
  });

  it('keeps successful removal undoable when the authoritative refresh fails', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await screen.findByRole('button', { name: 'Remove p1.jpg from Album' });
    state.albumReadErrors[state.albumReads] = 'The updated album could not be refreshed.';
    await user.click(screen.getByRole('button', { name: 'Remove p1.jpg from Album' }));

    expect(state.pickWrites).toEqual([{ mediaIds: ['p1'], picked: false }]);
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeEnabled();
    const refreshAlert = await screen.findByRole('alert');
    expect(refreshAlert).toHaveTextContent('removed');
    expect(refreshAlert).toHaveTextContent('could not be refreshed');
    expect(refreshAlert).not.toHaveTextContent('could not be removed');
  });

  it('keeps export count on the audience summary while Album reload adopts a concurrent repick', async () => {
    const refresh = deferred();
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
      bytesById: { p1: 1024, p2: 2048 },
    });
    renderWorkspace(controlled.fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await screen.findByRole('button', { name: 'Remove p2.jpg from Album' });
    const authoritativeRead = controlled.state.albumReads;
    controlled.state.albumReadGates[authoritativeRead] = refresh.promise;
    await user.click(screen.getByRole('button', { name: 'Remove p2.jpg from Album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(authoritativeRead + 1));
    controlled.state.galleryRows.find(({ id }) => id === 'p2')!.isFavorite = true;
    await act(async () => { refresh.resolve(); });

    expect(await screen.findByRole('button', { name: 'Remove p2.jpg from Album' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Download album photos' }).closest('.album-export'))
      .toHaveTextContent('Current Album: 1 photo.');
  });

  it('reconciles a committed removal while export count remains summary-authoritative', async () => {
    const firstSave = deferred();
    const successorSave = deferred();
    const refresh = deferred();
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
        photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true }),
      ],
      bytesById: { p1: 1024, p2: 2048, p3: 3072 },
      orderGates: [firstSave.promise, successorSave.promise],
    });
    const rendered = renderWorkspace(controlled.fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await user.click(await screen.findByRole('button', { name: /^Move First dance later/ }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /^Move First dance later/ }));

    const authoritativeRead = controlled.state.albumReads;
    controlled.state.albumReadGates[authoritativeRead] = refresh.promise;
    controlled.state.albumReadGates[authoritativeRead + 1] = refresh.promise;
    await user.click(screen.getByRole('button', { name: 'Remove p2.jpg from Album' }));
    await waitFor(() => expect(controlled.state.pickWrites).toEqual([
      { mediaIds: ['p2'], picked: false },
    ]));
    expect(controlled.state.albumReads).toBe(authoritativeRead);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();

    // Another manager repicks p2 while both older order writes are unresolved.
    controlled.state.galleryRows.find(({ id }) => id === 'p2')!.isFavorite = true;
    await act(async () => { firstSave.resolve(); });
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.albumReads).toBe(authoritativeRead);

    await act(async () => { successorSave.resolve(); });
    await waitFor(() => expect(controlled.state.albumReads).toBeGreaterThanOrEqual(authoritativeRead + 2));
    controlled.state.album.revision = 41;
    await act(async () => { refresh.resolve(); });

    expect(await screen.findByRole('button', { name: 'Remove p2.jpg from Album' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Download album photos' }).closest('.album-export'))
      .toHaveTextContent('Current Album: 2 photos.');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(rendered.invalidateGalleryAfterMutation).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^Move First dance earlier/ }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(3));
    expect(controlled.state.orderRevisions[2]).toBe(41);
  });

  it('explains an empty album without promising publication', async () => {
    const { fetchMock } = harness({ galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z')] });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    expect(await screen.findByRole('heading', { name: 'The Album is empty.' })).toBeVisible();
    expect(screen.getByText('Pick photos in Library. Each pick makes a photo In Album for every host on this event. It does not publish to the Guest gallery.')).toBeVisible();
  });
});

describe('album review regressions', () => {
  it('revokes an active share immediately even when the empty draft is invalid', async () => {
    const activeShare = {
      active: true as const,
      url: 'https://candidary.test/album#active.share',
      sharedAt: '2026-08-23T12:00:00.000Z',
    };
    const { state, fetchMock } = harness({ share: activeShare });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    await user.clear(await screen.findByLabelText('Album title'));

    await user.click(screen.getByRole('button', { name: 'Stop Album link' }));
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Stop the Album link?' }))
      .getByRole('button', { name: 'Stop Album link' }));

    await waitFor(() => expect(state.shareWrites).toEqual(['stop']));
    expect(state.orderWrites).toHaveLength(0);
  });

  it('adopts the complete final save response after a coalesced edit, including live membership', async () => {
    const firstSave = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z');
    const controlled = harness({ galleryRows: [p1, p2], orderGates: [firstSave.promise] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Visible title' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Newest intent' } });
    controlled.state.galleryRows[1]!.isFavorite = true;
    await act(async () => { firstSave.resolve(); });

    expect(await screen.findByText('What people with the Album link see')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Back to editing' }));
    expect(await screen.findByRole('button', { name: 'Remove p2.jpg from Album' })).toBeEnabled();
    expect(screen.getByLabelText('Description')).toHaveValue('Newest intent');
  });

  it('composes removal against the latest draft and never lets its refresh cancel newer intent', async () => {
    const unpick = deferred();
    const refresh = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1, p2],
      pickGates: [unpick.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    const read = controlled.state.albumReads;
    controlled.state.albumReadGates[read] = refresh.promise;

    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    fireEvent.change(screen.getByLabelText('Album title'), { target: { value: 'Kept during removal' } });
    await user.click(screen.getByRole('button', { name: 'Use p2.jpg as the album cover' }));
    await act(async () => { unpick.resolve(); });
    await waitFor(() => expect(controlled.state.albumReads).toBe(read + 1));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Kept during refresh' } });
    await act(async () => { refresh.resolve(); });

    expect(screen.getByLabelText('Album title')).toHaveValue('Kept during removal');
    expect(screen.getByLabelText('Description')).toHaveValue('Kept during refresh');
    expect(await screen.findByText('Cover · p2.jpg')).toBeVisible();
  });

  it('keeps Album mounted until membership and its authoritative reconciliation both settle', async () => {
    const unpick = deferred();
    const refresh = deferred();
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      pickGates: [unpick.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    const read = controlled.state.albumReads;
    controlled.state.albumReadGates[read] = refresh.promise;

    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));
    expect(screen.getByLabelText('Album title')).toBeVisible();
    await act(async () => { unpick.resolve(); });
    await waitFor(() => expect(controlled.state.albumReads).toBe(read + 1));
    expect(screen.getByLabelText('Album title')).toBeVisible();
    await act(async () => { refresh.resolve(); });
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('retires a removed-section inverse when later metadata, cover, and reorder intent exists', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 4,
        saved: true,
        entries: [
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Remove section Reception' }));
    fireEvent.change(screen.getByLabelText('Album title'), { target: { value: 'Later title' } });
    await user.click(screen.getByRole('button', { name: 'Use p2.jpg as the album cover' }));
    await user.click(screen.getByRole('button', { name: 'Move p2.jpg earlier' }));
    fireEvent.blur(screen.getByLabelText('Album title'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());

    expect(screen.getByLabelText('Album title')).toHaveValue('Later title');
    expect(screen.getByText('Cover · p2.jpg')).toBeVisible();
    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p2', 'photo:p1']);
  });

  it('keeps a rejected photo undo retryable and holds expiry until both pointer and focus leave', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({ galleryRows: [p1], pickErrors: [undefined, 'Could not restore the photo.'] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    const undoButton = await screen.findByRole('button', { name: 'Undo' });

    vi.useFakeTimers();
    const bar = undoButton.closest('.album-undo__bar')!;
    fireEvent.pointerEnter(bar);
    undoButton.focus();
    fireEvent.pointerLeave(bar);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(undoButton).toBeVisible();
    vi.useRealTimers();

    await user.click(undoButton);
    expect(await screen.findByText(UNDO_FAILED_MESSAGE, { selector: '.album-undo__error' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' })).toBeEnabled();
  });

  it.each([
    [40, 'An album holds up to 40 sections.'],
    [500, 'An album holds up to 500 photos and sections.'],
  ] as const)('enforces the local album bound at %i entries', async (count, message) => {
    const entries = Array.from({ length: count }, (_, index): AlbumEntryView => ({
      kind: 'section', id: `s${index}`, heading: `Section ${index + 1}`,
    }));
    const { state, fetchMock } = harness({ album: { revision: 2, saved: true, entries } });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Add a section' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(state.orderWrites).toHaveLength(0);
  });

  it('reloads only REVISION_CONFLICT and leaves ALBUM_FULL as a retryable save failure', async () => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      orderErrors: ['The album reached its entry limit.'],
      orderErrorCodes: ['ALBUM_FULL'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    const reads = controlled.state.albumReads;
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'At the limit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The album reached its entry limit.');
    expect(controlled.state.albumReads).toBe(reads);
    expect(screen.getByRole('button', { name: 'Retry album' })).toBeEnabled();
  });

  it('keeps every exit behind a failed membership refresh until canonical retry succeeds', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1, p2],
      albumReadErrors: [undefined, 'The trusted album could not be refreshed.'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    const refreshAlert = await screen.findByRole('alert');
    expect(refreshAlert).toHaveTextContent('The photo was removed from Album, but the Album could not be refreshed.');
    await user.click(within(refreshAlert).getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('button', { name: 'Retry album refresh' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    expect(screen.queryByText('What people with the Album link see')).not.toBeInTheDocument();
    const retry = await screen.findByRole('button', { name: 'Retry album refresh' });
    expect(retry).toHaveFocus();

    const readsBeforeRetry = controlled.state.albumReads;
    await user.click(retry);
    await waitFor(() => expect(controlled.state.albumReads).toBeGreaterThan(readsBeforeRetry));
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    expect(await screen.findByText('What people with the Album link see')).toBeVisible();
  });

  it('rebases an edit made while a conflict canonical GET is pending', async () => {
    const conflictRead = deferred();
    const controlled = harness({
      albumReadGates: [undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing edit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(2));

    fireEvent.change(screen.getByLabelText('Album title'), { target: { value: 'Edit made during reload' } });
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.metadataWrites.at(-1)?.title).toBe('Edit made during reload'));
    expect(screen.getByLabelText('Album title')).toHaveValue('Edit made during reload');
    expect(screen.queryByText('What people with the Album link see')).not.toBeInTheDocument();
  });

  it('rebases only edits made after a rejected snapshot onto the co-host canonical draft', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const conflictRead = deferred();
    const controlled = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 4,
        saved: true,
        title: 'Before either host',
        description: 'Before either host.',
        entries: [{ kind: 'photo', photo: p1 }, { kind: 'photo', photo: p2 }],
      },
      albumReadGates: [undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing title' } });
    await user.click(screen.getByRole('button', { name: 'Move p1.jpg later' }));
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(2));

    controlled.state.album = {
      revision: 5,
      saved: true,
      title: 'Co-host title',
      description: 'Co-host description.',
      entries: [{ kind: 'photo', photo: p1 }, { kind: 'photo', photo: p2 }],
      coverMediaId: null,
    };
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Only this edit is newer.' } });
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.metadataWrites[1]).toEqual({
      title: 'Co-host title',
      description: 'Only this edit is newer.',
      coverMediaId: null,
    });
    expect(controlled.state.orderWrites[1]?.map((entry) => (
      entry.kind === 'section' ? `section:${entry.id}` : `photo:${entryMediaId(entry)}`
    )))
      .toEqual(['photo:p1', 'photo:p2']);
    expect(screen.getByLabelText('Album title')).toHaveValue('Co-host title');
  });

  it('replays the actual moved key over canonical order instead of inferring an LCS move', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const p3 = photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true });
    const conflictRead = deferred();
    const controlled = harness({
      galleryRows: [p1, p2, p3],
      album: {
        revision: 4,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
          { kind: 'photo', photo: p3 },
        ],
      },
      albumReadGates: [undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing edit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(2));

    controlled.state.album = {
      revision: 5,
      saved: true,
      entries: [
        { kind: 'photo', photo: p1 },
        { kind: 'photo', photo: p3 },
        { kind: 'photo', photo: p2 },
      ],
    };
    await user.click(screen.getByRole('button', { name: 'Move p1.jpg later' }));
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.orderWrites[1]?.map(writtenEntryId)).toEqual(['p3', 'p2', 'p1']);
  });

  it('replays a contextual section insertion between the same neighboring keys after a revision conflict', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const p3 = photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true });
    const conflictRead = deferred();
    const controlled = harness({
      galleryRows: [p1, p2, p3],
      album: {
        revision: 4,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
          { kind: 'photo', photo: p3 },
        ],
      },
      albumReadGates: [undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing edit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(2));

    controlled.state.album = {
      revision: 5,
      saved: true,
      entries: [
        { kind: 'photo', photo: p1 },
        { kind: 'section', id: 'co-host', heading: 'Co-host section' },
        { kind: 'photo', photo: p2 },
        { kind: 'photo', photo: p3 },
      ],
    };
    screen.getByRole('button', { name: 'Move p2.jpg earlier' }).focus();
    await user.click(screen.getByRole('button', { name: 'Add a section' }));
    const insertedKey = screen.getByLabelText('Section name').closest('li')
      ?.getAttribute('data-entry-key');
    expect(insertedKey).toMatch(/^section:/u);
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.orderWrites[1]?.map((entry) => (
      entry.kind === 'section' ? `section:${entry.id}` : `photo:${entryMediaId(entry)}`
    ))).toEqual([
      'photo:p1',
      'section:co-host',
      'photo:p2',
      insertedKey,
      'photo:p3',
    ]);
  });

  it('replays a post-rejection section insert, rename, and anchor removal in action order', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const conflictRead = deferred();
    const controlled = harness({
      galleryRows: [p1],
      album: {
        revision: 4,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 'keep', heading: 'Keep' },
          { kind: 'section', id: 'anchor', heading: 'Remove me' },
        ],
      },
      albumReadGates: [undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing edit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(2));

    controlled.state.album = {
      revision: 5,
      saved: true,
      entries: [
        { kind: 'section', id: 'anchor', heading: 'Remove me' },
        { kind: 'photo', photo: p1 },
        { kind: 'section', id: 'keep', heading: 'Keep' },
      ],
    };
    await user.click(screen.getByRole('button', { name: 'Add a section' }));
    const inserted = screen.getAllByLabelText('Section name').at(-1)!;
    await user.clear(inserted);
    await user.type(inserted, 'After party');
    fireEvent.blur(inserted);
    await user.click(screen.getByRole('button', { name: 'Remove section Remove me' }));
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.orderWrites[1]?.map(writtenEntry)).toEqual(['After party', 'p1', 'Keep']);
  });

  it('restores a section renamed after rejection when the canonical album removed it', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const p3 = photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true });
    const conflictRead = deferred();
    const controlled = harness({
      galleryRows: [p1, p2, p3],
      album: {
        revision: 4,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 'renamed', heading: 'Original section' },
          { kind: 'photo', photo: p2 },
        ],
      },
      albumReadGates: [undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing edit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(2));

    controlled.state.album = {
      revision: 5,
      saved: true,
      entries: [
        { kind: 'photo', photo: p3 },
        { kind: 'photo', photo: p1 },
        { kind: 'photo', photo: p2 },
      ],
    };
    const sectionName = screen.getByLabelText('Section name');
    fireEvent.change(sectionName, { target: { value: '  Renamed section  ' } });
    fireEvent.blur(sectionName);
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.orderWrites[1]?.map(writtenEntry)).toEqual(['p3', 'p1', 'Renamed section', 'p2']);
    expect(controlled.state.orderWrites[1]?.filter((entry) => (
      entry.kind === 'section' && entry.id === 'renamed'
    ))).toHaveLength(1);
  });

  it('keeps a scalar changed away and back while the conflict GET is pending', async () => {
    const conflictRead = deferred();
    const controlled = harness({
      album: {
        revision: 4,
        saved: true,
        title: 'Before either host',
        entries: [],
      },
      albumReadGates: [undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    const title = await screen.findByLabelText('Album title');

    fireEvent.change(title, { target: { value: 'Losing edit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(2));

    controlled.state.album = {
      revision: 5,
      saved: true,
      title: 'Co-host title',
      entries: [],
    };
    fireEvent.change(title, { target: { value: 'Temporary edit' } });
    fireEvent.change(title, { target: { value: 'Losing edit' } });
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.metadataWrites[1]?.title).toBe('Losing edit');
    expect(screen.getByLabelText('Album title')).toHaveValue('Losing edit');
  });

  it('escalates a non-retryable Album load and keeps one persistent Gallery live region', async () => {
    const onAlbumAccessFailure = vi.fn();
    const failed = harness({
      albumReadErrors: ['This session has expired.'],
      albumReadErrorCodes: ['SESSION_EXPIRED'],
    });
    renderWorkspace(failed.fetchMock, {}, { onAlbumAccessFailure });
    await openAlbum();
    await waitFor(() => expect(onAlbumAccessFailure).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'latest-link',
      retryable: false,
    })));

    cleanup();
    const loadingAlbum = deferred();
    const ready = harness({ albumReadGates: [loadingAlbum.promise] });
    renderWorkspace(ready.fetchMock);
    await openAlbum();
    await waitFor(() => expect(ready.state.albumReads).toBe(1));
    expect(document.querySelectorAll('[data-gallery-live-host] [role="status"]')).toHaveLength(1);
    expect(document.querySelectorAll('.album-undo [role="status"]')).toHaveLength(1);

    loadingAlbum.resolve();
    await screen.findByLabelText('Album title');
    expect(document.querySelectorAll('[data-gallery-live-host] [role="status"]')).toHaveLength(1);
  });

  it('replaces an album retry with preparing the current album when frozen source bytes were removed', async () => {
    const onPrepare = vi.fn(noop);
    const pickedHarness = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    const albumJob: ExportView = {
      id: 'album-removed', kind: 'album', state: 'failed',
      snapshotAt: '2026-08-23T12:00:00.000Z', mediaCount: 1, totalBytes: 64,
      createdAt: '2026-08-23T12:00:01.000Z', startedAt: '2026-08-23T12:00:02.000Z',
      completedAt: '2026-08-23T12:00:03.000Z', processedMediaCount: 1,
      processedBytes: 64, progressUpdatedAt: '2026-08-23T12:00:02.500Z',
      attempt: 1, partCount: 1, expiresAt: '2026-08-24T12:00:00.000Z',
      errorCode: 'EXPORT_SOURCE_REMOVED',
      guestbookEntryCount: null, guestbookSharedCount: null, guestbookEventName: null,
      guestbookEventDate: null, guestbookEventTimezone: null, guestbookPrompt: null,
      guestbookGalleryVisible: null,
    };
    renderWorkspace(pickedHarness.fetchMock, { albumJob, onPrepare });
    const user = await openAlbum();

    expect(await screen.findByText(/A photo in this prepared export is no longer available\. Prepare the current Album\./, {
      selector: 'span',
    })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry this prepared export' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Prepare current Album' }));
    expect(onPrepare).toHaveBeenCalledWith('album');
  });

  it('resets for a new event and sends its recreated queue only to that event', async () => {
    const controlled = harness();
    const rendered = renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await screen.findByLabelText('Album title');

    rendered.rerenderForEvent('event-b');
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true'));
    await openAlbum(user);
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Event B album' } });
    fireEvent.blur(screen.getByLabelText('Album title'));

    await waitFor(() => expect(controlled.state.orderPaths.at(-1)).toBe('/api/manage/events/event-b/album'));
  });

  it('clamps metadata and section headings by Unicode code point', async () => {
    const { fetchMock } = harness();
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    const emoji = '💍';
    const title = await screen.findByLabelText('Album title');
    expect(title).not.toHaveAttribute('maxlength');
    fireEvent.change(title, { target: { value: emoji.repeat(121) } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: emoji.repeat(1_001) } });
    await user.click(screen.getByRole('button', { name: 'Add a section' }));
    fireEvent.change(screen.getByLabelText('Section name'), { target: { value: emoji.repeat(81) } });

    expect(Array.from((title as HTMLInputElement).value)).toHaveLength(120);
    expect(Array.from((screen.getByLabelText('Description') as HTMLTextAreaElement).value)).toHaveLength(1_000);
    expect(Array.from((screen.getByLabelText('Section name') as HTMLInputElement).value)).toHaveLength(80);
  });

  it('gives native drag complete transfer cleanup while an Album link is active', async () => {
    const activeShare = {
      active: true as const,
      url: 'https://candidary.test/album#active.share',
      sharedAt: '2026-08-23T12:00:00.000Z',
    };
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({ galleryRows: [p1, p2], share: activeShare });
    renderWorkspace(fetchMock);
    await openAlbum();

    expect(await screen.findByRole('button', { name: 'Copy Album link' })).toBeVisible();

    const transfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), clearData: vi.fn() };
    const first = document.querySelector('[data-entry-key="photo:p1"]')!;
    fireEvent.dragStart(first, { dataTransfer: transfer });
    expect(transfer.effectAllowed).toBe('move');
    expect(transfer.setData).toHaveBeenCalled();
    fireEvent.dragEnd(first, { dataTransfer: transfer });
    expect(transfer.clearData).toHaveBeenCalled();
  });

  it('offers section Undo only after the exact removal save, then keeps it running through restoration', async () => {
    const removal = deferred();
    const restoration = deferred();
    const controlled = harness({
      album: {
        revision: 2,
        saved: true,
        entries: [{ kind: 'section', id: 's1', heading: 'Reception' }],
      },
      orderGates: [removal.promise, restoration.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Remove section Reception' }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    removal.resolve();
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Undoing…' })).toBeDisabled();
    restoration.resolve();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
  });

  it('Album Reset contract: offers Undo only after the exact reset save, then keeps it running through restoration', async () => {
    const reset = deferred();
    const restoration = deferred();
    const p1 = photo('p1', '2026-08-15T23:00:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T22:00:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 4,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p2 },
        ],
      },
      orderGates: [reset.promise, restoration.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Reset to timeline order' }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    reset.resolve();
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    restoration.resolve();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
  });

  it('keeps a confirmed photo inverse available after Album unmounts', async () => {
    const removal = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 6,
        saved: true,
        title: 'The evening',
        description: 'In our order.',
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p2 },
        ],
        coverMediaId: p1.id,
      },
      orderGates: [removal.promise],
    });
    const rendered = renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(1));
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));
    expect(screen.getByLabelText('Album title')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();

    removal.resolve();
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByLabelText('Album title')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(controlled.state.pickWrites).toEqual([
      { mediaIds: ['p1'], picked: false },
      { mediaIds: ['p1'], picked: true },
    ]));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.orderWrites[1]?.map(writtenEntryId)).toEqual(['p1', 's1', 'p2']);
    expect(controlled.state.metadataWrites[1]).toEqual({
      title: 'The evening',
      description: 'In our order.',
      coverMediaId: 'p1',
    });
    expect(rendered.invalidateGalleryAfterMutation).toHaveBeenCalledTimes(1);
  });

  it('registers Start-empty Undo before a pending leave can unmount Album', async () => {
    const start = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: { revision: 0, saved: false, entries: [] },
      startGates: [start.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Start empty' }));
    await waitFor(() => expect(controlled.state.startWrites).toEqual(['empty']));
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeVisible();

    start.resolve();

    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByLabelText('Album title')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeEnabled();
  });

  it.each([
    'section removal',
    'Reset',
    'Start empty',
  ] as const)('executes %s Undo after Album unmounts through Manager', async (operation) => {
    const p1 = photo('p1', '2026-08-15T23:00:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T22:00:00.000Z', { isFavorite: true });
    const controlled = operation === 'Start empty'
      ? harness({
          galleryRows: [p1, p2],
          album: {
            revision: 0,
            saved: false,
            title: 'The evening',
            description: 'Before albums existed.',
            entries: [],
          },
        })
      : harness({
          galleryRows: [p1, p2],
          album: {
            revision: 4,
            saved: true,
            title: 'The evening',
            description: 'In our order.',
            entries: [
              { kind: 'photo', photo: p1 },
              { kind: 'section', id: 's1', heading: 'Reception' },
              { kind: 'photo', photo: p2 },
            ],
            coverMediaId: p1.id,
          },
        });
    const rendered = renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    if (operation === 'section removal') {
      await user.click(await screen.findByRole('button', { name: 'Remove section Reception' }));
    } else if (operation === 'Reset') {
      await user.click(await screen.findByRole('button', { name: 'Reset to timeline order' }));
    } else {
      await user.click(await screen.findByRole('button', { name: 'Start empty' }));
    }
    await screen.findByRole('button', { name: 'Undo' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));
    await waitFor(() => expect(screen.queryByLabelText('Album title')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(rendered.invalidateGalleryAfterMutation).toHaveBeenCalledTimes(1));

    if (operation === 'section removal') {
      expect(controlled.state.pickWrites).toEqual([]);
      expect(controlled.state.orderWrites).toHaveLength(2);
      expect(controlled.state.orderWrites[1]?.map(writtenEntryId)).toEqual(['p1', 's1', 'p2']);
      expect(controlled.state.metadataWrites[1]).toEqual({
        title: 'The evening',
        description: 'In our order.',
        coverMediaId: 'p1',
      });
    } else if (operation === 'Reset') {
      expect(controlled.state.pickWrites).toEqual([]);
      expect(controlled.state.orderWrites).toHaveLength(2);
      expect(controlled.state.orderWrites[1]?.map(writtenEntryId)).toEqual(['p1', 's1', 'p2']);
      expect(controlled.state.metadataWrites[1]).toEqual({
        title: 'The evening',
        description: 'In our order.',
        coverMediaId: 'p1',
      });
    } else {
      expect(controlled.state.startWrites).toEqual(['empty']);
      expect(controlled.state.pickWrites).toEqual([{
        mediaIds: ['p1', 'p2'],
        picked: true,
      }]);
      expect(controlled.state.orderWrites).toHaveLength(1);
      expect(controlled.state.orderWrites[0]?.map(writtenEntryId)).toEqual(['p1', 'p2']);
      expect(controlled.state.metadataWrites[0]).toEqual({
        title: 'The evening',
        description: 'Before albums existed.',
        coverMediaId: null,
      });
      expect(controlled.state.album.saved).toBe(true);
    }
  });

  it('safety ladder reversible: offers real membership Undo after unpick succeeds and the order save fails', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 3,
        saved: true,
        entries: [{ kind: 'photo', photo: p1 }, { kind: 'photo', photo: p2 }],
      },
      orderErrors: ['The order could not be saved.'],
    });
    const rendered = renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    expect(controlled.state.pickWrites).toEqual([]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    await waitFor(() => expect(controlled.state.pickWrites).toEqual([
      { mediaIds: ['p1'], picked: false },
    ]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();
    expect(document.querySelector('.album-undo__bar'))
      .toHaveTextContent('1 photo removed from Album. The delivered photo remains.');
    await user.click(await screen.findByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(controlled.state.pickWrites).toEqual([
      { mediaIds: ['p1'], picked: false },
      { mediaIds: ['p1'], picked: true },
    ]));
    expect(controlled.state.orderWrites).toHaveLength(1);
    expect(controlled.state.orderRevisions).toEqual([3]);
    expect(rendered.invalidateGalleryAfterMutation).toHaveBeenCalledTimes(1);
  });

  it('classifies an accepted order whose response was lost and does not replay the forward write', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 8,
        saved: true,
        entries: [{ kind: 'photo', photo: p1 }, { kind: 'photo', photo: p2 }],
      },
    });
    let loseForwardResponse = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await controlled.fetchMock(input, init);
      const url = new URL(String(input), 'https://candidary.test');
      if (loseForwardResponse && url.pathname.endsWith('/album') && init?.method === 'PUT') {
        loseForwardResponse = false;
        throw new TypeError('Failed to fetch');
      }
      return response;
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.orderRevisions).toEqual([8, 9]);
    expect(controlled.state.pickWrites).toEqual([
      { mediaIds: ['p1'], picked: false },
      { mediaIds: ['p1'], picked: true },
    ]);
  });

  it('does not offer Undo when failed removal reconciliation finds the exact pre-state', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: { revision: 4, saved: true, entries: [{ kind: 'photo', photo: p1 }] },
      orderErrors: ['The order could not be saved.'],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await controlled.fetchMock(input, init);
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/album') && init?.method === 'PUT') {
        controlled.state.galleryRows[0]!.isFavorite = true;
      }
      return response;
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBeGreaterThan(1));

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(controlled.state.pickWrites).toEqual([{ mediaIds: ['p1'], picked: false }]);
  });

  it('fails closed when failed removal reconciliation finds unrelated canonical metadata', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: {
        revision: 4,
        saved: true,
        title: 'Before',
        entries: [{ kind: 'photo', photo: p1 }],
      },
      orderErrors: ['The order could not be saved.'],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await controlled.fetchMock(input, init);
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/album') && init?.method === 'PUT') {
        controlled.state.album.title = 'A co-host changed this';
      }
      return response;
    });
    const rendered = renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBeGreaterThan(1));

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(controlled.state.orderWrites).toHaveLength(1);
    expect(rendered.invalidateGalleryAfterMutation).toHaveBeenCalled();
  });

  it('suppresses an older section offer when a newer draft cursor queues behind its save', async () => {
    const controlled = harness({
      album: {
        revision: 2,
        saved: true,
        entries: [{ kind: 'section', id: 's1', heading: 'Reception' }],
      },
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove section Reception' }), { detail: 1 });
    const title = screen.getByLabelText('Album title');
    fireEvent.change(title, { target: { value: 'Newer title' } });
    fireEvent.blur(title);
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));

    expect(controlled.state.metadataWrites[1]?.title).toBe('Newer title');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('retires an older offer before a deferred photo removal owns the replacement slot', async () => {
    const removal = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: {
        revision: 2,
        saved: true,
        entries: [
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p1 },
        ],
      },
      pickGates: [removal.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Remove section Reception' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Remove p1.jpg from Album' }));
    await waitFor(() => expect(controlled.state.pickWrites).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();

    removal.resolve();
    const replacement = await screen.findByRole('button', { name: 'Undo' });
    expect(replacement.closest('.album-undo__bar'))
      .toHaveTextContent('1 photo removed from Album. The delivered photo remains.');
  });

  it('retires an older Library offer before deferred Start empty confirms its inverse', async () => {
    const start = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z');
    const controlled = harness({
      galleryRows: [p1],
      album: { revision: 0, saved: false, entries: [] },
      startGates: [start.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = userEvent.setup();

    await screen.findByText('p1.jpg');
    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select p1.jpg, from Jose' }));
    await user.click(screen.getByRole('button', { name: 'Pick for Album (1)' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();

    await openAlbum(user);
    await user.click(await screen.findByRole('button', { name: 'Start empty' }));
    await waitFor(() => expect(controlled.state.startWrites).toEqual(['empty']));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();

    start.resolve();
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();
    expect(screen.getByText('The Album starts empty. The Album picks were cleared.')).toBeVisible();
  });

  it('locks every visible offer-producing Album action while Undo is running', async () => {
    const restoration = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: {
        revision: 3,
        saved: true,
        entries: [
          { kind: 'section', id: 's1', heading: 'Dinner' },
          { kind: 'section', id: 's2', heading: 'Dancing' },
          { kind: 'photo', photo: p1 },
        ],
      },
      orderGates: [undefined as unknown as Promise<void>, restoration.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Remove section Dinner' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));

    expect(screen.getByRole('button', { name: 'Reset to timeline order' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove section Dancing' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove p1.jpg from Album' })).toBeDisabled();

    restoration.resolve();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undoing…' })).not.toBeInTheDocument());
  });

  it.each([
    ['the next photo', ['p1', 'p2'], 'p1', 'Remove p2.jpg from Album'],
    ['the previous photo', ['p1', 'p2'], 'p2', 'Remove p1.jpg from Album'],
    ['the Album heading', ['p1'], 'p1', 'Album'],
  ] as const)('keeps pointer focus on %s after photo removal', async (
    _fallback,
    ids,
    removedId,
    expectedName,
  ) => {
    const rows = ids.map((id, index) => photo(
      id,
      `2026-08-15T${String(22 + index).padStart(2, '0')}:00:00.000Z`,
      { isFavorite: true },
    ));
    const controlled = harness({
      galleryRows: rows,
      album: {
        revision: 2,
        saved: true,
        entries: rows.map((item) => ({ kind: 'photo' as const, photo: item })),
      },
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();

    fireEvent.click(await screen.findByRole('button', {
      name: `Remove ${removedId}.jpg from Album`,
    }), { detail: 1 });
    await screen.findByRole('button', { name: 'Undo' });

    const fallback = expectedName === 'Album'
      ? screen.getByRole('heading', { name: 'Album' })
      : screen.getByRole('button', { name: expectedName });
    expect(fallback).toHaveFocus();
  });

  it.each([
    [
      'the next entry',
      [
        { kind: 'section' as const, id: 's1', heading: 'Dinner' },
        { kind: 'section' as const, id: 's2', heading: 'Dancing' },
      ],
      'Dinner',
      'Remove section Dancing',
    ],
    [
      'the previous entry',
      [
        { kind: 'section' as const, id: 's1', heading: 'Dinner' },
        { kind: 'section' as const, id: 's2', heading: 'Dancing' },
      ],
      'Dancing',
      'Remove section Dinner',
    ],
    [
      'the Album heading',
      [{ kind: 'section' as const, id: 's1', heading: 'Dinner' }],
      'Dinner',
      'Album',
    ],
  ] as const)('keeps pointer focus on %s after section removal', async (
    _fallback,
    entries,
    removedName,
    expectedName,
  ) => {
    const controlled = harness({
      album: { revision: 2, saved: true, entries: [...entries] },
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();

    fireEvent.click(await screen.findByRole('button', {
      name: `Remove section ${removedName}`,
    }), { detail: 1 });
    await screen.findByRole('button', { name: 'Undo' });

    const fallback = expectedName === 'Album'
      ? screen.getByRole('heading', { name: 'Album' })
      : screen.getByRole('button', { name: expectedName });
    expect(fallback).toHaveFocus();
  });

  it('focuses keyboard Undo only when focus remains on the established fallback', async () => {
    const removal = deferred();
    const controlled = harness({
      album: {
        revision: 2,
        saved: true,
        entries: [
          { kind: 'section', id: 's1', heading: 'Dinner' },
          { kind: 'section', id: 's2', heading: 'Dancing' },
        ],
      },
      orderGates: [removal.promise],
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove section Dinner' }), { detail: 0 });
    const fallback = screen.getByRole('button', { name: 'Remove section Dancing' });
    expect(fallback).toHaveFocus();
    removal.resolve();

    expect(await screen.findByRole('button', { name: 'Undo' })).toHaveFocus();
  });

  it('does not steal focus when the host moves it before keyboard Undo is confirmed', async () => {
    const removal = deferred();
    const controlled = harness({
      album: {
        revision: 2,
        saved: true,
        entries: [
          { kind: 'section', id: 's1', heading: 'Dinner' },
          { kind: 'section', id: 's2', heading: 'Dancing' },
        ],
      },
      orderGates: [removal.promise],
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove section Dinner' }), { detail: 0 });
    const title = screen.getByLabelText('Album title');
    title.focus();
    removal.resolve();

    await screen.findByRole('button', { name: 'Undo' });
    expect(title).toHaveFocus();
  });

  it.each([
    [0, 'Undo'],
    [1, 'Remove p2.jpg from Album'],
  ] as const)('uses the nearest surviving entry after Reset click detail %i', async (detail, focusedName) => {
    const p1 = photo('p1', '2026-08-15T23:00:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T22:00:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 2,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 's1', heading: 'Dinner' },
          { kind: 'photo', photo: p2 },
        ],
      },
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();

    fireEvent.click(await screen.findByRole('button', { name: 'Reset to timeline order' }), { detail });
    await screen.findByRole('button', { name: 'Undo' });

    expect(screen.getByRole('button', { name: focusedName })).toHaveFocus();
  });

  it('uses the Album heading when Reset leaves no entry control', async () => {
    const controlled = harness({
      album: {
        revision: 2,
        saved: true,
        entries: [{ kind: 'section', id: 's1', heading: 'Dinner' }],
      },
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();

    fireEvent.click(await screen.findByRole('button', { name: 'Reset to timeline order' }), { detail: 1 });
    await screen.findByRole('button', { name: 'Undo' });

    expect(screen.getByRole('heading', { name: 'Album' })).toHaveFocus();
  });

  it.each([
    [0, 'Undo'],
    [1, 'Album title'],
  ] as const)('uses the first mounted editor control after Start empty click detail %i', async (
    detail,
    focusedName,
  ) => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: { revision: 0, saved: false, entries: [] },
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();

    fireEvent.click(await screen.findByRole('button', { name: 'Start empty' }), { detail });
    await screen.findByRole('button', { name: 'Undo' });

    const focused = focusedName === 'Album title'
      ? screen.getByLabelText(focusedName)
      : screen.getByRole('button', { name: focusedName });
    expect(focused).toHaveFocus();
  });

  it.each([
    ['an unexpected forward entry', 'entry'],
    ['a cleared-ID mismatch', 'cleared'],
  ] as const)('fails closed when Start empty returns %s', async (_case, corruption) => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: { revision: 0, saved: false, entries: [] },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await controlled.fetchMock(input, init);
      const url = new URL(String(input), 'https://candidary.test');
      if (!url.pathname.endsWith('/album/start') || init?.method !== 'POST') return response;
      const payload = await response.json() as {
        data: { album: AlbumView; started: boolean; cleared: string[] };
      };
      return success({
        ...payload.data,
        album: corruption === 'entry'
          ? {
              ...payload.data.album,
              entries: [{ kind: 'section', id: 'unexpected', heading: 'Co-host section' }],
              sectionCount: 1,
            }
          : payload.data.album,
        cleared: corruption === 'cleared' ? [] : payload.data.cleared,
      });
    });
    const rendered = renderWorkspace(fetchMock);
    await openAlbum();

    fireEvent.click(await screen.findByRole('button', { name: 'Start empty' }), { detail: 1 });
    await screen.findByLabelText('Album title');

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(rendered.invalidateGalleryAfterMutation).toHaveBeenCalled();
  });

  it('Album Reset contract: explains breadth before action and derives its Undo duration from the shared window', async () => {
    const controlled = harness({
      album: {
        revision: 2,
        saved: true,
        entries: [{ kind: 'section', id: 's1', heading: 'Dinner' }],
      },
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();

    const consequence = `Reset removes every section and can be undone for ${UNDO_WINDOW_MS / 1_000} seconds.`;
    expect(screen.getByText(consequence)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reset to timeline order' }))
      .toHaveAccessibleDescription(consequence);
  });

  it('keeps photo undo retryable when its authoritative refresh fails', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({ galleryRows: [p1] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    const undo = await screen.findByRole('button', { name: 'Undo' });
    controlled.state.albumReadErrors[controlled.state.albumReads] = 'The restored album could not be refreshed.';
    await user.click(undo);

    expect(await screen.findByText(UNDO_FAILED_MESSAGE, { selector: '.album-undo__error' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' })).toBeEnabled();
  });

  it('keeps offer-producing Album actions locked when a photo inverse is rejected', async () => {
    const restore = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: {
        revision: 3,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 's1', heading: 'Dinner' },
          { kind: 'section', id: 's2', heading: 'Dancing' },
        ],
      },
      pickGates: [undefined, restore.promise],
      pickErrors: [undefined, 'Old photo undo failed.'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from Album' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    const removeSection = screen.getByRole('button', { name: 'Remove section Dinner' });
    expect(removeSection).toBeDisabled();
    await user.click(removeSection);
    restore.resolve();

    expect(await screen.findByText(UNDO_FAILED_MESSAGE, { selector: '.album-undo__error' })).toBeVisible();
    expect(screen.getByText(
      '1 photo removed from Album. The delivered photo remains.',
      { selector: '.album-undo__message' },
    )).toBeVisible();
    expect(await screen.findByDisplayValue('Dinner')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
  });

  it('announces the capped undo window and restores keyboard focus when the absolute recovery cap expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    render(<CappedUndoProviderHarness expiresAt="2026-08-24T00:00:02.000Z" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(screen.getByRole('status')).toHaveTextContent(
      'Photo moved to Recently deleted. Undo for up to 9 seconds, before 2026-08-24T00:00:02.000Z.',
    );
    const undo = screen.getByRole('button', { name: 'Undo' });
    const bar = undo.closest('.album-undo__bar')!;
    undo.focus();
    fireEvent.pointerEnter(bar);
    act(() => { vi.advanceTimersByTime(2_000); });

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Return origin' }));
  });

  it('does not render an Undo action for an offer whose valid recovery deadline is already past', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    const onRun = vi.fn(noop);
    render(<CappedUndoProviderHarness expiresAt="2026-08-23T23:59:59.000Z" onRun={onRun} />);
    await act(async () => {});

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();
  });

  it('does not invoke Undo after its deadline passed while its cap timer was delayed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    const onRun = vi.fn(noop);
    render(<CappedUndoProviderHarness expiresAt="2026-08-24T00:00:01.000Z" onRun={onRun} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const undo = screen.getByRole('button', { name: 'Undo' });

    // Simulate a backgrounded tab: wall time crosses the server cap before
    // the browser delivers its scheduled callback.
    vi.setSystemTime(new Date('2026-08-24T00:00:02.000Z'));
    fireEvent.click(undo);

    expect(onRun).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('expires a focused Undo at its absolute cap even after its nominal window was held open', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    render(<CappedUndoProviderHarness expiresAt="2026-08-24T00:00:10.000Z" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    const undo = screen.getByRole('button', { name: 'Undo' });
    undo.focus();
    fireEvent.pointerEnter(undo.closest('.album-undo__bar')!);
    act(() => { vi.advanceTimersByTime(9_000); });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
    act(() => { vi.advanceTimersByTime(1_000); });

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Return origin' }));
  });

  it('renders an already-past replacement deadline immediately after time advanced', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    const rendered = render(<DeadlineClockHarness deadlines={["2026-08-24T00:00:30.000Z"]} />);
    expect(screen.getByText('Recovery available')).toBeVisible();
    act(() => { vi.advanceTimersByTime(5_000); });

    rendered.rerender(<DeadlineClockHarness deadlines={["2026-08-24T00:00:03.000Z"]} />);
    expect(screen.getByText('Recovery expired')).toBeVisible();
  });

  it('does not re-render indefinitely when the wall clock advances across deadline-clock effects', () => {
    const start = Date.parse('2026-08-24T00:00:00.000Z');
    let reads = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => start + reads++);
    let renders = 0;
    const observeRender = () => {
      renders += 1;
      if (renders > 2) throw new Error('deadline clock rendered repeatedly for one deadline key');
    };

    render(<DeadlineClockHarness deadlines={[]} onRender={observeRender} />);

    expect(renders).toBeLessThanOrEqual(2);
  });

  it('does not let clipboard completion for link A mark replacement link B copied', async () => {
    const copyA = deferred();
    const activeShare = {
      active: true as const,
      url: 'https://candidary.test/album#link-a.secret-a',
      sharedAt: '2026-08-23T12:00:00.000Z',
    };
    const replacementShare = {
      active: true as const,
      url: 'https://candidary.test/album#link-b.secret-b',
      sharedAt: '2026-08-23T12:05:00.000Z',
    };
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({ galleryRows: [p1], share: activeShare, shareResults: [replacementShare] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    installClipboard(vi.fn().mockReturnValue(copyA.promise));
    await user.click(await screen.findByRole('button', { name: 'Copy Album link' }));
    await user.click(screen.getByRole('button', { name: 'Stop Album link' }));
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Stop the Album link?' }))
      .getByRole('button', { name: 'Stop Album link' }));
    await user.click(await screen.findByRole('button', { name: 'Create Album link' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Create the Album link?' }))
      .getByRole('button', { name: 'Create Album link' }));
    expect(await screen.findByRole('button', { name: 'Copy Album link' })).toBeVisible();
    expect(screen.queryByText(replacementShare.url)).not.toBeInTheDocument();
    copyA.resolve();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole('button', { name: 'Copy Album link' })).toBeVisible();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });

  it('resolves a native drag source by stable key after membership changes the list', async () => {
    const p1 = photo('p1', '2026-08-15T21:00:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T22:00:00.000Z', { isFavorite: true });
    const p3 = photo('p3', '2026-08-15T23:00:00.000Z', { isFavorite: true });
    const controlled = harness({ galleryRows: [p1, p2, p3] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    const transfer = { effectAllowed: '', setData: vi.fn(), clearData: vi.fn() };
    fireEvent.dragStart(document.querySelector('[data-entry-key="photo:p2"]')!, { dataTransfer: transfer });
    await user.click(screen.getByRole('button', { name: 'Remove p1.jpg from Album' }));
    await waitFor(() => expect(document.querySelector('[data-entry-key="photo:p1"]')).not.toBeInTheDocument());
    fireEvent.drop(document.querySelector('[data-entry-key="photo:p3"]')!, { dataTransfer: transfer });

    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p3', 'photo:p2']);
  });

  it('keeps the sole Gallery live region outside viewer inerting and updates it on movement', async () => {
    const controlled = harness();
    renderWorkspace(controlled.fetchMock);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /open first dance/i }));
    await screen.findByRole('dialog', { name: 'First dance' });
    const statuses = document.querySelectorAll('[data-gallery-live-host] [role="status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.closest('[data-gallery-live-host]')).not.toHaveAttribute('inert');

    await user.keyboard('{ArrowRight}');
    expect(statuses[0]).toHaveTextContent('Photo 2 of 3. p2.jpg, from Jose.');
    cleanup();
    expect(document.querySelector('[data-gallery-live-host]')).not.toBeInTheDocument();
  });

  it('blocks single and bulk Library picks when sections already fill the combined entry cap', async () => {
    const entries = Array.from({ length: 500 }, (_, index): AlbumEntryView => ({
      kind: 'section', id: `s${index}`, heading: `Section ${index + 1}`,
    }));
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' })],
      album: { revision: 2, saved: true, entries },
    });
    renderWorkspace(controlled.fetchMock);
    const user = userEvent.setup();
    await screen.findByText('First dance');
    await user.click(screen.getByRole('button', { name: 'Pick First dance for the Album' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('500 photos and sections');
    expect(controlled.state.pickWrites).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Select photos/ }));
    await user.click(screen.getByRole('button', { name: /^Select First dance/ }));
    await user.click(screen.getByRole('button', { name: 'Pick for Album (1)' }));
    expect(controlled.state.pickWrites).toHaveLength(0);
  });

  it('does not let a delayed initial share read overwrite a newer share mutation', async () => {
    const initialRead = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({ galleryRows: [p1], shareReadGates: [initialRead.promise] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Create Album link' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Create the Album link?' }))
      .getByRole('button', { name: 'Create Album link' }));
    const link = await screen.findByRole('button', { name: 'Copy Album link' });
    initialRead.resolve();
    await act(async () => { await Promise.resolve(); });

    expect(link).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop Album link' })).toBeVisible();
  });
});

/**
 * A photo the host moved to Recently deleted keeps its album position, and the album
 * is the one Manager surface allowed to know it exists at all. What it may say about
 * it is exactly: that the place is held, and until when.
 */
describe('recently deleted photos in the album', () => {
  const RECOVERABLE_UNTIL = '2099-09-19T04:00:00.000Z';
  const RECOVERABLE_IN_CHICAGO = 'September 18, 2099 at 11:00 PM CDT';
  const LAPSED_UNTIL = '2026-08-20T04:00:00.000Z';
  const LAPSED_IN_CHICAGO = 'August 19, 2026 at 11:00 PM CDT';

  function albumWithRetainedSlot(slot: AlbumRetainedSlotView, overrides: {
    coverMediaId?: string | null;
  } = {}) {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { guestName: 'Maya', isFavorite: true });
    return harness({
      galleryRows: [p1, p2],
      trashed: { [slot.mediaId]: slot },
      album: {
        revision: 4,
        saved: true,
        title: 'The evening',
        ...overrides,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'photo-retained', slot },
          { kind: 'photo', photo: p2 },
        ],
      },
    });
  }

  it('stands an opaque marker in the slot and dates it in the event zone', async () => {
    const slot = retainedSlot('p9', RECOVERABLE_UNTIL);
    const { fetchMock } = albumWithRetainedSlot(slot);
    renderAlbum(fetchMock, { eventTimezone: 'America/Chicago' });

    const marker = await retainedMarker();
    // Nothing about the photograph survives here. That was the point of trashing it.
    expect(marker.querySelector('img')).toBeNull();
    expect(marker).not.toHaveTextContent('p9');
    expect(marker).not.toHaveTextContent(/\.jpg/);
    expect(marker).not.toHaveTextContent(/Jose|Maya/);
    expect(marker).not.toHaveTextContent('First dance');
    // Nor is it numbered: the number is the guest's reading position, and no guest sees this.
    expect(within(marker).queryByTestId('album-photo-position')).not.toBeInTheDocument();
    expect(within(marker).queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(within(marker).queryByRole('button', { name: /album cover/ })).not.toBeInTheDocument();

    expect(within(marker).getByText(RECOVERABLE_IN_CHICAGO)).toBeVisible();
    expect(marker.querySelector('time')).toHaveAttribute('datetime', RECOVERABLE_UNTIL);
    // The browser runs in UTC here. Reading the deadline in that zone would move it a day.
    expect(marker).not.toHaveTextContent('September 19, 2099');
    expect(within(marker).queryByText('Recovery expired · cleanup pending')).not.toBeInTheDocument();
  });

  it('says the deadline is unreadable rather than guessing a zone for it', async () => {
    const { fetchMock } = albumWithRetainedSlot(retainedSlot('p9', RECOVERABLE_UNTIL));
    renderAlbum(fetchMock, { eventTimezone: undefined });

    const marker = await retainedMarker();
    expect(marker).toHaveTextContent('Recovery ends Time unavailable.');
    // No machine-readable value, so no `<time>` element pretending there is one.
    expect(marker.querySelector('time')).toBeNull();
  });

  it('hands the retained marker intent and opaque media ID to the navigation owner', async () => {
    const onOpenRecentlyDeleted = vi.fn();
    const { state, fetchMock } = albumWithRetainedSlot(retainedSlot('p9', RECOVERABLE_UNTIL));
    renderAlbum(fetchMock, { eventTimezone: 'America/Chicago', onOpenRecentlyDeleted });
    const marker = await retainedMarker();

    await userEvent.setup().click(
      within(marker).getByRole('button', { name: 'Restore in Recently deleted' }),
    );

    expect(onOpenRecentlyDeleted).toHaveBeenCalledExactlyOnceWith('p9');
    // Album routed nowhere and kept nothing: it is still the editor, unsaved and unread.
    expect(screen.getByLabelText('Album title')).toHaveValue('The evening');
    expect(await retainedMarker()).toBeInTheDocument();
    expect(state.orderWrites).toHaveLength(0);
    expect(state.albumReads).toBe(1);
  });

  it('offers no Restore once the server calls the slot cleanup-pending', async () => {
    const slot = retainedSlot('p9', LAPSED_UNTIL, 'expired-cleanup-pending');
    const { fetchMock } = albumWithRetainedSlot(slot);
    renderAlbum(fetchMock, {
      eventTimezone: 'America/Chicago',
      onOpenRecentlyDeleted: vi.fn(),
    });
    const marker = await retainedMarker();
    expect(within(marker).getByText('Recovery expired · cleanup pending')).toBeVisible();
    expect(within(marker).getByText(LAPSED_IN_CHICAGO)).toBeVisible();
    expect(within(marker).queryByRole('button', { name: 'Restore in Recently deleted' })).not.toBeInTheDocument();
    // The slot is still held, so it is still reorderable and still saved.
    expect(within(marker).getByRole('button', { name: 'Move Recently deleted photo earlier' })).toBeEnabled();
  });

  it('withdraws Restore when the deadline passes under an editor left open', async () => {
    // The server still called it recoverable; the instant it named has gone by.
    const { fetchMock } = albumWithRetainedSlot(retainedSlot('p9', LAPSED_UNTIL));
    renderAlbum(fetchMock, {
      eventTimezone: 'America/Chicago',
      onOpenRecentlyDeleted: vi.fn(),
    });

    const marker = await retainedMarker();
    expect(within(marker).getByText('Recovery expired · cleanup pending')).toBeVisible();
    expect(within(marker).queryByRole('button', { name: 'Restore in Recently deleted' })).not.toBeInTheDocument();
  });

  it('updates a retained slot when its recovery deadline crosses while the editor stays open', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-09-19T03:59:59.000Z'));
    const { fetchMock } = albumWithRetainedSlot(retainedSlot('p9', RECOVERABLE_UNTIL));
    renderAlbum(fetchMock, {
      eventTimezone: 'America/Chicago',
      onOpenRecentlyDeleted: vi.fn(),
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const marker = screen.getByText('Recently deleted photo').closest('li')!;
    expect(within(marker).getByRole('button', { name: 'Restore in Recently deleted' })).toBeEnabled();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(within(marker).getByText('Recovery expired · cleanup pending')).toBeVisible();
    expect(within(marker).queryByRole('button', { name: 'Restore in Recently deleted' })).not.toBeInTheDocument();
  });

  it('starts an unsaved retained-only album from picks without dropping its held slot', async () => {
    const slot = retainedSlot('p9', RECOVERABLE_UNTIL);
    const { state, fetchMock } = harness({
      galleryRows: [],
      trashed: { p9: slot },
      album: {
        revision: 0,
        saved: false,
        title: 'The evening',
        entries: [{ kind: 'photo-retained', slot }],
      },
    });
    renderAlbum(fetchMock, { eventTimezone: 'America/Chicago' });
    const user = userEvent.setup();

    expect(await screen.findByText('1 existing pick from before this update.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start the Album from it' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeEnabled();
    expect(screen.queryByText('Recently deleted photo')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start the Album from it' }));

    expect(state.startWrites).toEqual(['from-picks']);
    expect(state.album.saved).toBe(true);
    expect(screen.queryByText('1 existing pick from before this update.')).not.toBeInTheDocument();
    expect(await retainedMarker()).toBeInTheDocument();
    expect(screen.getByText('0 photos In Album, and 1 recently deleted photo still holding a place'))
      .toBeVisible();
  });

  it('reorders visible photos around the opaque slot and saves the marker with them', async () => {
    const slot = retainedSlot('p9', RECOVERABLE_UNTIL);
    const { state, fetchMock } = albumWithRetainedSlot(slot);
    renderAlbum(fetchMock, { eventTimezone: 'America/Chicago' });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Move Recently deleted photo earlier' }));

    await waitFor(() => expect(state.orderWrites).toHaveLength(1));
    expect(state.orderWrites[0]?.map(writtenEntryId)).toEqual(['p9', 'p1', 'p2']);
    // The marker went back as a photo entry naming the same media id. Dropping it would
    // ask the server to evict a row the host can still restore.
    expect(state.orderWrites[0]?.[0]?.kind).toBe('photo-retained');

    await user.click(screen.getByRole('button', { name: 'Move First dance later' }));

    await waitFor(() => expect(state.orderWrites).toHaveLength(2));
    expect(state.orderWrites[1]?.map(writtenEntryId)).toEqual(['p9', 'p2', 'p1']);
    expect(await retainedMarker()).toBeInTheDocument();
  });

  it('counts retained slots when it says how full the album is', async () => {
    const { fetchMock } = albumWithRetainedSlot(retainedSlot('p9', RECOVERABLE_UNTIL));
    renderAlbum(fetchMock, { eventTimezone: 'America/Chicago' });

    // Trash does not give an album slot back, and this line is where a host looks
    // before deciding there is room for more.
    expect(await screen.findByText(
      '2 photos In Album, and 1 recently deleted photo still holding a place',
    )).toBeVisible();
  });

  it('says nothing about retained slots when there are none', async () => {
    const { fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    renderAlbum(fetchMock, { eventTimezone: 'America/Chicago' });

    expect(await screen.findByText('1 photo In Album')).toBeVisible();
    expect(screen.queryByText(/still holding a place/)).not.toBeInTheDocument();
  });

  it('keeps a retained cover chosen while showing the first visible photo instead', async () => {
    const slot = retainedSlot('p9', RECOVERABLE_UNTIL);
    const { fetchMock } = albumWithRetainedSlot(slot, { coverMediaId: 'p9' });
    renderAlbum(fetchMock, { eventTimezone: 'America/Chicago' });

    const cover = await screen.findByRole('img', { name: 'Album cover: First dance' });
    expect(cover).toHaveAttribute('src', '/api/media/p1/preview');
    expect(screen.getByText('Cover · first photo, until you star another · First dance')).toBeVisible();
    expect(screen.getByText('Your chosen cover is a recently deleted photo.')).toBeVisible();
    expect(document.querySelector('.album-cover__retained')).toHaveTextContent(
      `Restore it in Recently deleted by ${RECOVERABLE_IN_CHICAGO} and it is the cover again. Until then people with the Album link see the first photo`,
    );
    expect(document.querySelector('.album-cover__retained time'))
      .toHaveAttribute('datetime', RECOVERABLE_UNTIL);
  });

  it('replaces a retained cover reference when the host stars another photo', async () => {
    const slot = retainedSlot('p9', RECOVERABLE_UNTIL);
    const { state, fetchMock } = albumWithRetainedSlot(slot, { coverMediaId: 'p9' });
    renderAlbum(fetchMock, { eventTimezone: 'America/Chicago' });

    await userEvent.setup().click(
      await screen.findByRole('button', { name: 'Use p2.jpg as the album cover' }),
    );

    await waitFor(() => expect(state.metadataWrites.at(-1)?.coverMediaId).toBe('p2'));
    expect(screen.queryByText('Your chosen cover is a recently deleted photo.')).not.toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Album cover: p2.jpg' }))
      .toHaveAttribute('src', '/api/media/p2/preview');
    // The photograph is still retained; only the cover reference moved.
    expect(await retainedMarker()).toBeInTheDocument();
  });

  it('tells a host a lapsed cover will not come back on its own', async () => {
    const slot = retainedSlot('p9', LAPSED_UNTIL, 'expired-cleanup-pending');
    const { fetchMock } = albumWithRetainedSlot(slot, { coverMediaId: 'p9' });
    renderAlbum(fetchMock, { eventTimezone: 'America/Chicago' });

    expect(await screen.findByText('Your chosen cover is a recently deleted photo.')).toBeVisible();
    expect(document.querySelector('.album-cover__retained')).toHaveTextContent(
      `Recovery expired · cleanup pending. Recovery ended ${LAPSED_IN_CHICAGO}, so the first photo stays the cover.`,
    );
    expect(screen.getByRole('img', { name: 'Album cover: First dance' })).toBeVisible();
  });
});

/**
 * Stopping the Album link invalidates its credential without changing Album content.
 * The confirmation makes that narrow consequence explicit before the request.
 */
describe('stopping the album link', () => {
  const activeShare = {
    active: true as const,
    url: 'https://candidary.test/album#link-a.secret-a',
    sharedAt: '2026-08-23T12:00:00.000Z',
  };

  function sharedAlbum(overrides: Partial<Harness> = {}) {
    return harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      share: activeShare,
      ...overrides,
    });
  }

  it('uses Album link terminology when status loading has no error detail', async () => {
    const { fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      shareReadRejects: [true],
    });
    renderWorkspace(fetchMock);
    await openAlbum();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Album link status could not be loaded.',
    );
  });

  it('safety ladder consequential: asks before it sends anything, and says exactly what stopping costs', async () => {
    const { state, fetchMock } = sharedAlbum();
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Stop Album link' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Stop the Album link?' });
    // Nothing has been sent. Not the revocation, and not a draft flush either.
    expect(state.shareWrites).toEqual([]);
    expect(state.orderWrites).toEqual([]);
    expect(screen.queryByText(activeShare.url)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Album link' })).toBeVisible();

    expect(within(dialog).getByText(
      'Every request from people with the Album link stops working immediately, and so does every session already opened with it.',
    )).toBeVisible();
    expect(within(dialog).getByText(
      'A page someone still has open may keep the photographs it already loaded, and copies already loaded or downloaded cannot be recalled.',
    )).toBeVisible();
    expect(within(dialog).getByText(
      'This link cannot be brought back. You can create a new Album link afterwards.',
    )).toBeVisible();
    expect(within(dialog).getByText(
      'Delivered photos and the Album arrangement are unchanged. The Guest gallery is separate, and what event guests see there is unchanged.',
    )).toBeVisible();

    // Initial focus is the safe answer, never the destructive one.
    expect(within(dialog).getByRole('button', { name: 'Keep sharing' })).toHaveFocus();
  });

  it('sends nothing on Escape and puts the host back where they were', async () => {
    const { state, fetchMock } = sharedAlbum();
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    const invoking = await screen.findByRole('button', { name: 'Stop Album link' });
    await user.click(invoking);
    await screen.findByRole('alertdialog', { name: 'Stop the Album link?' });

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(state.shareWrites).toEqual([]);
    expect(screen.queryByText(activeShare.url)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Album link' })).toBeVisible();
    expect(invoking).toHaveFocus();
  });

  it('sends nothing when the host keeps sharing and puts the host back where they were', async () => {
    const { state, fetchMock } = sharedAlbum();
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    const invoking = await screen.findByRole('button', { name: 'Stop Album link' });
    await user.click(invoking);

    await user.click(await screen.findByRole('button', { name: 'Keep sharing' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(state.shareWrites).toEqual([]);
    expect(screen.queryByText(activeShare.url)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Album link' })).toBeVisible();
    expect(invoking).toHaveFocus();
  });

  it('makes the destructive answer an explicit button, and two taps one revocation', async () => {
    const stop = deferred();
    const { state, fetchMock } = sharedAlbum({ shareGates: [stop.promise] });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Stop Album link' }));

    const destructive = within(await screen.findByRole('alertdialog', { name: 'Stop the Album link?' }))
      .getByRole('button', { name: 'Stop Album link' });
    // Never a dialog default submit: an explicit button, with no form to submit to.
    expect(destructive).toHaveAttribute('type', 'button');
    expect(destructive.closest('form')).toBeNull();

    await user.click(destructive);
    await user.click(destructive);

    expect(state.shareWrites).toEqual(['stop']);
    await act(async () => { stop.resolve(); });
    await waitFor(() => expect(screen.queryByText(activeShare.url)).not.toBeInTheDocument());
    expect(state.shareWrites).toEqual(['stop']);
  });

  it('clears the credential, announces it, leaves the album, and offers a new link', async () => {
    const { state, fetchMock } = sharedAlbum();
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Stop Album link' }));

    await user.click(within(await screen.findByRole('alertdialog', { name: 'Stop the Album link?' }))
      .getByRole('button', { name: 'Stop Album link' }));

    await waitFor(() => expect(state.shareWrites).toEqual(['stop']));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByText(activeShare.url)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy Album link' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-gallery-live-host] [role="status"]')).toHaveTextContent(
      'The Album link was stopped. People with the old link cannot open it now, and the Album itself is unchanged.',
    );
    // The album itself is untouched, and a replacement link is one action away.
    expect(screen.getByRole('button', { name: 'Remove p1.jpg from Album' })).toBeEnabled();
    expect(state.orderWrites).toEqual([]);
    const replacement = screen.getByRole('button', { name: 'Create Album link' });
    expect(replacement).toBeEnabled();
    expect(replacement).toHaveFocus();
  });

  it('lands on the sharing heading when there is nothing left to share', async () => {
    const { state, fetchMock } = sharedAlbum({ galleryRows: [] });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Stop Album link' }));

    await user.click(within(await screen.findByRole('alertdialog', { name: 'Stop the Album link?' }))
      .getByRole('button', { name: 'Stop Album link' }));

    await waitFor(() => expect(state.shareWrites).toEqual(['stop']));
    expect(screen.getByRole('button', { name: 'Create Album link' })).toBeDisabled();
    expect(screen.getByText('When the Album is right')).toHaveFocus();
  });

  it('uses the Album link fallback and keeps the host in the dialog when revocation fails', async () => {
    const { fetchMock } = sharedAlbum({
      shareRejects: [true],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Stop Album link' }));

    await user.click(within(await screen.findByRole('alertdialog', { name: 'Stop the Album link?' }))
      .getByRole('button', { name: 'Stop Album link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The Album link could not be stopped.');
    expect(screen.getByRole('alertdialog', { name: 'Stop the Album link?' })).toBeVisible();
    expect(screen.queryByText(activeShare.url)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Album link' })).toBeVisible();
  });
});

describe('canonical Album inverse client', () => {
  const albumMetadata = {
    title: 'Maya & Theo',
    description: 'The photographs we kept together.',
  } as const;

  function inverseState(
    revision: number,
    entries: AlbumEntryInput[],
    overrides: Partial<Pick<AlbumInverseState, 'saved' | 'title' | 'description' | 'coverMediaId'>> = {},
  ): AlbumInverseState {
    return {
      revision,
      saved: true,
      entries,
      ...albumMetadata,
      coverMediaId: null,
      ...overrides,
    };
  }

  function orderScenario(stage: 'forward' | 'restored' = 'forward') {
    const p1 = photo('inverse-p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('inverse-p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const section = { kind: 'section' as const, id: 'section-a', heading: 'Dancing' };
    const forward = inverseState(4, [
      { kind: 'photo', mediaId: p2.id },
      { kind: 'photo', mediaId: p1.id },
    ]);
    const restored = inverseState(5, [
      { kind: 'photo', mediaId: p1.id },
      section,
      { kind: 'photo', mediaId: p2.id },
    ], { coverMediaId: p1.id });
    const payload: AlbumInversePayload = { kind: 'order', forward, restored };
    const controlled = harness({
      galleryRows: [p1, p2],
      album: stage === 'forward' ? {
        revision: forward.revision,
        saved: forward.saved,
        entries: [
          { kind: 'photo', photo: p2 },
          { kind: 'photo', photo: p1 },
        ],
        ...albumMetadata,
        coverMediaId: forward.coverMediaId,
      } : {
        revision: restored.revision,
        saved: restored.saved,
        entries: [
          { kind: 'photo', photo: p1 },
          section,
          { kind: 'photo', photo: p2 },
        ],
        ...albumMetadata,
        coverMediaId: restored.coverMediaId,
      },
    });
    return { ...controlled, forward, restored, payload, p1, p2 };
  }

  function membershipOrderScenario(stage: 'forward' | 'membership-restored' | 'restored' = 'forward') {
    const p1 = photo('inverse-p1', '2026-08-15T22:42:00.000Z', {
      isFavorite: stage !== 'forward',
    });
    const p2 = photo('inverse-p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const section = { kind: 'section' as const, id: 'section-a', heading: 'Dancing' };
    const forward = inverseState(8, [{ kind: 'photo', mediaId: p2.id }]);
    const membershipRestored = inverseState(8, [
      { kind: 'photo', mediaId: p2.id },
      { kind: 'photo', mediaId: p1.id },
    ]);
    const restored = inverseState(9, [
      { kind: 'photo', mediaId: p1.id },
      section,
      { kind: 'photo', mediaId: p2.id },
    ], { coverMediaId: p1.id });
    const payload: AlbumInversePayload = {
      kind: 'membership-order',
      mediaIds: [p1.id],
      forward,
      membershipRestored,
      restored,
    };
    const controlled = harness({
      galleryRows: [p1, p2],
      album: stage === 'restored' ? {
        revision: restored.revision,
        saved: restored.saved,
        entries: [
          { kind: 'photo', photo: p1 },
          section,
          { kind: 'photo', photo: p2 },
        ],
        ...albumMetadata,
        coverMediaId: restored.coverMediaId,
      } : {
        revision: forward.revision,
        saved: forward.saved,
        // Membership restoration resolves p1 by appending it, but does not change
        // the stored order until the inverse's second phase succeeds.
        entries: [{ kind: 'photo', photo: p2 }],
        ...albumMetadata,
        coverMediaId: null,
      },
    });
    return { ...controlled, forward, membershipRestored, restored, payload, p1, p2 };
  }

  it('restores an exact order-only forward state and verifies the returned Album', async () => {
    const { state, fetchMock, payload, restored } = orderScenario();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAlbumInverse('event-a', payload);

    expect(state.pickWrites).toEqual([]);
    expect(state.orderRevisions).toEqual([payload.forward.revision]);
    expect(state.orderWrites[0]?.map(writtenEntryId)).toEqual(['inverse-p1', 'section-a', 'inverse-p2']);
    expect(state.metadataWrites[0]).toEqual({
      ...albumMetadata,
      coverMediaId: 'inverse-p1',
    });
    expect({
      revision: result.album.revision,
      saved: result.album.saved,
      entries: toEntryInput(result.album.entries),
      title: result.album.title,
      description: result.album.description,
      coverMediaId: result.album.coverMediaId,
    }).toEqual(restored);
  });

  it('treats an already-restored state after a lost response as success without another write', async () => {
    const { state, fetchMock, payload, restored } = orderScenario('restored');
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAlbumInverse('event-a', payload);

    expect(result.album.revision).toBe(restored.revision);
    expect(state.pickWrites).toEqual([]);
    expect(state.orderWrites).toEqual([]);
  });

  const unrelatedCanonicalStates: Array<[
    string,
    (scenario: ReturnType<typeof orderScenario>) => void,
  ]> = [
    ['revision', (scenario) => { scenario.state.album.revision = 40; }],
    ['saved flag', (scenario) => { scenario.state.album.saved = false; }],
    ['serialized entries', (scenario) => {
      scenario.state.album.entries = [
        { kind: 'photo', photo: scenario.p1 },
        { kind: 'photo', photo: scenario.p2 },
      ];
    }],
    ['title', (scenario) => { scenario.state.album.title = 'A newer title.'; }],
    ['description', (scenario) => {
      scenario.state.album.description = 'A newer description from another edit.';
    }],
    ['cover', (scenario) => { scenario.state.album.coverMediaId = scenario.p1.id; }],
  ];

  it.each(unrelatedCanonicalStates)(
    'fails closed before any write when the canonical %s is unrelated',
    async (_field, mutate) => {
      const scenario = orderScenario();
      mutate(scenario);
      vi.stubGlobal('fetch', scenario.fetchMock);

      await expect(runAlbumInverse('event-a', scenario.payload)).rejects.toThrow();

      expect(scenario.state.pickWrites).toEqual([]);
      expect(scenario.state.orderWrites).toEqual([]);
    },
  );

  it('restores membership, exact order, sections, metadata, and cover in two canonical phases', async () => {
    const { state, fetchMock, payload, restored } = membershipOrderScenario();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAlbumInverse('event-a', payload);

    expect(state.pickWrites).toEqual([{ mediaIds: ['inverse-p1'], picked: true }]);
    expect(state.orderRevisions).toEqual([8]);
    expect(state.orderWrites[0]?.map(writtenEntryId)).toEqual(['inverse-p1', 'section-a', 'inverse-p2']);
    expect({
      revision: result.album.revision,
      entries: toEntryInput(result.album.entries),
      coverMediaId: result.album.coverMediaId,
    }).toEqual({
      revision: restored.revision,
      entries: restored.entries,
      coverMediaId: restored.coverMediaId,
    });
  });

  it('Retry resumes from exact restored membership without repeating the pick write', async () => {
    const scenario = membershipOrderScenario();
    scenario.state.orderErrors = ['The order write did not complete.'];
    vi.stubGlobal('fetch', scenario.fetchMock);

    await expect(runAlbumInverse('event-a', scenario.payload)).rejects.toThrow();
    expect(scenario.state.pickWrites).toHaveLength(1);
    expect(scenario.state.orderWrites).toHaveLength(1);

    const result = await runAlbumInverse('event-a', scenario.payload);

    expect(result.album.revision).toBe(scenario.restored.revision);
    expect(scenario.state.pickWrites).toHaveLength(1);
    expect(scenario.state.orderWrites).toHaveLength(2);
    expect(scenario.state.orderRevisions).toEqual([8, 8]);
  });

  it('Retry classifies a lost membership response and does not repeat the accepted pick', async () => {
    const scenario = membershipOrderScenario();
    let loseMembershipResponse = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await scenario.fetchMock(input, init);
      const url = new URL(String(input), 'https://candidary.test');
      if (loseMembershipResponse && url.pathname.endsWith('/album/picks') && init?.method === 'POST') {
        loseMembershipResponse = false;
        throw new TypeError('Failed to fetch');
      }
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runAlbumInverse('event-a', scenario.payload)).rejects.toThrow('Failed to fetch');
    expect(scenario.state.pickWrites).toHaveLength(1);
    expect(scenario.state.orderWrites).toHaveLength(0);

    const result = await runAlbumInverse('event-a', scenario.payload);

    expect(result.album.revision).toBe(scenario.restored.revision);
    expect(scenario.state.pickWrites).toHaveLength(1);
    expect(scenario.state.orderWrites).toHaveLength(1);
  });

  it('Retry classifies a lost order response as restored and sends no duplicate write', async () => {
    const scenario = membershipOrderScenario();
    let loseOrderResponse = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await scenario.fetchMock(input, init);
      const url = new URL(String(input), 'https://candidary.test');
      if (loseOrderResponse && url.pathname.endsWith('/album') && init?.method === 'PUT') {
        loseOrderResponse = false;
        throw new TypeError('Failed to fetch');
      }
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runAlbumInverse('event-a', scenario.payload)).rejects.toThrow('Failed to fetch');
    expect(scenario.state.pickWrites).toHaveLength(1);
    expect(scenario.state.orderWrites).toHaveLength(1);

    const result = await runAlbumInverse('event-a', scenario.payload);

    expect(result.album.revision).toBe(scenario.restored.revision);
    expect(scenario.state.pickWrites).toHaveLength(1);
    expect(scenario.state.orderWrites).toHaveLength(1);
  });

  it('restores a membership-only inverse against the exact canonical projection', async () => {
    const p1 = photo('inverse-p1', '2026-08-15T22:42:00.000Z');
    const p2 = photo('inverse-p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const forward = inverseState(6, [{ kind: 'photo', mediaId: p2.id }]);
    const restored = inverseState(6, [
      { kind: 'photo', mediaId: p1.id },
      { kind: 'photo', mediaId: p2.id },
    ]);
    const payload: AlbumInversePayload = {
      kind: 'membership',
      mediaIds: [p1.id],
      forward,
      restored,
    };
    const { state, fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 6,
        saved: true,
        // The stored slot survives the direct unpick even though the forward view omits it.
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
        ],
        ...albumMetadata,
        coverMediaId: null,
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAlbumInverse('event-a', payload);

    expect(state.pickWrites).toEqual([{ mediaIds: ['inverse-p1'], picked: true }]);
    expect(state.orderWrites).toEqual([]);
    expect(toEntryInput(result.album.entries)).toEqual(restored.entries);
  });

  it('falls back to a canonical fetch when a write returns a non-restored Album view', async () => {
    const scenario = orderScenario();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await scenario.fetchMock(input, init);
      const url = new URL(String(input), 'https://candidary.test');
      if (!url.pathname.endsWith('/album') || init?.method !== 'PUT') return response;
      const payload = await response.json() as { data: { album: AlbumView } };
      return success({
        album: {
          ...payload.data.album,
          description: 'A stale response projection.',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAlbumInverse('event-a', scenario.payload);

    expect(result.album.description).toBe(scenario.restored.description);
    expect(scenario.state.albumReads).toBe(2);
    expect(scenario.state.orderWrites).toHaveLength(1);
  });
});
