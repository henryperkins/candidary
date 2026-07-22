/* global console, fetch, performance, process, URL */
import { randomUUID } from 'node:crypto';

const baseUrl = process.env.CANDIDARY_LOAD_BASE_URL?.replace(/\/$/u, '');
const guestLink = process.env.CANDIDARY_LOAD_GUEST_LINK;
const guests = Number(process.env.CANDIDARY_LOAD_GUESTS ?? 500);
const photos = Number(process.env.CANDIDARY_LOAD_PHOTOS ?? 10_000);
const live = process.env.CANDIDARY_LOAD_CONFIRM === 'I_UNDERSTAND';

if (!Number.isInteger(guests) || guests < 1 || !Number.isInteger(photos) || photos < guests) {
  throw new Error('Guest and photo targets must be positive integers, with at least one photo per guest.');
}

const plan = {
  guests,
  photos,
  averagePhotosPerGuest: photos / guests,
  reservationBatches: Math.ceil(photos / 20),
  maxTransfersPerGuest: 2,
};

if (!live) {
  console.log(JSON.stringify({ mode: 'dry-run', ...plan }, null, 2));
  console.log('Set CANDIDARY_LOAD_BASE_URL, CANDIDARY_LOAD_GUEST_LINK, and CANDIDARY_LOAD_CONFIRM=I_UNDERSTAND to run against a dedicated rehearsal event.');
  process.exit(0);
}
if (!baseUrl || !guestLink) throw new Error('A base URL and dedicated rehearsal guest link are required for a live run.');

function cookies(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? ''];
  const joined = values.join('; ');
  const session = /candidary_session=([^;,]+)/u.exec(joined)?.[1];
  const csrf = /candidary_csrf=([^;,]+)/u.exec(joined)?.[1];
  if (!session || !csrf) throw new Error('Guest exchange did not return session and CSRF cookies.');
  return { cookie: `candidary_session=${session}; candidary_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

function png() {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1);
  view.setUint32(20, 1);
  return bytes;
}

async function api(path, session, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: baseUrl,
      cookie: session.cookie,
      'x-candidary-csrf': session.csrf,
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${body.code ?? response.status}: ${body.message ?? 'Request failed'}`);
  return body.data;
}

async function mapConcurrent(items, limit, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await operation(items[index], index);
    }
  });
  await Promise.all(workers);
}

const joinPath = new URL(guestLink).pathname;
const sessions = [];
await mapConcurrent(Array.from({ length: guests }), 25, async (_, index) => {
  const response = await fetch(`${baseUrl}${joinPath}`, { redirect: 'manual' });
  sessions[index] = { ...cookies(response), slug: response.headers.get('location')?.split('/').pop() };
});

let assigned = 0;
const assignments = sessions.map((session, guestIndex) => {
  const remainingGuests = guests - guestIndex;
  const count = Math.ceil((photos - assigned) / remainingGuests);
  assigned += count;
  return { session, guestIndex, count };
});
let delivered = 0;
const startedAt = performance.now();

await mapConcurrent(assignments, 25, async ({ session, guestIndex, count }) => {
  const files = Array.from({ length: count }, (_, photoIndex) => ({
    filename: `guest-${guestIndex + 1}-${photoIndex + 1}.png`,
    mimeType: 'image/png',
    byteSize: 64,
    idempotencyKey: randomUUID(),
  }));
  for (let offset = 0; offset < files.length; offset += 20) {
    const data = await api(`/api/event/${session.slug}/uploads/batch`, session, {
      method: 'POST', body: JSON.stringify({ guestName: `Load Guest ${guestIndex + 1}`, files: files.slice(offset, offset + 20) }),
    });
    const accepted = data.items.filter((item) => item.status === 'accepted');
    if (accepted.length !== data.items.length) throw new Error(`A rehearsal batch rejected ${data.items.length - accepted.length} photos.`);
    await mapConcurrent(accepted, 2, async (item) => {
      const upload = await fetch(item.uploadUrl, { method: 'PUT', headers: { 'content-type': item.media.mimeType }, body: png() });
      if (!upload.ok) throw new Error(`R2 PUT failed with ${upload.status}.`);
      await api(`/api/event/${session.slug}/uploads/${item.media.id}/finalize`, session, { method: 'POST', body: '{}' });
      delivered += 1;
      if (delivered % 250 === 0) console.log(`Delivered ${delivered}/${photos}`);
    });
  }
});

console.log(JSON.stringify({
  mode: 'live',
  ...plan,
  delivered,
  elapsedSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(2)),
}, null, 2));
