export const LONG_FILENAME = `IMG_${'A'.repeat(80)}.HEIC`;
export const UNBROKEN_TOKEN = 'https://candidary.example/'.concat('x'.repeat(110));
// A guest note the browser has no opportunity to break: 80 characters with no space, hyphen, or slash.
export const UNBROKEN_NOTE = 'W'.repeat(80);

// An unpublished photo is the one the host acts on most: it is the Gallery's default filter, and it
// carries every card control at once — download, publish, hide, and delete.
type PublicationStatus = 'published' | 'unpublished' | 'hidden';

export function makeMedia(count: number, publicationStatus: PublicationStatus = 'published') {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    originalFilename: index === 0 ? LONG_FILENAME : `moment-${index + 1}.jpg`,
    guestName: 'Avery Stone',
    caption: index === 0 ? LONG_FILENAME : `Moment ${index + 1}`,
    publicationStatus,
    uploadState: 'stored' as const,
    width: 1200,
    height: 900,
    createdAt: new Date(Date.UTC(2026, 6, 27, 12, 0, index)).toISOString(),
  }));
}
