import { describe, expect, it } from 'vitest';

import {
  canonicalManagerReturnPath,
  isManagerEventId,
  managerEventIdFromPathname,
  managerHref,
  parseManagerLocation,
  serializeManagerSearch,
  type ManagerLocation,
} from '../../src/app/manager-location';

const EVENT = '11111111-2222-4333-8444-555555555555';

describe('manager location parser and serializer', () => {
  it.each([
    ['', { section: 'intake' }, ''],
    ['?section=intake', { section: 'intake' }, ''],
    ['?section=rsvp', { section: 'rsvp' }, '?section=rsvp'],
    ['?section=guestbook', { section: 'guestbook' }, '?section=guestbook'],
    ['?section=share', { section: 'share' }, '?section=share'],
    ['?section=settings', { section: 'settings' }, '?section=settings'],
    ['?section=gallery', { section: 'gallery', mode: 'library' }, '?section=gallery'],
    ['?section=gallery&mode=library', { section: 'gallery', mode: 'library' }, '?section=gallery'],
    ['?section=gallery&mode=album', { section: 'gallery', mode: 'album' }, '?section=gallery&mode=album'],
    ['?section=gallery&mode=guest-gallery', { section: 'gallery', mode: 'guest-gallery' }, '?section=gallery&mode=guest-gallery'],
    ['?section=gallery&mode=shared', { section: 'gallery', mode: 'guest-gallery' }, '?section=gallery&mode=guest-gallery'],
    ['?mode=album', { section: 'intake' }, ''],
    ['?section=', { section: 'intake' }, ''],
    ['?section=%72svp', { section: 'rsvp' }, '?section=rsvp'],
    ['?section=%52svp', { section: 'intake' }, ''],
    ['?section=rsvp&mode=album', { section: 'rsvp' }, '?section=rsvp'],
    ['?section=gallery&mode=', { section: 'gallery', mode: 'library' }, '?section=gallery'],
    ['?section=gallery&mode=wrong', { section: 'gallery', mode: 'library' }, '?section=gallery'],
    ['?section=gallery&mode=album&mode=guest-gallery', { section: 'gallery', mode: 'library' }, '?section=gallery'],
    ['?section=rsvp&section=gallery&mode=album', { section: 'intake' }, ''],
    ['?section=Gallery', { section: 'intake' }, ''],
    ['?section=gallery&mode=Album', { section: 'gallery', mode: 'library' }, '?section=gallery'],
    ['?extra=1', { section: 'intake' }, ''],
    ['?section=gallery&mode=album&extra=1', { section: 'gallery', mode: 'album' }, '?section=gallery&mode=album'],
  ] as const)('parses %s to a canonical Manager location', (search, location, canonicalSearch) => {
    const parsed = parseManagerLocation(search);
    expect(parsed.location).toEqual(location);
    expect(parsed.canonicalSearch).toBe(canonicalSearch);
    expect(parsed.needsReplace).toBe(search !== canonicalSearch);
  });

  it('reports unknown and duplicate keys independently', () => {
    expect(parseManagerLocation('?section=rsvp&extra=1')).toMatchObject({
      hasUnknownKeys: true,
      hasDuplicateKnownKeys: false,
    });
    expect(parseManagerLocation('?section=rsvp&section=gallery')).toMatchObject({
      hasUnknownKeys: false,
      hasDuplicateKnownKeys: true,
    });
    expect(parseManagerLocation('?section=gallery&mode=album&mode=guest-gallery')).toMatchObject({
      hasUnknownKeys: false,
      hasDuplicateKnownKeys: true,
    });
    expect(parseManagerLocation('?section=rsvp')).toMatchObject({
      hasUnknownKeys: false,
      hasDuplicateKnownKeys: false,
    });
  });

  it('serializes section before mode and omits the default gallery mode', () => {
    expect(serializeManagerSearch({ section: 'gallery', mode: 'album' })).toBe(
      '?section=gallery&mode=album',
    );
    expect(serializeManagerSearch({ section: 'gallery', mode: 'library' })).toBe(
      '?section=gallery',
    );
  });

  it.each([
    { section: 'intake' },
    { section: 'rsvp' },
    { section: 'guestbook' },
    { section: 'share' },
    { section: 'settings' },
    { section: 'gallery', mode: 'library' },
    { section: 'gallery', mode: 'album' },
    { section: 'gallery', mode: 'guest-gallery' },
  ] as const)('round-trips canonical location %j', (location) => {
    const search = serializeManagerSearch(location);
    expect(parseManagerLocation(search)).toMatchObject({
      location,
      canonicalSearch: search,
      needsReplace: false,
    });
  });
});

describe('manager location paths', () => {
  it('builds a manager href from a canonical location', () => {
    expect(managerHref(EVENT, { section: 'gallery', mode: 'album' })).toBe(
      `/manage/event/${EVENT}?section=gallery&mode=album`,
    );
  });

  it.each([
    EVENT,
    EVENT.toUpperCase(),
  ])('recognizes a UUID-shaped manager event id: %s', (eventId) => {
    expect(isManagerEventId(eventId)).toBe(true);
    expect(managerEventIdFromPathname(`/manage/event/${eventId}`)).toBe(eventId);
  });

  it.each([
    '',
    'not-a-uuid',
    '11111111-2222-4333-8444-55555555555',
    '11111111-2222-4333-8444-555555555555-extra',
    '11111111-2222-4333-8444-55555555555/',
  ])('rejects malformed manager event id: %s', (eventId) => {
    expect(isManagerEventId(eventId)).toBe(false);
    expect(managerEventIdFromPathname(`/manage/event/${eventId}`)).toBeNull();
  });

  it.each([
    `/manage/event/${EVENT}`,
    `/manage/event/${EVENT}?section=gallery&mode=shared`,
    `/manage/event/${EVENT}?section=gallery&mode=wrong`,
  ])('canonicalizes a local manager return path: %s', (value) => {
    const result = canonicalManagerReturnPath(value);
    expect(result).not.toBeNull();
    expect(result?.eventId).toBe(EVENT);
    expect(result?.href).toBe(
      value.includes('section=gallery') && value.includes('mode=shared')
        ? `/manage/event/${EVENT}?section=gallery&mode=guest-gallery`
        : value.includes('mode=wrong')
          ? `/manage/event/${EVENT}?section=gallery`
          : `/manage/event/${EVENT}`,
    );
  });

  it.each([
    ['unknown key', `/manage/event/${EVENT}?section=rsvp&extra=1`],
    ['duplicate section', `/manage/event/${EVENT}?section=rsvp&section=gallery`],
    ['duplicate mode', `/manage/event/${EVENT}?section=gallery&mode=album&mode=guest-gallery`],
    ['fragment', `/manage/event/${EVENT}#saved`],
    ['bare fragment', `/manage/event/${EVENT}#`],
    ['bare fragment after canonical query', `/manage/event/${EVENT}?section=rsvp#`],
    ['foreign origin', `https://evil.example/manage/event/${EVENT}`],
    ['protocol-relative', `//evil.example/manage/event/${EVENT}`],
    ['malformed path', `/manage/event/${EVENT}/settings`],
    ['malformed event id', '/manage/event/not-a-uuid'],
    ['credentials', `https://user:pass@candidary.invalid/manage/event/${EVENT}`],
  ])('rejects %s return input', (_label, value) => {
    expect(canonicalManagerReturnPath(value)).toBeNull();
  });

  it('keeps the location contract dependency-free', () => {
    const location: ManagerLocation = { section: 'gallery', mode: 'guest-gallery' };
    expect(managerHref(EVENT, location)).toBe(
      `/manage/event/${EVENT}?section=gallery&mode=guest-gallery`,
    );
  });
});
