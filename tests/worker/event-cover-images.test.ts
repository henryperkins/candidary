import { beforeEach, describe, expect, it } from 'vitest';

import {
  COVER_PAPER_MATTE,
  MAX_COVER_MASTER_BYTES,
  MAX_COVER_PREVIEW_BYTES,
} from '../../shared/constants';
import {
  COVER_MASTER_LADDER,
  COVER_OUTPUT_JPEG_QUALITIES,
  COVER_OUTPUT_WEBP_QUALITIES,
  COVER_PREVIEW_LADDER,
  EVENT_COVER_EFFECTS,
  EVENT_COVER_PROFILES,
  coverByteCeiling,
} from '../../shared/event-cover';
import {
  normalizeCoverMaster,
  readCoverSourceInfo,
  renderCoverPreview,
  renderCoverProfileObject,
  verifyCoverManifest,
} from '../../worker/storage/event-cover-images';
import { coverRenderKey } from '../../worker/storage/event-cover-keys';
import { resetDatabase, testEnv, withRecordingImages } from './helpers';
import type { RecordedImagesCall } from './helpers';

const RAW_KEY = 'events/e1/cover/raw/d1';
const MASTER_KEY = 'events/e1/cover/masters/m1.webp';

async function seedRaw(key = RAW_KEY) {
  await testEnv.MEDIA_BUCKET.put(key, new Uint8Array(4_000).fill(3));
}

/** A fixed encoder, so a rung's byte size is the test's choice and not a guess. */
function fixedSize(byteLength: number) {
  return (call: RecordedImagesCall) => {
    const last = call.transforms.at(-1) as { width?: number; height?: number } | undefined;
    const sized = call.transforms.find((t) => (t as { width?: number }).width) as
      { width: number; height: number } | undefined;
    return {
      bytes: new Uint8Array(byteLength).fill(1),
      width: sized?.width ?? last?.width ?? 0,
      height: sized?.height ?? last?.height ?? 0,
      contentType: (call.output as { format: string }).format,
    };
  };
}

describe('cover source inspection', () => {
  it('maps an Images decoder rejection to the safe unsupported-source error', async () => {
    const { env } = withRecordingImages();
    const rejectingEnv = {
      ...env,
      IMAGES: Object.create(env.IMAGES, {
        info: {
          value: async () => {
            throw new Error('private Images decoder detail');
          },
        },
      }),
    } as typeof env;

    await expect(readCoverSourceInfo(rejectingEnv, new Uint8Array([1, 2, 3, 4]).buffer))
      .rejects.toMatchObject({ code: 'COVER_SOURCE_UNSUPPORTED', status: 422 });
  });
});

describe('cover master normalization', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedRaw();
  });

  it('requests the exact first-rung recipe and stores the winning master', async () => {
    const { env, calls } = withRecordingImages({
      source: { width: 3000, height: 2000 },
      encode: fixedSize(900_000),
    });
    const master = await normalizeCoverMaster(env, { eventId: 'e1', masterId: 'm1', rawKey: RAW_KEY });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.transforms).toEqual([{
      // Rung 1 caps the long edge at 4096 and the area at 16 MP; a 3000x2000
      // source is under both, so it is passed through at its own size.
      width: 3000,
      height: 2000,
      fit: 'scale-down',
      background: COVER_PAPER_MATTE,
    }]);
    expect(calls[0]!.output).toEqual({
      format: 'image/webp',
      quality: COVER_MASTER_LADDER[0]!.quality,
      background: COVER_PAPER_MATTE,
      anim: false,
    });

    expect(master).toMatchObject({
      objectKey: MASTER_KEY, byteSize: 900_000, width: 3000, height: 2000, rung: 1,
    });
    expect(master.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const stored = await testEnv.MEDIA_BUCKET.head(MASTER_KEY);
    expect(stored?.httpMetadata?.contentType).toBe('image/webp');
  });

  it('applies the area cap, not just the long edge', async () => {
    // 5000x4000 is 20 MP: inside no rung's area, and over rung 1's edge cap.
    const { env, calls } = withRecordingImages({
      source: { width: 5000, height: 4000 },
      encode: fixedSize(900_000),
    });
    await normalizeCoverMaster(env, { eventId: 'e1', masterId: 'm1', rawKey: RAW_KEY });
    const requested = calls[0]!.transforms[0] as { width: number; height: number };
    expect(requested.width * requested.height).toBeLessThanOrEqual(COVER_MASTER_LADDER[0]!.area);
    expect(Math.max(requested.width, requested.height)).toBeLessThanOrEqual(COVER_MASTER_LADDER[0]!.longEdge);
  });

  it('walks the ladder until a rung fits the byte ceiling', async () => {
    let attempt = 0;
    const { env, calls } = withRecordingImages({
      source: { width: 4000, height: 3000 },
      encode: (call) => {
        attempt += 1;
        // The first two rungs blow the 9,000,000-byte ceiling; the third fits.
        const byteLength = attempt <= 2 ? MAX_COVER_MASTER_BYTES + 1 : 5_000_000;
        return fixedSize(byteLength)(call);
      },
    });
    const master = await normalizeCoverMaster(env, { eventId: 'e1', masterId: 'm1', rawKey: RAW_KEY });
    expect(master.rung).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => (call.output as { quality: number }).quality))
      .toEqual([88, 84, 84]);
  });

  it('skips a rung that would fall below the 1x minimum', async () => {
    // 640x430 clears the floor but every rung that shrinks it would not.
    const { env, calls } = withRecordingImages({
      source: { width: 640, height: 430 },
      encode: fixedSize(500_000),
    });
    const master = await normalizeCoverMaster(env, { eventId: 'e1', masterId: 'm1', rawKey: RAW_KEY });
    expect(master).toMatchObject({ width: 640, height: 430, rung: 1 });
    for (const call of calls) {
      const requested = call.transforms[0] as { width: number; height: number };
      expect(requested.width).toBeGreaterThanOrEqual(620);
      expect(requested.height).toBeGreaterThanOrEqual(420);
    }
  });

  it('refuses a source below the 1x minimum before any transform', async () => {
    const { env, calls } = withRecordingImages({ source: { width: 619, height: 900 } });
    await expect(normalizeCoverMaster(env, { eventId: 'e1', masterId: 'm1', rawKey: RAW_KEY }))
      .rejects.toMatchObject({ code: 'COVER_SOURCE_TOO_SMALL', status: 422 });
    expect(calls).toHaveLength(0);
  });

  it('fails when no rung qualifies', async () => {
    const { env } = withRecordingImages({
      source: { width: 4000, height: 3000 },
      encode: fixedSize(MAX_COVER_MASTER_BYTES + 1),
    });
    await expect(normalizeCoverMaster(env, { eventId: 'e1', masterId: 'm1', rawKey: RAW_KEY }))
      .rejects.toMatchObject({ code: 'COVER_MASTER_BUDGET_EXHAUSTED' });
    expect(await testEnv.MEDIA_BUCKET.head(MASTER_KEY)).toBeNull();
  });

  it('reports a missing binding with a code whose name matches its meaning', async () => {
    const withoutImages = { ...testEnv, IMAGES: undefined } as never;
    await expect(normalizeCoverMaster(withoutImages, { eventId: 'e1', masterId: 'm1', rawKey: RAW_KEY }))
      .rejects.toMatchObject({ code: 'COVER_RENDER_UNAVAILABLE', status: 503 });
  });
});

describe('cover preview rendering', () => {
  beforeEach(async () => {
    await resetDatabase();
    await testEnv.MEDIA_BUCKET.put(MASTER_KEY, new Uint8Array(2_000).fill(4));
  });

  it('renders every effect uncropped through the four-rung ladder', async () => {
    const recipes = {
      natural: { sharpen: 1 },
      warm: { saturation: 1.04, contrast: 0.99, sharpen: 1 },
      film: { contrast: 0.95, saturation: 0.8, sharpen: 1 },
      soft: { saturation: 0.96, contrast: 0.92, sharpen: 0.6 },
      monochrome: { saturation: 0, contrast: 1.02, sharpen: 1 },
    } as const;
    for (const effect of EVENT_COVER_EFFECTS) {
      const { env, calls } = withRecordingImages({
        source: { width: 2400, height: 1600 },
        encode: fixedSize(200_000),
      });
      const preview = await renderCoverPreview(env, {
        eventId: 'e1', draftId: 'd1', masterKey: MASTER_KEY, effect,
      });
      expect(preview.objectKey).toBe(`events/e1/cover/previews/d1/${effect}-2.webp`);
      expect(preview.rung).toBe(1);
      // Resize, then the fixed tonal recipe. No trim and no crop: the browser
      // applies focus and zoom to this one file locally.
      expect(calls[0]!.transforms).toHaveLength(2);
      const resize = calls[0]!.transforms[0] as { width: number; fit: string };
      expect(resize.fit).toBe('scale-down');
      expect(resize.width).toBe(COVER_PREVIEW_LADDER[0]!.longEdge);
      expect(calls[0]!.transforms[1]).toEqual(recipes[effect]);
      if (effect === 'warm') {
        expect(calls[0]!.draws).toHaveLength(1);
        expect(calls[0]!.draws[0]!.image).toBeInstanceOf(ReadableStream);
        expect(calls[0]!.draws[0]!.options).toEqual({
          opacity: 0.05, repeat: true, composite: 'over',
        });
      } else {
        expect(calls[0]!.draws).toEqual([]);
      }
      expect(calls[0]!.output).toMatchObject({ format: 'image/webp', quality: 82, anim: false });
    }
  });

  it('walks the preview ladder and then reports exhaustion', async () => {
    const { env, calls } = withRecordingImages({
      source: { width: 2400, height: 1600 },
      encode: fixedSize(MAX_COVER_PREVIEW_BYTES + 1),
    });
    await expect(renderCoverPreview(env, {
      eventId: 'e1', draftId: 'd1', masterKey: MASTER_KEY, effect: 'natural',
    })).rejects.toMatchObject({ code: 'COVER_PREVIEW_BUDGET_EXHAUSTED' });
    expect(calls.map((call) => (call.output as { quality: number }).quality))
      .toEqual(COVER_PREVIEW_LADDER.map((rung) => rung.quality));
  });
});

describe('cover profile rendering', () => {
  const master = { width: 2480, height: 1680 };

  beforeEach(async () => {
    await resetDatabase();
    await testEnv.MEDIA_BUCKET.put(MASTER_KEY, new Uint8Array(2_000).fill(5));
  });

  const slot = (patch: Record<string, unknown> = {}) => ({
    eventId: 'e1',
    renderSetId: 's1',
    masterKey: MASTER_KEY,
    master,
    focus: { x: 0.5, y: 0.5, zoom: 1 },
    effect: 'natural' as const,
    tonalEffectVersion: 2 as const,
    profile: 'wide-expanded' as const,
    density: '1x' as const,
    format: 'webp' as const,
    ...patch,
  });

  it('trims to the focus window, then aspect-crops around the focal point', async () => {
    const { env, calls } = withRecordingImages({ encode: fixedSize(50_000) });
    const rendered = await renderCoverProfileObject(env, slot({
      focus: { x: 0.25, y: 0.75, zoom: 2 },
    }));

    const [trim, crop, effect] = calls[0]!.transforms as Array<Record<string, any>>;
    // zoom 2 halves the window in both dimensions and clamps it inside the master.
    expect(trim!.trim).toEqual({ left: 0, top: 840, width: 1240, height: 840 });
    expect(crop!).toMatchObject({ width: 620, height: 420, fit: 'cover' });
    // The coordinate form requires `mode`, and the point is expressed inside the
    // trim so every profile protects the same subject.
    expect(crop!.gravity.mode).toBe('box-center');
    expect(crop!.gravity.x).toBeCloseTo(0.5, 5);
    expect(crop!.gravity.y).toBeCloseTo(0.5, 5);
    expect(effect).toEqual({ sharpen: 1 });
    expect(rendered).toMatchObject({ width: 620, height: 420, rung: 1, adopted: false });
  });

  it('keeps the v1 Warm recipe for legacy render sets without drawing a wash', async () => {
    const { env, calls } = withRecordingImages({ encode: fixedSize(50_000) });
    await renderCoverProfileObject(env, slot({ effect: 'warm', tonalEffectVersion: 1 }));

    expect(calls[0]!.transforms.at(-1)).toEqual({
      gamma: 1.05, saturation: 1.08, contrast: 0.96, sharpen: 1,
    });
    expect(calls[0]!.draws).toEqual([]);
  });

  it('renders every profile, density, and format inside its own byte ceiling', async () => {
    for (const profile of EVENT_COVER_PROFILES) {
      for (const density of ['1x', '2x'] as const) {
        for (const format of ['webp', 'jpeg'] as const) {
          const ceiling = coverByteCeiling(profile, density, format);
          const { env } = withRecordingImages({ encode: fixedSize(ceiling) });
          const rendered = await renderCoverProfileObject(env, slot({
            profile: profile.id, density, format, renderSetId: `s-${profile.id}-${density}-${format}`,
          }));
          const scale = density === '2x' ? 2 : 1;
          expect(rendered).toMatchObject({
            width: profile.width * scale,
            height: profile.height * scale,
            contentType: format === 'webp' ? 'image/webp' : 'image/jpeg',
            byteSize: ceiling,
            rung: 1,
          });
        }
      }
    }
  });

  it('walks each format quality ladder and then fails publication', async () => {
    for (const [format, qualities] of [
      ['webp', COVER_OUTPUT_WEBP_QUALITIES],
      ['jpeg', COVER_OUTPUT_JPEG_QUALITIES],
    ] as const) {
      const { env, calls } = withRecordingImages({ encode: fixedSize(10_000_000) });
      await expect(renderCoverProfileObject(env, slot({ format })))
        .rejects.toMatchObject({ code: 'COVER_OUTPUT_BUDGET_EXHAUSTED' });
      expect(calls.map((call) => (call.output as { quality: number }).quality)).toEqual([...qualities]);
    }
  });

  it('refuses a 2x slot the crop cannot produce without upscaling', async () => {
    const { env, calls } = withRecordingImages({ encode: fixedSize(1_000) });
    await expect(renderCoverProfileObject(env, slot({
      master: { width: 620, height: 420 }, density: '2x',
    }))).rejects.toMatchObject({ code: 'COVER_OUTPUT_BUDGET_EXHAUSTED' });
    expect(calls).toHaveLength(0);
  });

  it('adopts an existing object rather than overwriting it', async () => {
    const key = coverRenderKey('e1', 's1', 'wide-expanded', '1x', 'webp');
    const existing = new Uint8Array(4_242).fill(9);
    await testEnv.MEDIA_BUCKET.put(key, existing, {
      httpMetadata: { contentType: 'image/webp' },
      customMetadata: { width: '620', height: '420', rung: '2' },
    });

    const { env, calls } = withRecordingImages({ encode: fixedSize(50_000) });
    const rendered = await renderCoverProfileObject(env, slot());

    // A replayed step verifies what is there; it never re-encodes over bytes
    // that may already belong to an active manifest.
    expect(rendered).toMatchObject({ adopted: true, byteSize: 4_242, width: 620, height: 420, rung: 2 });
    expect(calls).toHaveLength(0);
    const stored = await testEnv.MEDIA_BUCKET.get(key);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(existing);
  });
});

describe('manifest verification', () => {
  beforeEach(resetDatabase);

  const oneXManifest = () => EVENT_COVER_PROFILES.flatMap((profile) => ([
    { profile: profile.id, density: '1x' as const, format: 'webp' as const },
    { profile: profile.id, density: '1x' as const, format: 'jpeg' as const },
  ]));

  async function seedSet(requiredSlots: number) {
    const now = '2026-08-04T00:00:00.000Z';
    await testEnv.DB.prepare(`
      INSERT INTO events (id, slug, name, event_date, welcome_message,
        guest_access_expires_at, management_access_expires_at, purge_after, created_at)
      VALUES ('e1', 'e1-slug', 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?)
    `).bind(now, now, now, now).run();
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_masters (id, event_id, object_key, mime_type, byte_size, width,
        height, sha256, normalization_version, normalization_rung, created_at)
      VALUES ('m1', 'e1', ?, 'image/webp', 1, 2480, 1680, ?, 1, 1, ?)
    `).bind(MASTER_KEY, 'a'.repeat(64), now).run();
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_render_sets (id, event_id, master_id, recipe_json, recipe_sha256,
        state, required_slots, created_at)
      VALUES ('s1', 'e1', 'm1', '{}', ?, 'staging', ?, ?)
    `).bind('a'.repeat(64), requiredSlots, now).run();
  }

  async function adopt(profileId: string, density: '1x' | '2x', format: 'webp' | 'jpeg') {
    const { env } = withRecordingImages({ encode: fixedSize(20_000) });
    await testEnv.MEDIA_BUCKET.put(MASTER_KEY, new Uint8Array(2_000).fill(6));
    const rendered = await renderCoverProfileObject(env, {
      eventId: 'e1', renderSetId: 's1', masterKey: MASTER_KEY,
      master: { width: 2480, height: 1680 }, focus: { x: 0.5, y: 0.5, zoom: 1 },
      effect: 'natural', tonalEffectVersion: 2, profile: profileId as never, density, format,
    });
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_render_objects (id, render_set_id, event_id, profile_id, density,
        format, object_key, content_type, byte_size, width, height, quality_rung, sha256, created_at)
      VALUES (?, 's1', 'e1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-04T00:00:00.000Z')
    `).bind(
      crypto.randomUUID(), profileId, density, format, rendered.objectKey, rendered.contentType,
      rendered.byteSize, rendered.width, rendered.height, rendered.rung, rendered.sha256,
    ).run();
    return rendered;
  }

  it('passes only when every required slot exists and matches', async () => {
    await seedSet(12);
    for (const profile of EVENT_COVER_PROFILES) {
      for (const format of ['webp', 'jpeg'] as const) await adopt(profile.id, '1x', format);
    }
    expect(await verifyCoverManifest(testEnv, 's1', oneXManifest())).toMatchObject({
      complete: true, missing: [], mismatched: [],
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it('fails an incomplete set even when every present slot is valid', async () => {
    await seedSet(12);
    await adopt('wide-expanded', '1x', 'webp');
    const verdict = await verifyCoverManifest(testEnv, 's1', oneXManifest());
    expect(verdict.complete).toBe(false);
    expect(verdict.missing).toHaveLength(11);
  });

  it('catches a missing object and a drifted checksum', async () => {
    await seedSet(12);
    for (const profile of EVENT_COVER_PROFILES) {
      for (const format of ['webp', 'jpeg'] as const) await adopt(profile.id, '1x', format);
    }
    const missing = { objectKey: coverRenderKey('e1', 's1', 'wide-expanded', '1x', 'webp') };
    const drifted = { objectKey: coverRenderKey('e1', 's1', 'wide-expanded', '1x', 'jpeg') };
    await testEnv.MEDIA_BUCKET.delete(missing.objectKey);
    await testEnv.DB.prepare('UPDATE event_cover_render_objects SET sha256 = ? WHERE object_key = ?')
      .bind('b'.repeat(64), drifted.objectKey).run();

    const verdict = await verifyCoverManifest(testEnv, 's1', oneXManifest());
    expect(verdict).toMatchObject({
      complete: false,
      missing: ['wide-expanded/1x/webp'],
      mismatched: ['wide-expanded/1x/jpeg'],
    });
  });
});
