import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import {
  applySettings,
  eventAccess,
  resetDatabase,
  testEnv,
  trashMedia,
  uploadPending,
  writeHeaders,
} from './helpers';

beforeEach(resetDatabase);

type Access = Awaited<ReturnType<typeof eventAccess>>;

interface SummaryBody {
  data: {
    summary: {
      albumPhotoCount: number;
      albumEntryCount: number;
      albumLink: { active: boolean; sharedAt: string | null };
      guestGalleryVisible: boolean;
      guestGalleryPublishedCount: number;
    };
  };
  requestId: string;
}

function summary(access: Access) {
  return createApp().request(`/api/manage/events/${access.event.id}/gallery/summary`, {
    headers: { cookie: access.manager.cookie },
  }, testEnv);
}

function albumShare(access: Access, method: 'POST' | 'DELETE') {
  return createApp().request(`/api/manage/events/${access.event.id}/album/share`, {
    method,
    headers: writeHeaders(access.manager),
  }, testEnv);
}

async function publish(access: Access, mediaId: string) {
  const response = await createApp().request(`/api/manage/events/${access.event.id}/media/${mediaId}`, {
    method: 'PATCH',
    headers: writeHeaders(access.manager),
    body: JSON.stringify({ action: 'publish', expectedStatus: 'unpublished' }),
  }, testEnv);
  expect(response.status).toBe(200);
}

async function pick(access: Access, mediaId: string) {
  const response = await createApp().request(`/api/manage/events/${access.event.id}/media/${mediaId}/favorite`, {
    method: 'PUT',
    headers: writeHeaders(access.manager),
    body: JSON.stringify({ favorite: true }),
  }, testEnv);
  expect(response.status).toBe(200);
}

async function deleteOwnUpload(access: Access, mediaId: string) {
  const response = await createApp().request(`/api/event/${access.event.slug}/uploads/${mediaId}`, {
    method: 'DELETE',
    headers: writeHeaders(access.guest),
  }, testEnv);
  expect(response.status).toBe(200);
}

async function saveAlbum(access: Access, entries: unknown[]) {
  const response = await createApp().request(`/api/manage/events/${access.event.id}/album`, {
    method: 'PUT',
    headers: writeHeaders(access.manager),
    body: JSON.stringify({ revision: 0, entries }),
  }, testEnv);
  expect(response.status).toBe(200);
}

describe('manager gallery audience summary', () => {
  it('reports the credential-free audience state with exact private fields', async () => {
    const access = await eventAccess();
    const visible = await applySettings(access, { galleryVisible: true });
    expect(visible.status).toBe(200);
    access.event = (await visible.json<{ data: { event: typeof access.event } }>()).data.event;

    const activePick = await uploadPending(access, 'summary-active-pick');
    const recoverablePick = await uploadPending(access, 'summary-recoverable-pick');
    const staleUnpicked = await uploadPending(access, 'summary-stale-unpicked');
    await uploadPending(access, 'summary-active-unpublished');
    const deletedPublished = await uploadPending(access, 'summary-deleted-published');

    await publish(access, activePick.id);
    await pick(access, activePick.id);
    await publish(access, recoverablePick.id);
    await pick(access, recoverablePick.id);
    await trashMedia(access, recoverablePick.id);
    await publish(access, deletedPublished.id);
    await deleteOwnUpload(access, deletedPublished.id);
    await saveAlbum(access, [
      { kind: 'photo', mediaId: activePick.id },
      { kind: 'section', id: 'ceremony', heading: 'Ceremony' },
      { kind: 'photo', mediaId: recoverablePick.id },
      { kind: 'photo', mediaId: staleUnpicked.id },
    ]);

    const enabled = await albumShare(access, 'POST');
    expect(enabled.status).toBe(200);

    const active = await summary(access);
    expect(active.status).toBe(200);
    expect(active.headers.get('cache-control')).toBe('private, no-store');
    expect(active.headers.get('vary')).toContain('Cookie');
    const activeBody = await active.json<SummaryBody>();
    expect(Object.keys(activeBody.data)).toEqual(['summary']);
    expect(Object.keys(activeBody.data.summary)).toEqual([
      'albumPhotoCount',
      'albumEntryCount',
      'albumLink',
      'guestGalleryVisible',
      'guestGalleryPublishedCount',
    ]);
    expect(Object.keys(activeBody.data.summary.albumLink)).toEqual(['active', 'sharedAt']);
    expect(activeBody.data.summary).toEqual({
      albumPhotoCount: 1,
      albumEntryCount: 3,
      albumLink: { active: true, sharedAt: expect.any(String) },
      guestGalleryVisible: true,
      guestGalleryPublishedCount: 1,
    });
    expect(JSON.stringify(activeBody)).not.toMatch(/url|secret|ciphertext|digest/iu);

    const stopped = await albumShare(access, 'DELETE');
    expect(stopped.status).toBe(200);
    const inactive = await summary(access);
    expect(inactive.status).toBe(200);
    expect((await inactive.json<SummaryBody>()).data.summary.albumLink).toEqual({
      active: false,
      sharedAt: null,
    });
  });

  it('keeps missing and foreign Manager failures private', async () => {
    const access = await eventAccess();
    const foreign = await eventAccess('Foreign gallery');
    const path = `/api/manage/events/${access.event.id}/gallery/summary`;
    const missing = await createApp().request(path, {}, testEnv);
    const denied = await createApp().request(path, {
      headers: { cookie: foreign.manager.cookie },
    }, testEnv);

    expect(missing.status).toBe(401);
    expect(denied.status).toBe(403);
    for (const response of [missing, denied]) {
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('vary')).toContain('Cookie');
    }
  });
});
