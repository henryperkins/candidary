import type { PublicAlbumView } from '../../shared/contracts';
import { AlbumRepository } from '../db/album';

/**
 * The one public projection of an album.
 *
 * Two very different authorities read it — an album-share cookie minted from a
 * distributed link, and a signed-in Manager previewing what that link shows —
 * and the entire point of Preview is that those two see the same thing. A second
 * projection would eventually disagree with the first, and the host would be
 * checking a rehearsal instead of the performance.
 *
 * Three rules define it:
 *
 *  - only stored, untrashed, picked photos resolve. A retained slot is a Manager
 *    concept; a recipient sees the album close up around the gap;
 *  - a guest-written caption crosses this boundary only while its photo is
 *    `published`. Publication is a Guest-gallery decision, and the Album link is
 *    a different audience: `unpublished` and `hidden` photos stay eligible for
 *    the album, but their captions do not travel with them;
 *  - an album with no photos is still a valid album. The URL keeps working and
 *    the page says so, rather than 404ing at somebody's family.
 */
export class PublicAlbumService {
  private readonly albums: AlbumRepository;

  constructor(db: D1Database) {
    this.albums = new AlbumRepository(db);
  }

  async project(eventId: string, now = new Date().toISOString()): Promise<PublicAlbumView> {
    const album = await this.albums.get(eventId, now);
    const entries: PublicAlbumView['entries'] = [];
    // A section labels the following photo run. Keep it pending until a visible
    // photo actually arrives: this removes a section emptied by a retained slot,
    // collapses adjacent empty headings, and drops trailing headings without
    // inventing a second public projection.
    let pendingSection: Extract<PublicAlbumView['entries'][number], { kind: 'section' }> | null = null;
    for (const entry of album.entries) {
      if (entry.kind === 'section') {
        pendingSection = { kind: 'section', id: entry.id, heading: entry.heading };
        continue;
      }
      if (entry.kind === 'photo-retained') continue;
      if (pendingSection) {
        entries.push(pendingSection);
        pendingSection = null;
      }
      entries.push({
        kind: 'photo',
        photo: {
          id: entry.photo.id,
          caption: entry.photo.publicationStatus === 'published' ? entry.photo.caption : null,
          previewAvailable: entry.photo.previewAvailable,
        },
      });
    }
    return {
      title: album.title,
      description: album.description,
      coverMediaId: album.effectiveCoverMediaId,
      entries,
      photoCount: entries.filter((entry) => entry.kind === 'photo').length,
    };
  }

  /**
   * Whether this photo may be read through a public album surface at all.
   *
   * The projection is the authority, so an image route asks it rather than
   * re-deriving membership from the picked set — which is how a preview for a
   * trashed or unpicked photo would otherwise stay readable after it left the
   * album a recipient can see.
   */
  async includesPhoto(eventId: string, mediaId: string, now = new Date().toISOString()): Promise<boolean> {
    const album = await this.project(eventId, now);
    return album.entries.some((entry) => entry.kind === 'photo' && entry.photo.id === mediaId);
  }
}
