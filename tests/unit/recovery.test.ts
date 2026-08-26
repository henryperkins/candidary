import { describe, expect, it, vi } from 'vitest';

import { parseManagementLink, replaceManagementLocation } from '../../src/app/management-link';
import { adoptTargetFor, hostRegisterHref, hostSignInHref, safeReturnTo } from '../../src/app/recovery';
import {
  KNOWN_APPLICATION_ORIGINS,
  PREVIEW_APPLICATION_ROOT_ORIGIN,
} from '../../shared/origins';

const EVENT = '11111111-2222-4333-8444-555555555555';
const ORIGIN = KNOWN_APPLICATION_ORIGINS[0];
const LOCAL_ORIGIN = 'http://localhost:5173';
const TOKEN = 'Abc_123.Xyz-789';

describe('management link recovery', () => {
  it('returns only the management pathname from a same-origin management link', () => {
    expect(parseManagementLink(`${ORIGIN}/manage/${TOKEN}`, ORIGIN))
      .toBe(`/manage/${TOKEN}`);
    expect(parseManagementLink(`/manage/${TOKEN}?from=mail#saved`, ORIGIN))
      .toBe(`/manage/${TOKEN}`);
  });

  it.each([
    ['foreign origin', `https://evil.example/manage/${TOKEN}`],
    ['credentials', `https://user:pass@candidary.app/manage/${TOKEN}`],
    ['manager client route', '/manage/event'],
    ['extra segment', `/manage/${TOKEN}/more`],
    ['trailing slash', `/manage/${TOKEN}/`],
    ['missing dot', '/manage/Abc_123'],
    ['duplicate dot', '/manage/Abc_123.Xyz-789.extra'],
    ['empty id', '/manage/.Xyz-789'],
    ['empty secret', '/manage/Abc_123.'],
    ['invalid id alphabet', '/manage/Abc%2F123.Xyz-789'],
    ['invalid secret alphabet', '/manage/Abc_123.Xyz%2F789'],
    ['non-management path', `/join/${TOKEN}`],
  ])('rejects %s', (_label, value) => {
    expect(parseManagementLink(value, ORIGIN)).toBeNull();
  });

  // Mail always links to the canonical origin, so a host reading it and then
  // returning on the other hostname pastes a link that is ours and is not this
  // page's origin. Only the pathname survives, and it opens on the origin the
  // host is already on.
  it('accepts a management link from one application origin while on another', () => {
    for (const linkOrigin of KNOWN_APPLICATION_ORIGINS) {
      for (const pageOrigin of KNOWN_APPLICATION_ORIGINS) {
        expect(parseManagementLink(`${linkOrigin}/manage/${TOKEN}`, pageOrigin))
          .toBe(`/manage/${TOKEN}`);
      }
    }
  });

  it('accepts preview management links only within the isolated preview family', () => {
    const previewAlias = 'https://feature-release-candidary-preview.lfd.workers.dev';
    expect(parseManagementLink(
      `${PREVIEW_APPLICATION_ROOT_ORIGIN}/manage/${TOKEN}`,
      previewAlias,
    )).toBe(`/manage/${TOKEN}`);
    expect(parseManagementLink(
      `${previewAlias}/manage/${TOKEN}`,
      PREVIEW_APPLICATION_ROOT_ORIGIN,
    )).toBe(`/manage/${TOKEN}`);
  });

  it('never moves a management bearer path between production and preview', () => {
    const previewAlias = 'https://feature-release-candidary-preview.lfd.workers.dev';
    for (const productionOrigin of KNOWN_APPLICATION_ORIGINS) {
      expect(parseManagementLink(
        `${productionOrigin}/manage/${TOKEN}`,
        previewAlias,
      )).toBeNull();
      expect(parseManagementLink(
        `${previewAlias}/manage/${TOKEN}`,
        productionOrigin,
      )).toBeNull();
    }
  });

  // The returned pathname is opened on the page's own origin, and
  // `GET /manage/:token` turns it into a manager session. A relative link must
  // not make an unrecognized page origin trustworthy: that would carry the
  // bearer credential onto a public preview or another clone.
  it('refuses a production management link pasted on a host that is not an application origin', () => {
    const previewOrigin = 'https://candidary.lfd.workers.dev';
    for (const linkOrigin of KNOWN_APPLICATION_ORIGINS) {
      expect(parseManagementLink(`${linkOrigin}/manage/${TOKEN}`, previewOrigin))
        .toBeNull();
      expect(parseManagementLink(`${linkOrigin}/manage/${TOKEN}`, LOCAL_ORIGIN)).toBeNull();
    }
    expect(parseManagementLink(`/manage/${TOKEN}`, previewOrigin)).toBeNull();
    expect(parseManagementLink(`${previewOrigin}/manage/${TOKEN}`, previewOrigin)).toBeNull();
    expect(parseManagementLink(`/manage/${TOKEN}`, 'https://candidary.test')).toBeNull();
  });

  it('keeps same-origin recovery available on the loopback development server', () => {
    expect(parseManagementLink(`/manage/${TOKEN}`, LOCAL_ORIGIN)).toBe(`/manage/${TOKEN}`);
    expect(parseManagementLink(`${LOCAL_ORIGIN}/manage/${TOKEN}`, LOCAL_ORIGIN))
      .toBe(`/manage/${TOKEN}`);
  });

  it('still refuses a lookalike of an application origin', () => {
    for (const value of [
      `https://candidary.app.evil.example/manage/${TOKEN}`,
      `https://candidary-app.example/manage/${TOKEN}`,
      `http://candidary.app/manage/${TOKEN}`,
    ]) {
      expect(parseManagementLink(value, ORIGIN)).toBeNull();
    }
  });

  it('passes a management pathname to Location.replace', () => {
    const replace = vi.fn();

    replaceManagementLocation(`/manage/${TOKEN}`, { replace });

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(`/manage/${TOKEN}`);
  });
});

describe('host recovery paths', () => {
  it('accepts only the two local destinations a recovery can end at', () => {
    expect(safeReturnTo('/host/events')).toBe('/host/events');
    expect(safeReturnTo(`/manage/event/${EVENT}`)).toBe(`/manage/event/${EVENT}`);
    expect(safeReturnTo(`/manage/event/${EVENT}?section=gallery&mode=album`))
      .toBe(`/manage/event/${EVENT}?section=gallery&mode=album`);
    expect(safeReturnTo(`/manage/event/${EVENT}?section=gallery&mode=shared`))
      .toBe(`/manage/event/${EVENT}?section=gallery&mode=guest-gallery`);
    expect(safeReturnTo(`/manage/event/${EVENT}?section=intake`)).toBe(`/manage/event/${EVENT}`);
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
    ['manager path with unknown query', `/manage/event/${EVENT}?section=gallery&mode=album&extra=1`],
    ['manager path with duplicate mode', `/manage/event/${EVENT}?section=gallery&mode=album&mode=library`],
    ['manager path with fragment', `/manage/event/${EVENT}?section=gallery#secret`],
    ['host events query', '/host/events?section=gallery'],
    ['empty', ''],
    ['null', null],
  ])('refuses %s', (_label, value) => {
    expect(safeReturnTo(value)).toBeNull();
  });

  it('adopts only the event the host is actually returning to', () => {
    expect(adoptTargetFor(`/manage/event/${EVENT}`, EVENT)).toBe(EVENT);
    expect(adoptTargetFor(`/manage/event/${EVENT}?section=gallery&mode=album`, EVENT)).toBe(EVENT);
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

  it('uses the canonical guest-gallery destination in a sign-in href', () => {
    const href = hostSignInHref(EVENT, `/manage/event/${EVENT}?section=gallery&mode=shared`);
    const search = new URLSearchParams(href.slice(href.indexOf('?') + 1));

    expect(search.get('returnTo')).toBe(`/manage/event/${EVENT}?section=gallery&mode=guest-gallery`);
  });

  it('falls back to a bare sign-in link for an unusable event id', () => {
    expect(hostSignInHref('not-a-uuid')).toBe('/host/login');
    expect(hostSignInHref(null)).toBe('/host/login');
  });

  it('builds a registration href from only validated recovery context', () => {
    const href = hostRegisterHref(EVENT, `/manage/event/${EVENT}`, true);
    expect(href).toBe(`/host/register?returnTo=%2Fmanage%2Fevent%2F${EVENT}&adopt=${EVENT}&pending=1`);

    const search = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    const returnTo = safeReturnTo(search.get('returnTo'));
    expect(returnTo).toBe(`/manage/event/${EVENT}`);
    expect(adoptTargetFor(returnTo, search.get('adopt'))).toBe(EVENT);
  });

  it('refuses unsafe or mismatched registration recovery context', () => {
    const other = '99999999-2222-4333-8444-555555555555';
    expect(hostRegisterHref(EVENT, 'https://evil.example.com', true)).toBe('/host/register?returnTo=%2Fmanage%2Fevent%2F11111111-2222-4333-8444-555555555555&adopt=11111111-2222-4333-8444-555555555555&pending=1');
    expect(hostRegisterHref(other, `/manage/event/${EVENT}`)).toBe(`/host/register?returnTo=%2Fmanage%2Fevent%2F${EVENT}`);
  });
});
