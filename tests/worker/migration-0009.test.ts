import { beforeEach, expect, it } from 'vitest';

import { eventAccess, resetDatabase, testEnv } from './helpers';

beforeEach(resetDatabase);

it('constrains roster batch receipts and removes them with the event', async () => {
  const access = await eventAccess('Receipt migration');
  const receipt = JSON.stringify({
    createdHouseholds: [],
    updatedHouseholds: [],
    totals: {
      householdsCreated: 0,
      householdsUpdated: 0,
      namedInviteesAdded: 0,
      plusOneCapacityAdded: 0,
      invitedCapacityAdded: 0,
      resultingHouseholds: 0,
      resultingInvitedCapacity: 0,
    },
    committedRosterVersion: 1,
  });

  await testEnv.DB.prepare(`
    INSERT INTO rsvp_roster_batch_receipts (
      event_id, idempotency_key, request_digest, receipt_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    access.event.id,
    'receipt-key',
    'a'.repeat(64),
    receipt,
    new Date().toISOString(),
  ).run();

  await expect(testEnv.DB.prepare(`
    INSERT INTO rsvp_roster_batch_receipts (
      event_id, idempotency_key, request_digest, receipt_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    access.event.id,
    'receipt-key',
    'd'.repeat(64),
    receipt,
    new Date().toISOString(),
  ).run()).rejects.toThrow();

  await expect(testEnv.DB.prepare(`
    INSERT INTO rsvp_roster_batch_receipts (
      event_id, idempotency_key, request_digest, receipt_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    access.event.id,
    '',
    'b'.repeat(64),
    receipt,
    new Date().toISOString(),
  ).run()).rejects.toThrow();

  await expect(testEnv.DB.prepare(`
    INSERT INTO rsvp_roster_batch_receipts (
      event_id, idempotency_key, request_digest, receipt_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    access.event.id,
    'uppercase-digest',
    'A'.repeat(64),
    receipt,
    new Date().toISOString(),
  ).run()).rejects.toThrow();

  await expect(testEnv.DB.prepare(`
    INSERT INTO rsvp_roster_batch_receipts (
      event_id, idempotency_key, request_digest, receipt_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    access.event.id,
    'invalid-json',
    'c'.repeat(64),
    '{',
    new Date().toISOString(),
  ).run()).rejects.toThrow();

  await testEnv.DB.prepare('DELETE FROM events WHERE id = ?').bind(access.event.id).run();
  expect(await testEnv.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM rsvp_roster_batch_receipts
    WHERE event_id = ?
  `).bind(access.event.id).first<number>('count')).toBe(0);
});
