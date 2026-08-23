import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PREVIEW_APPLICATION_ROOT_ORIGIN } from '../../shared/origins';

interface WranglerEnvironment {
  name?: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  d1_databases?: { binding?: string; database_name?: string; database_id?: string }[];
  r2_buckets?: { binding?: string; bucket_name?: string }[];
  send_email?: unknown[];
  secrets?: { required?: string[] };
  workflows?: { binding?: string; name?: string }[];
  version_metadata?: { binding?: string };
  triggers?: { crons?: string[] };
  vars?: Record<string, string>;
}

const config = JSON.parse(
  readFileSync(resolve(process.cwd(), 'wrangler.jsonc'), 'utf8'),
) as {
  send_email?: WranglerEnvironment['send_email'];
  secrets?: WranglerEnvironment['secrets'];
  d1_databases?: WranglerEnvironment['d1_databases'];
  r2_buckets?: WranglerEnvironment['r2_buckets'];
  env?: { preview?: WranglerEnvironment };
};

describe('Wrangler deployment environments', () => {
  it('keeps email and all ten required secrets environment-safe', () => {
    expect(config.send_email).toEqual([{ name: 'EMAIL' }]);
    expect(config.env?.preview?.send_email).toEqual([]);
    expect(config.secrets?.required).toEqual([
      'TOKEN_HMAC_KEY',
      'SESSION_HMAC_KEY',
      'GUEST_TOKEN_ENCRYPTION_KEY',
      'LOGIN_HMAC_KEY',
      'ENTRY_HMAC_KEY',
      'ENTRY_ENCRYPTION_KEY',
      'RSVP_LOOKUP_HMAC_KEY',
      'GUEST_MESSAGE_HMAC_KEY',
      'ALBUM_SHARE_HMAC_KEY',
      'ALBUM_SHARE_ENCRYPTION_KEY',
    ]);
    expect(config.env?.preview?.secrets).toEqual(config.secrets);
  });

  it('keeps branch previews off every production resource and scheduled trigger', () => {
    const preview = config.env?.preview;
    expect(preview).toBeDefined();
    expect(preview).toMatchObject({
      name: 'candidary-preview',
      workers_dev: true,
      preview_urls: true,
      version_metadata: { binding: 'CF_VERSION_METADATA' },
      triggers: { crons: [] },
      send_email: [],
      vars: {
        APP_ORIGIN: PREVIEW_APPLICATION_ROOT_ORIGIN,
        ALTERNATE_ORIGINS: '',
      },
    });
    expect(preview?.d1_databases).toEqual([expect.objectContaining({
      binding: 'DB',
      database_name: 'candidary-preview-core',
      database_id: 'bd816308-0c4c-48de-9ece-8d030360fb73',
    })]);
    expect(preview?.r2_buckets?.map((bucket) => bucket.bucket_name)).toEqual([
      'candidary-preview-media',
      'candidary-preview-media-canonical',
    ]);
    expect(preview?.workflows?.map((workflow) => workflow.name)).toEqual([
      'candidary-preview-export',
      'candidary-preview-cover-render',
      'candidary-preview-cover-backfill',
    ]);

    const productionResources = new Set([
      ...(config.d1_databases ?? []).map((database) => database.database_id),
      ...(config.r2_buckets ?? []).map((bucket) => bucket.bucket_name),
    ]);
    for (const resource of [
      ...(preview?.d1_databases ?? []).map((database) => database.database_id),
      ...(preview?.r2_buckets ?? []).map((bucket) => bucket.bucket_name),
    ]) {
      expect(productionResources.has(resource)).toBe(false);
    }
  });
});
