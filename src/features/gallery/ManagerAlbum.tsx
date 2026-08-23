import { ArrowDown, ArrowUp, BookOpen, ImageOff, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ClientApiError, mediaPreview } from '../../app/api';
import type { ExportDownloadView, ExportView } from '../../app/types';
import { ErrorState, LoadingState } from '../../components/States';
import { ALBUM_MAX_SECTIONS, ALBUM_SECTION_HEADING_MAX_LENGTH } from '../../../shared/constants';
import type { AlbumEntryView, AlbumView, EventView } from '../../../shared/contracts';
import { fetchAlbum, moveEntry, saveAlbumOrder, setAlbumPicks, startAlbum, toEntryInput } from './album-api';
import { AlbumPreview } from './AlbumPreview';
import { AlbumExportControl } from './AlbumExportControl';
import { galleryPhotoTitle } from './gallery-timeline';
import { UndoBar, useUndo } from './undo';

interface ManagerAlbumProps {
  event: EventView;
  eventId: string;
  active: boolean;
  /** Raised whenever membership changes here, so Library's `Album picks (n)` stays true. */
  onPicksChanged(): void;
  exportJob?: ExportView;
  activeExport?: ExportView;
  exportDownload?: ExportDownloadView;
  onPrepareExport(): Promise<void>;
  onDownloadExport(job: ExportView): Promise<void>;
  onRetryExport(job: ExportView): Promise<void>;
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof ClientApiError ? caught.message : fallback;
}

function entryKey(entry: AlbumEntryView): string {
  return entry.kind === 'section' ? `section:${entry.id}` : `photo:${entry.photo.id}`;
}

function entryName(entry: AlbumEntryView): string {
  return entry.kind === 'section' ? entry.heading : galleryPhotoTitle(entry.photo);
}

/**
 * The album: the host's one curated artifact for this event.
 *
 * Membership lives in the pick bit and order lives here, which is what lets a host pick
 * liberally in Library and prune in this grid. Nothing on this surface publishes: the
 * copy says so at the top, in the tray, and in the empty state, because a curated album
 * that quietly became guest-visible is the single worst failure this product could have.
 */
export function ManagerAlbum({
  event,
  eventId,
  active,
  onPicksChanged,
  exportJob,
  activeExport,
  exportDownload,
  onPrepareExport,
  onDownloadExport,
  onRetryExport,
}: ManagerAlbumProps) {
  const [album, setAlbum] = useState<AlbumView | null>(null);
  const [entries, setEntries] = useState<AlbumEntryView[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pendingPickIds, setPendingPickIds] = useState<ReadonlySet<string>>(() => new Set());

  const undo = useUndo();
  const loadGeneration = useRef(0);
  const savingRef = useRef(false);
  const pendingOrder = useRef<AlbumEntryView[] | null>(null);
  const saveCycle = useRef<Promise<void> | null>(null);
  const canonicalLoad = useRef<Promise<void> | null>(null);
  const canonicalOrderTrusted = useRef(false);
  const listRef = useRef<HTMLOListElement>(null);
  const refocusKey = useRef<string | null>(null);
  const previewOrigin = useRef<HTMLElement | null>(null);
  const hasLoaded = useRef(false);

  const adopt = useCallback((next: AlbumView) => {
    setAlbum(next);
    setRevision(next.revision);
    // Only when the host has nothing in flight. Replacing the list under an unsaved drag
    // would undo the move they are still watching.
    if (pendingOrder.current === null && !savingRef.current) setEntries(next.entries);
  }, []);

  const loadCanonical = useCallback((signal?: AbortSignal) => {
    const generation = ++loadGeneration.current;
    canonicalOrderTrusted.current = false;
    setLoading(true);
    setLoadFailure(null);
    const cycle = (async () => {
      try {
        const result = await fetchAlbum(eventId, signal);
        if (generation !== loadGeneration.current) return;
        hasLoaded.current = true;
        setAlbum(result.album);
        setRevision(result.album.revision);
        setEntries(result.album.entries);
        canonicalOrderTrusted.current = true;
      } catch (caught) {
        if (generation !== loadGeneration.current) return;
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          setLoadFailure(errorMessage(caught, 'The album could not be loaded.'));
        }
        throw caught;
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
      }
    })();
    canonicalLoad.current = cycle;
    void cycle.then(() => {
      if (canonicalLoad.current === cycle) canonicalLoad.current = null;
    }, () => {
      if (canonicalLoad.current === cycle) canonicalLoad.current = null;
    });
    return cycle;
  }, [eventId]);

  const load = useCallback(() => {
    const controller = new AbortController();
    void loadCanonical(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [loadCanonical]);

  useEffect(() => {
    if (!active) return;
    return load();
  }, [active, load]);

  /**
   * One save in flight at a time, with the newest arrangement coalesced behind it. Firing
   * a request per keystroke or per tap would race the revision guard against itself and
   * refuse the host's own edits as a conflict.
   */
  const commit = useCallback((next: AlbumEntryView[]) => {
    if (savingRef.current) {
      pendingOrder.current = next;
      return;
    }
    canonicalOrderTrusted.current = false;
    savingRef.current = true;
    setSaving(true);
    const run = async () => {
      let order = next;
      let composedAgainst = revision;
      try {
        for (;;) {
          const result = await saveAlbumOrder(eventId, composedAgainst, toEntryInput(order));
          setAlbum(result.album);
          setRevision(result.album.revision);
          const queued = pendingOrder.current;
          if (!queued) {
            setEntries(result.album.entries);
            canonicalOrderTrusted.current = true;
            return;
          }
          pendingOrder.current = null;
          order = queued;
          composedAgainst = result.album.revision;
        }
      } catch (caught) {
        pendingOrder.current = null;
        setNotice(errorMessage(caught, 'The album order could not be saved.'));
        try {
          // Keep the save drain pending until stored canonical order is known.
          // A failed reload leaves the surface untrusted and its retry joins the
          // same preparation barrier below.
          await loadCanonical();
        } catch {
          // loadCanonical owns the recovery UI; the original save still rejects.
        }
        throw caught;
      } finally {
        savingRef.current = false;
        setSaving(false);
        if (saveCycle.current === cycle) saveCycle.current = null;
      }
    };
    const cycle = run();
    saveCycle.current = cycle;
    // The control consumes a rejection from `drainOrderSaves`; this fallback also
    // handles a save failure when no export is waiting without an unhandled promise.
    void cycle.catch(() => {});
  }, [eventId, loadCanonical, revision]);

  const drainOrderSaves = useCallback(async () => {
    for (;;) {
      const current = saveCycle.current;
      if (!current) return;
      await current;
    }
  }, []);

  const prepareAlbumExport = useCallback(async () => {
    try {
      await drainOrderSaves();
      const loadingCanonical = canonicalLoad.current;
      if (loadingCanonical) await loadingCanonical;
      if (!canonicalOrderTrusted.current) await loadCanonical();
    } catch {
      // Save and load paths have already surfaced the failure. Never snapshot an
      // order until the canonical reload barrier has completed successfully.
      return;
    }
    await onPrepareExport();
  }, [drainOrderSaves, loadCanonical, onPrepareExport]);

  function rearrange(next: AlbumEntryView[], message: string) {
    setEntries(next);
    setAnnouncement(message);
    commit(next);
  }

  function move(index: number, delta: -1 | 1) {
    const entry = entries[index];
    if (!entry) return;
    const next = moveEntry(entries, index, delta);
    if (next.length === entries.length && next[index] === entry) return;
    refocusKey.current = entryKey(entry);
    rearrange(
      next,
      `${entryName(entry)} moved ${delta === -1 ? 'up' : 'down'} to position ${index + delta + 1} of ${entries.length}.`,
    );
  }

  // Focus follows the entry, not the position. Moving with the buttons otherwise leaves
  // the host on whatever swapped into the slot they just left, and a second press sends
  // the wrong thing the other way.
  useEffect(() => {
    const key = refocusKey.current;
    if (!key) return;
    refocusKey.current = null;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-entry-key="${CSS.escape(key)}"] .album-entry__move-up`)
      ?.focus();
  }, [entries]);

  function addSection() {
    if (entries.filter((entry) => entry.kind === 'section').length >= ALBUM_MAX_SECTIONS) {
      setNotice(`An album holds up to ${ALBUM_MAX_SECTIONS} sections.`);
      return;
    }
    const section: AlbumEntryView = { kind: 'section', id: crypto.randomUUID(), heading: 'New section' };
    const next = [...entries, section];
    setEntries(next);
    setAnnouncement(`Section added at position ${next.length} of ${next.length}. Name it, then move it above the photos it opens.`);
    commit(next);
    refocusKey.current = null;
    window.requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLInputElement>(`[data-entry-key="${CSS.escape(entryKey(section))}"] input`)
        ?.select();
    });
  }

  function renameSection(id: string, heading: string) {
    setEntries((current) => current.map((entry) => (
      entry.kind === 'section' && entry.id === id ? { ...entry, heading } : entry
    )));
  }

  function commitSectionName(id: string) {
    const entry = entries.find((item) => item.kind === 'section' && item.id === id);
    if (!entry || entry.kind !== 'section') return;
    const trimmed = entry.heading.trim();
    // A heading of spaces is a divider with no name. Restore the placeholder rather than
    // sending something the review grid has nowhere to draw.
    const heading = trimmed.length > 0 ? trimmed : 'New section';
    const next = entries.map((item) => (
      item.kind === 'section' && item.id === id ? { ...item, heading } : item
    ));
    setEntries(next);
    commit(next);
  }

  function removeSection(id: string) {
    const index = entries.findIndex((entry) => entry.kind === 'section' && entry.id === id);
    const removed = entries[index];
    if (!removed || removed.kind !== 'section') return;
    const next = entries.filter((_, position) => position !== index);
    rearrange(next, `Section ${removed.heading} removed. No photos were removed.`);
    undo.present({
      message: `Section "${removed.heading}" removed. No photos were removed.`,
      run: async () => {
        const restored = [...entries.slice(0, index), removed, ...entries.slice(index)];
        setEntries(restored);
        setAnnouncement(`Section ${removed.heading} restored.`);
        commit(restored);
      },
    });
  }

  async function removePhoto(entry: Extract<AlbumEntryView, { kind: 'photo' }>) {
    const photoId = entry.photo.id;
    if (pendingPickIds.has(photoId)) return;
    setPendingPickIds((current) => new Set(current).add(photoId));
    const title = galleryPhotoTitle(entry.photo);
    try {
      try {
        await setAlbumPicks(eventId, [photoId], false);
      } catch (caught) {
        setNotice(errorMessage(caught, 'That photo could not be removed from the album.'));
        return;
      }
      setEntries((current) => current.filter((item) => (
        item.kind !== 'photo' || item.photo.id !== photoId
      )));
      setAnnouncement(`${title} removed from the album. The original is still delivered.`);
      undo.present({
        message: '1 photo removed from the album. The original is still delivered.',
        run: async () => {
          await setAlbumPicks(eventId, [photoId], true);
          onPicksChanged();
          setAnnouncement(`${title} is back in the album.`);
          load();
        },
      });
      try {
        const refreshed = await fetchAlbum(eventId);
        // The response is authoritative: another manager may already have
        // repicked the photo while this refresh was in flight.
        adopt(refreshed.album);
      } catch {
        setNotice('The photo was removed, but the album could not be refreshed. Use Undo or try again in a moment.');
      }
      onPicksChanged();
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
    setStarting(true);
    try {
      const result = await startAlbum(eventId, start);
      adopt(result.album);
      setEntries(result.album.entries);
      onPicksChanged();
      if (start === 'empty') {
        const count = result.cleared.length;
        setAnnouncement(`Album started empty. ${count} favorite${count === 1 ? '' : 's'} cleared. Every photo is still delivered.`);
        undo.present({
          message: `${count} favorite${count === 1 ? '' : 's'} cleared. Every photo is still delivered.`,
          run: async () => {
            await setAlbumPicks(eventId, result.cleared, true);
            onPicksChanged();
            setAnnouncement('Your earlier favorites are back in the album.');
            load();
          },
        });
      } else {
        setAnnouncement(`Album started from ${result.album.photoCount} earlier favorite${result.album.photoCount === 1 ? '' : 's'}.`);
      }
    } catch (caught) {
      setNotice(errorMessage(caught, 'The album could not be started.'));
    } finally {
      setStarting(false);
    }
  }

  function openPreview(origin: HTMLElement) {
    previewOrigin.current = origin;
    setPreviewOpen(true);
  }

  function closePreview() {
    setPreviewOpen(false);
    const target = previewOrigin.current;
    previewOrigin.current = null;
    window.requestAnimationFrame(() => target?.focus());
  }

  if (loading && !hasLoaded.current) return <LoadingState label="Opening the album…" />;
  if (loadFailure) {
    return <ErrorState
      message={loadFailure}
      recoveryHint="Reload the manager to try again."
      onRetry={() => { setLoadFailure(null); load(); }}
    />;
  }

  const photoCount = entries.filter((entry) => entry.kind === 'photo').length;
  const sectionCount = entries.filter((entry) => entry.kind === 'section').length;
  const needsReconciliation = album !== null && !album.saved && photoCount > 0;

  return <div className="gallery-album">
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>

    {notice && <div className="manager-action-error" role="alert">
      <div className="manager-action-error__summary">
        <div className="manager-action-error__alert">{notice}</div>
        <button
          type="button"
          className="manager-action-error__dismiss"
          aria-label="Dismiss error"
          onClick={() => setNotice(null)}
        >Dismiss</button>
      </div>
    </div>}

    {needsReconciliation
      ? <section className="album-reconcile" aria-labelledby="album-reconcile-title">
          <h3 id="album-reconcile-title">Start your album</h3>
          <p>
            This event has {photoCount} photo{photoCount === 1 ? '' : 's'} you hearted before albums
            existed. Keep them as your first picks, or start with an empty album. Either way every
            photo stays delivered, and neither choice publishes anything to guests.
          </p>
          <div className="album-reconcile__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={starting}
              onClick={() => void choose('from-picks')}
            >Start from these {photoCount}</button>
            <button
              type="button"
              className="button button--secondary"
              disabled={starting}
              onClick={() => void choose('empty')}
            >Start empty</button>
          </div>
        </section>
      : <>
          <div className="album-header">
            <div className="album-header__counts">
              <p className="album-header__total">
                {photoCount} photo{photoCount === 1 ? '' : 's'}
                {sectionCount > 0 && ` · ${sectionCount} section${sectionCount === 1 ? '' : 's'}`}
              </p>
            </div>
            <div className="album-header__actions">
              <button
                type="button"
                className="button button--secondary"
                disabled={photoCount === 0}
                onClick={(pressed) => openPreview(pressed.currentTarget)}
              ><BookOpen aria-hidden="true" /> Preview album</button>
              <button
                type="button"
                className="button button--secondary"
                onClick={addSection}
              ><Plus aria-hidden="true" /> Add section</button>
            </div>
            <p className="sr-only" role="status" aria-live="polite">{saving ? 'Saving the album order…' : ''}</p>
          </div>

          <AlbumExportControl
            photoCount={photoCount}
            totalBytes={album?.totalBytes ?? 0}
            job={exportJob}
            activeJob={activeExport}
            download={exportDownload}
            onPrepare={prepareAlbumExport}
            onDownload={onDownloadExport}
            onRetry={onRetryExport}
          />

          {entries.length === 0
            ? <div className="empty-state">
                <BookOpen aria-hidden="true" />
                <h3>Your album is empty.</h3>
                <p>
                  In Library, choose <strong>Album picks</strong> on any photo to add it here. Picking
                  a photo never publishes it — the shared gallery stays exactly as you left it.
                </p>
              </div>
            : <ol className="album-list" ref={listRef}>
                {entries.map((entry, index) => {
                  const key = entryKey(entry);
                  const name = entryName(entry);
                  const position = `${index + 1} of ${entries.length}`;
                  return <li
                    key={key}
                    data-entry-key={key}
                    className={entry.kind === 'section' ? 'album-entry album-entry--section' : 'album-entry'}
                  >
                    {entry.kind === 'section'
                      ? <div className="album-section">
                          <label className="sr-only" htmlFor={`album-section-${entry.id}`}>
                            Section name
                          </label>
                          <input
                            id={`album-section-${entry.id}`}
                            className="album-section__input"
                            value={entry.heading}
                            maxLength={ALBUM_SECTION_HEADING_MAX_LENGTH}
                            onChange={(change) => renameSection(entry.id, change.target.value)}
                            onBlur={() => commitSectionName(entry.id)}
                            onKeyDown={(pressed) => {
                              if (pressed.key === 'Enter') {
                                pressed.preventDefault();
                                pressed.currentTarget.blur();
                              }
                            }}
                          />
                        </div>
                      : <div className="album-photo">
                          {entry.photo.previewAvailable
                            ? <img
                                src={mediaPreview(entry.photo.id)}
                                alt=""
                                width={entry.photo.width ?? undefined}
                                height={entry.photo.height ?? undefined}
                                loading={index < 6 ? 'eager' : 'lazy'}
                                decoding="async"
                              />
                            : <div className="album-photo__placeholder">
                                <ImageOff aria-hidden="true" />
                                <span>Preview unavailable</span>
                              </div>}
                          <div className="album-photo__meta">
                            <strong title={name}>{name}</strong>
                            <small>From {entry.photo.guestName}</small>
                          </div>
                        </div>}

                    <div className="album-entry__controls">
                      <button
                        type="button"
                        className="album-entry__move-up"
                        disabled={index === 0}
                        aria-label={`Move ${name} up. Currently ${position}.`}
                        onClick={() => move(index, -1)}
                      ><ArrowUp aria-hidden="true" /></button>
                      <button
                        type="button"
                        className="album-entry__move-down"
                        disabled={index === entries.length - 1}
                        aria-label={`Move ${name} down. Currently ${position}.`}
                        onClick={() => move(index, 1)}
                      ><ArrowDown aria-hidden="true" /></button>
                      {entry.kind === 'section'
                        ? <button
                            type="button"
                            className="album-entry__remove"
                            aria-label={`Remove section ${name}`}
                            onClick={() => removeSection(entry.id)}
                          ><Trash2 aria-hidden="true" /></button>
                        : <button
                            type="button"
                            className="album-entry__remove"
                            disabled={pendingPickIds.has(entry.photo.id)}
                            aria-label={`Remove ${name} from the album`}
                            onClick={() => void removePhoto(entry)}
                          ><Trash2 aria-hidden="true" /></button>}
                    </div>
                  </li>;
                })}
              </ol>}
        </>}

    <UndoBar controller={undo} />

    {previewOpen && <AlbumPreview
      entries={entries}
      eventName={event.name}
      onClose={closePreview}
    />}
  </div>;
}
