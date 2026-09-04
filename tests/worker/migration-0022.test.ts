import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { migrationOnly, migrationsUpTo } from './helpers';

const NOW = '2026-09-04T00:00:00.000Z';

function preset(assetVersion: number): string {
  return JSON.stringify({
    version: 1,
    source: { kind: 'preset', presetId: 'warm-linen', assetVersion },
    effect: 'film',
  });
}

async function insertEvent(id: string, coverConfig?: string) {
  await env.DB.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message, cover_config,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) VALUES (?, ?, 'Maya & Theo', '2026-09-19', 'Welcome.',
      coalesce(?, '{"version":1,"source":{"kind":"none"}}'), ?, ?, ?, ?)
  `).bind(id, id, coverConfig ?? null, NOW, NOW, NOW, NOW).run();
}

async function triggerSql(name: string): Promise<string> {
  const row = await env.DB.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?
  `).bind(name).first<{ sql: string }>();
  if (!row) throw new Error(`Missing trigger ${name}.`);
  return row.sql;
}

describe('migration 0022 preset asset v2', () => {
  beforeEach(reset);

  it('accepts only preset asset versions 1 and 2 on a fresh database', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0022'), migrationOnly('0022')]);

    await expect(insertEvent('preset-v1', preset(1))).resolves.toBeUndefined();
    await expect(insertEvent('preset-v2', preset(2))).resolves.toBeUndefined();
    await expect(insertEvent('preset-v3', preset(3))).rejects.toThrow(
      'event cover source/pointer insert invariant',
    );
    await expect(insertEvent(
      'none-with-pointer',
      '{"version":1,"source":{"kind":"none"}}',
    ).then(() => env.DB.prepare(`
      UPDATE events SET cover_object_key = 'events/none-with-pointer/cover/orphan.webp'
      WHERE id = 'none-with-pointer'
    `).run())).rejects.toThrow('event cover source/pointer update invariant');
  });

  it('upgrades existing triggers without changing any other predicate', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0022'));
    await insertEvent('upgraded-event');

    const insertBefore = await triggerSql('event_cover_source_pointer_insert');
    const updateBefore = await triggerSql('event_cover_source_pointer_update');

    await applyD1Migrations(env.DB, [migrationOnly('0022')]);

    expect(await triggerSql('event_cover_source_pointer_insert')).toBe(
      insertBefore.replace(
        "json_extract(NEW.cover_config, '$.source.assetVersion') = 1",
        "json_extract(NEW.cover_config, '$.source.assetVersion') IN (1, 2)",
      ),
    );
    expect(await triggerSql('event_cover_source_pointer_update')).toBe(
      updateBefore.replace(
        "json_extract(NEW.cover_config, '$.source.assetVersion') = 1",
        "json_extract(NEW.cover_config, '$.source.assetVersion') IN (1, 2)",
      ),
    );

    await expect(env.DB.prepare(`
      UPDATE events SET cover_config = ?, cover_revision = 1 WHERE id = 'upgraded-event'
    `).bind(preset(1)).run()).resolves.toBeDefined();
    await expect(env.DB.prepare(`
      UPDATE events SET cover_config = ?, cover_revision = 2 WHERE id = 'upgraded-event'
    `).bind(preset(2)).run()).resolves.toBeDefined();
    await expect(env.DB.prepare(`
      UPDATE events SET cover_config = ?, cover_revision = 3 WHERE id = 'upgraded-event'
    `).bind(preset(3)).run()).rejects.toThrow('event cover source/pointer update invariant');
    await expect(env.DB.prepare(`
      UPDATE events
      SET cover_config = '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
          cover_revision = 3
      WHERE id = 'upgraded-event'
    `).run()).rejects.toThrow('event cover source/pointer update invariant');
  });
});
