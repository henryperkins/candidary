import { describe, expect, it } from 'vitest';

import { adoptTargetFor, hostSignInHref, safeReturnTo } from '../../src/app/recovery';

const EVENT = '11111111-2222-4333-8444-555555555555';

describe('host recovery paths', () => {
  it('accepts only the two local destinations a recovery can end at', () => {
    expect(safeReturnTo('/host/events')).toBe('/host/events');
    expect(safeReturnTo(`/manage/event/${EVENT}`)).toBe(`/manage/event/${EVENT}`);
  });

  // These are the strings that turn `returnTo` into an open redirect. Each one must
  // be refused; deleting any guard in safeReturnTo should fail this test.
  it.each([
    ['protocol-relative', '//evil.example.com'],
    ['absolute http', 'http://evil.example.com/manage/event/' + EVENT],
    ['absolute https', 'https://evil.example.com'],
    ['backslash authority', '/\\evil.example.com'],
    ['scheme-ish', 'javascript:alert(1)'],
    ['traversal', '/manage/event/../../evil'],
    ['encoded traversal', '/manage/event/%2e%2e%2f%2e%2e'],
    ['unknown local path', '/admin'],
    ['manager path with non-uuid', '/manage/event/not-a-uuid'],
    ['manager path with suffix', `/manage/event/${EVENT}/settings`],
    ['empty', ''],
    ['null', null],
  ])('refuses %s', (_label, value) => {
    expect(safeReturnTo(value)).toBeNull();
  });

  it('adopts only the event the host is actually returning to', () => {
    expect(adoptTargetFor(`/manage/event/${EVENT}`, EVENT)).toBe(EVENT);
  });

  it('refuses an adopt target that disagrees with the return path', () => {
    const other = '99999999-2222-4333-8444-555555555555';
    // The two parameters disagreeing is exactly how an unrelated event would get
    // claimed, so neither may win.
    expect(adoptTargetFor(`/manage/event/${EVENT}`, other)).toBeNull();
    expect(adoptTargetFor('/host/events', EVENT)).toBeNull();
    expect(adoptTargetFor(null, EVENT)).toBeNull();
    expect(adoptTargetFor(`/manage/event/${EVENT}`, 'not-a-uuid')).toBeNull();
  });

  it('builds a sign-in href that round-trips through its own validators', () => {
    const href = hostSignInHref(EVENT);
    const search = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    const returnTo = safeReturnTo(search.get('returnTo'));
    expect(returnTo).toBe(`/manage/event/${EVENT}`);
    expect(adoptTargetFor(returnTo, search.get('adopt'))).toBe(EVENT);
  });

  it('falls back to a bare sign-in link for an unusable event id', () => {
    expect(hostSignInHref('not-a-uuid')).toBe('/host/login');
    expect(hostSignInHref(null)).toBe('/host/login');
  });
});
