export const LONG_FILENAME = `IMG_${'A'.repeat(80)}.HEIC`;
export const UNBROKEN_TOKEN = 'https://candidary.example/'.concat('x'.repeat(110));
// A guest note the browser has no opportunity to break: 80 characters with no space, hyphen, or slash.
export const UNBROKEN_NOTE = 'W'.repeat(80);
export const LONG_WELCOME = `Share the night as you saw it, from every table and every corner. ${UNBROKEN_TOKEN} `
  .padEnd(500, 'We will treasure every frame you send. ');
// A valid 182-character disclosure fixture that naturally realizes the documented 390 x 420 hero
// raster when expanded. The separate responsive matrix retains maximum-length welcome coverage.
export const NATURAL_420_WELCOME = 'Share every bright moment you notice tonight, from quiet smiles and happy tears '
  + 'to dance-floor joy. We would love to see the celebration through your eyes and keep each memory close.';
// The product maximum for a household label or an invitee name, with no space the
// browser could break at. Anything narrower than this has to wrap it anyway.
export const LONG_RSVP_NAME = `Alexandra${'-Mackenzie'.repeat(7)}`.slice(0, 80);
export const TEST_NOTE = {
  id: 'message-a',
  guestName: 'Rowan',
  body: 'To a lifetime of noticing the little things.',
  moderationStatus: 'approved' as const,
  createdAt: '2026-09-19T20:00:00Z',
};

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
