import { useCallback, useEffect, useRef, useState } from 'react';

import type { PublicAlbumView } from '../../../shared/contracts';
import {
  describeLoadFailure,
  ErrorState,
  LoadingState,
  type LoadFailure,
} from '../../components/States';
import { fetchManagerAlbumPreview, managerAlbumPreviewImage } from './album-share-api';
import { PublicAlbum } from './PublicAlbum';

interface AlbumPreviewProps {
  eventId: string;
  /**
   * Read again when the saved album has moved on. The Manager passes the revision it last saved,
   * so reopening the preview after an edit cannot show the previous arrangement.
   */
  revision?: number;
  onAnnouncement?: (message: string) => void;
}

/**
 * The Album-link reading order, read back from the server rather than composed from the editor's
 * draft.
 *
 * The projection the Album link serves is the only honest answer to what people with the link see:
 * it is the one that drops a photo the host trashed, withholds an unpublished caption, and omits an
 * emptied section. Rebuilding that from the draft would be a second implementation of the rule, free
 * to disagree with the first. This preview is Manager-authenticated and is not sharing — it works
 * before a link exists and after one is stopped, and no link, token, or ciphertext reaches it.
 */
export function AlbumPreview({ eventId, revision, onAnnouncement }: AlbumPreviewProps) {
  const [album, setAlbum] = useState<PublicAlbumView | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loadGeneration = useRef(0);
  const announce = useRef(onAnnouncement);
  useEffect(() => { announce.current = onAnnouncement; });

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const controller = new AbortController();
    setAlbum(null);
    setFailure(null);
    void fetchManagerAlbumPreview(eventId, controller.signal).then(
      (result) => {
        if (generation !== loadGeneration.current) return;
        setAlbum(result.album);
        announce.current?.(result.album.photoCount === 0
          ? 'Album preview ready. No photos are In Album yet.'
          : `Album preview ready. ${result.album.photoCount} ${result.album.photoCount === 1 ? 'photo' : 'photos'}.`);
      },
      (caught: unknown) => {
        if (generation !== loadGeneration.current) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        const described = describeLoadFailure(
          caught,
          'manager',
          'The Album preview could not be loaded.',
        );
        setFailure(described);
        announce.current?.(described.message);
      },
    );

    return () => {
      loadGeneration.current += 1;
      controller.abort();
    };
  }, [attempt, eventId, revision]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  const imageSource = useCallback(
    (mediaId: string) => managerAlbumPreviewImage(eventId, mediaId),
    [eventId],
  );

  return <section className="album-preview" aria-labelledby="album-preview-title">
    <p className="section-label" id="album-preview-title">What people with the Album link see</p>
    {failure
      ? <ErrorState
          message={failure.message}
          recoveryHint={failure.recoveryHint}
          onRetry={failure.retryable ? retry : undefined}
        />
      : !album
        ? <LoadingState label="Opening the preview…" live={false} />
        : <PublicAlbum album={album} imageSource={imageSource} variant="embedded" />}
  </section>;
}
