import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { AuthService } from '../../worker/auth/service';
import { eventAccess, hostAccess, hostWriteHeaders, resetDatabase, testEnv, writeHeaders } from './helpers';

const PATH = '/api/host/tours/host-event-welcome/1';
function read(cookie: string, path = PATH) {
  return createApp().request(path, { headers: { cookie } }, testEnv);
}
function write(host: Awaited<ReturnType<typeof hostAccess>>, status: string, path = PATH) {
  return createApp().request(path, {
    method: 'PATCH', headers: hostWriteHeaders(host), body: JSON.stringify({ status }),
  }, testEnv);
}
function privateResponse(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

beforeEach(resetDatabase);

describe('host welcome tour state', () => {
  it('returns unseen for an account without a row, without inserting a row', async () => {
    const host = await hostAccess();
    const response = await read(host.cookie);
    expect(response.status).toBe(200);
    privateResponse(response);
    expect((await response.json<any>()).data).toEqual({ accountId: host.account.id, tourKey: 'host-event-welcome', version: 1, status: 'unseen' });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM host_tours').first('count')).toBe(0);
  });

  it('persists dismissal across a fresh session and multiple events without affecting another account', async () => {
    const a = await eventAccess('A');
    const b = await eventAccess('B');
    const host = await hostAccess([a, b]);
    const other = await hostAccess();
    const dismissed = await write(host, 'dismissed');
    expect(dismissed.status).toBe(200);
    privateResponse(dismissed);
    const session = await new AuthService(testEnv).createHostSession(host.account.id, host.account.authVersion);
    const freshCookie = `candidary_host=${session.sessionToken.token}`;
    expect((await (await read(freshCookie)).json<any>()).data.status).toBe('dismissed');
    expect((await (await read(other.cookie)).json<any>()).data.status).toBe('unseen');
  });

  it('makes completion win over duplicate and delayed dismissal writes', async () => {
    const host = await hostAccess();
    for (const [index, status] of ['dismissed', 'completed', 'completed', 'dismissed'].entries()) {
      const response = await write(host, status);
      expect(response.status).toBe(200);
      expect((await response.json<any>()).data.status).toBe(index === 0 ? 'dismissed' : 'completed');
    }
    expect((await (await read(host.cookie)).json<any>()).data.status).toBe('completed');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM host_tours').first('count')).toBe(1);
  });

  it('refuses unknown versions privately and leaves current-version state untouched', async () => {
    const host = await hostAccess();
    await write(host, 'completed');
    for (const path of ['/api/host/tours/host-event-welcome/2', '/api/host/tours/host-event-welcome/01', '/api/host/tours/host-event-welcome/nope']) {
      for (const response of [await read(host.cookie, path), await write(host, 'dismissed', path)]) {
        expect(response.status).toBe(422);
        privateResponse(response);
      }
    }
    expect((await (await read(host.cookie)).json<any>()).data.status).toBe('completed');
  });

  it('refuses link-only manager, guest and anonymous reads and writes privately', async () => {
    const access = await eventAccess();
    for (const credential of [access.manager, access.guest, { cookie: '', csrf: '' }]) {
      const responses = [await read(credential.cookie), await createApp().request(PATH, {
        method: 'PATCH', headers: writeHeaders(credential), body: JSON.stringify({ status: 'completed' }),
      }, testEnv)];
      for (const response of responses) {
        expect(response.status).toBe(401);
        privateResponse(response);
      }
    }
  });

  it('requires host-scoped CSRF and trusted origin before persisting', async () => {
    const host = await hostAccess();
    for (const patch of [{ 'x-candidary-host-csrf': '' }, { 'x-candidary-host-csrf': 'bad' }, { origin: '' }, { origin: 'https://evil.test' }]) {
      const response = await createApp().request(PATH, {
        method: 'PATCH', headers: { ...hostWriteHeaders(host), ...patch }, body: JSON.stringify({ status: 'completed' }),
      }, testEnv);
      expect(response.status).toBe(403);
      privateResponse(response);
    }
    expect((await (await read(host.cookie)).json<any>()).data.status).toBe('unseen');
  });

  it('refuses writes tied to a previously observed account without changing either account', async () => {
    const host = await hostAccess();
    const previous = await hostAccess();
    const response = await createApp().request(PATH, {
      method: 'PATCH',
      headers: { ...hostWriteHeaders(host), 'x-candidary-tour-account-id': previous.account.id },
      body: JSON.stringify({ status: 'completed' }),
    }, testEnv);
    expect(response.status).toBe(409);
    privateResponse(response);
    for (const account of [host, previous]) {
      expect((await (await read(account.cookie)).json<any>()).data.status).toBe('unseen');
    }
    const matched = await createApp().request(PATH, {
      method: 'PATCH',
      headers: { ...hostWriteHeaders(host), 'x-candidary-tour-account-id': host.account.id },
      body: JSON.stringify({ status: 'completed' }),
    }, testEnv);
    expect(matched.status).toBe(200);
  });

  it('isolates stored versions, constrains statuses and cascades account deletion', async () => {
    const host = await hostAccess();
    const now = new Date().toISOString();
    await testEnv.DB.prepare(`INSERT INTO host_tours VALUES (?, 'host-event-welcome', 2, 'completed', ?, ?)`)
      .bind(host.account.id, now, now).run();
    expect((await (await read(host.cookie)).json<any>()).data.status).toBe('unseen');
    await write(host, 'dismissed');
    await expect(testEnv.DB.prepare(`INSERT INTO host_tours VALUES (?, 'host-event-welcome', 3, 'unseen', ?, ?)`)
      .bind(host.account.id, now, now).run()).rejects.toThrow();
    await expect(testEnv.DB.prepare(`INSERT INTO host_tours VALUES ('missing', 'host-event-welcome', 1, 'completed', ?, ?)`)
      .bind(now, now).run()).rejects.toThrow();
    await testEnv.DB.prepare('DELETE FROM host_accounts WHERE id = ?').bind(host.account.id).run();
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM host_tours').first('count')).toBe(0);
  });

  it('accepts only terminal statuses and rejects extra identity fields', async () => {
    const host = await hostAccess();
    for (const body of [{ status: 'unseen' }, { status: 'other' }, {}, { status: 'completed', accountId: 'other' }]) {
      const response = await createApp().request(PATH, {
        method: 'PATCH', headers: hostWriteHeaders(host), body: JSON.stringify(body),
      }, testEnv);
      expect(response.status).toBe(422);
      privateResponse(response);
    }
    expect((await (await read(host.cookie)).json<any>()).data.status).toBe('unseen');
  });
});
