import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,x')) } }));

import type { EventView } from '../../shared/contracts';
import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import { resolveEventTheme } from '../../shared/event-theme';
import { createAppRouter } from '../../src/app/router';

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

function apiError(code: string, message: string, status: number) {
  return Promise.resolve(new Response(JSON.stringify({ code, message, requestId: 'request-a' }), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

const EVENT: EventView = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.',
  guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
  cover: {
    config: { version: 1, source: { kind: 'none' } }, revision: 0, hasCover: false,
    available2xProfiles: [], surfaceTreatment: 'none', preparation: null,
  },
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  reservedMediaCount: 0, storedMediaCount: 2, reservedBytes: 0, storedBytes: 2_048,
  recoverableMediaCount: 0, recoverableBytes: 0,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z', createdAt: '2026-07-29T00:00:00Z', deletedAt: null,
  eventTimezone: 'America/Chicago',
  eventStartAt: '2026-09-19T22:00:00.000Z', eventStartTime: '17:00',
  photosOpen: true, photoIntakeState: 'open', photoIntakeRecheckAfterMs: null,
  rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-05T04:59:59.999Z', rsvpDeadlineDate: '2026-09-04',
  rsvpRosterVersion: 0,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
};

const FIRST = {
  id: 'media-1', originalFilename: 'first-dance.jpg', guestName: 'Avery',
  caption: null, publicationStatus: 'unpublished' as const, uploadState: 'stored' as const,
  previewAvailable: true, width: 1_600, height: 900, createdAt: '2026-09-19T23:00:00.000Z',
};
const SECOND = {
  ...FIRST, id: 'media-2', originalFilename: 'cake.jpg', guestName: 'Bo',
  createdAt: '2026-09-19T23:05:00.000Z',
};

const TRASHED = {
  id: 'media-1', originalFilename: 'first-dance.jpg', guestName: 'Avery', caption: null,
  trashedAt: '2026-09-20T01:00:00.000Z',
  restoreUntil: '2026-10-19T00:00:00.000Z',
};

/**
 * The Manager, wired to a scriptable API.
 *
 * `calls` records every request in order, which is how "no request precedes the
 * confirmation" is asserted as a fact about the network rather than about which
 * button happened to be on screen.
 */
function managerFetch(options: {
  event?: EventView;
  media?: typeof FIRST[];
  trash?: typeof TRASHED[];
  onTrash?: () => Promise<Response>;
  onRestore?: () => Promise<Response>;
  onIntakeLoad?: () => Promise<Response> | null;
  onExports?: () => Promise<Response>;
} = {}) {
  const calls: string[] = [];
  const event = options.event ?? EVENT;
  let activeMedia = options.media ?? [FIRST, SECOND];
  let retainedMedia = options.trash ?? [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace('http://localhost', '')}`);
    if (url.endsWith('/api/manage/events/event-a')) return json({ event });
    if (url.endsWith('/gallery/summary')) return json({ summary: {
      albumPhotoCount: 0,
      albumEntryCount: 0,
      albumLink: { active: false, sharedAt: null },
      guestGalleryVisible: true,
      guestGalleryPublishedCount: 0,
    } });
    if (url.includes('/media/trash')) {
      return json({ media: retainedMedia, nextCursor: null });
    }
    if (url.includes('/media/') && url.endsWith('/trash')) {
      if (options.onTrash) return options.onTrash();
      const mediaId = url.match(/\/media\/([^/]+)\/trash$/u)?.[1] ?? TRASHED.id;
      const source = activeMedia.find(({ id }) => id === mediaId) ?? FIRST;
      const trashed = {
        id: source.id,
        originalFilename: source.originalFilename,
        guestName: source.guestName,
        caption: source.caption,
        trashedAt: TRASHED.trashedAt,
        restoreUntil: TRASHED.restoreUntil,
      };
      activeMedia = activeMedia.filter(({ id }) => id !== mediaId);
      retainedMedia = [trashed, ...retainedMedia.filter(({ id }) => id !== mediaId)];
      return json({ media: trashed });
    }
    if (url.includes('/media/') && url.endsWith('/restore')) {
      if (options.onRestore) return options.onRestore();
      const mediaId = url.match(/\/media\/([^/]+)\/restore$/u)?.[1] ?? FIRST.id;
      const restored = mediaId === SECOND.id ? SECOND : FIRST;
      retainedMedia = retainedMedia.filter(({ id }) => id !== mediaId);
      activeMedia = [restored, ...activeMedia.filter(({ id }) => id !== mediaId)];
      return json({ media: restored });
    }
    if (url.includes('/media')) {
      const scripted = options.onIntakeLoad?.();
      if (scripted) return scripted;
      return json({ media: activeMedia, nextCursor: null });
    }
    if (url.includes('/guestbook/summary')) {
      return json({ summary: { needsReviewCount: 0, sharedCount: 0, totalCount: 0, lastEntryAt: null } });
    }
    if (url.endsWith('/exports')) return (options.onExports ?? (() => json({ exports: [] })))();
    if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#a.b', disabledAt: null });
    if (url.includes('/rsvp/summary')) return json({});
    if (url.includes('/rsvp/households')) return json({ households: [], nextCursor: null });
    if (url.includes('/album')) return json({ album: { entries: [], photoCount: 0 } });
    if (url.includes('/messages')) return json({ messages: [] });
    throw new Error(`Unexpected request ${url}`);
  });
  return { calls, fetchMock };
}

async function openManager(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  const router = createAppRouter(['/manage/event/event-a']);
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: 'Live intake' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the event retention deadline', () => {
  it('renders purgeAfter in the event zone when the browser is on the next calendar day', async () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      const purgeAfter = '2026-09-20T02:30:00.000Z';
      expect(new Date(purgeAfter).getDate()).toBe(20);
      const { fetchMock } = managerFetch({
        event: { ...EVENT, purgeAfter, eventTimezone: 'America/Chicago' },
      });

      await openManager(fetchMock);

      const deadline = screen.getByText('September 19, 2026 at 9:30 PM CDT', {
        selector: 'time',
      });
      expect(deadline).toHaveAttribute('datetime', purgeAfter);
      expect(deadline.closest('p'))
        .toHaveTextContent('Files delete September 19, 2026 at 9:30 PM CDT');
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it('fails closed without semantic time for an invalid purgeAfter', async () => {
    const { fetchMock } = managerFetch({
      event: { ...EVENT, purgeAfter: 'not-a-timestamp' },
    });

    await openManager(fetchMock);

    const deadline = screen.getByText('Time unavailable');
    const retention = deadline.closest('p');
    expect(retention).toHaveTextContent('Files delete Time unavailable');
    expect(retention?.querySelector('time')).toBeNull();
  });
});

describe('manager access recovery destinations', () => {
  it('preserves the Manager destination in recovery from canonical Album', async () => {
    const eventId = '11111111-2222-4333-8444-555555555555';
    vi.stubGlobal('fetch', vi.fn(() => apiError(
      'SESSION_EXPIRED',
      'This management session has expired.',
      401,
    )));
    render(<RouterProvider router={createAppRouter([
      `/manage/event/${eventId}?section=gallery&mode=album`,
    ])} />);

    const signIn = await screen.findByRole('link', { name: 'Sign in' });
    const signInUrl = new URL(signIn.getAttribute('href')!, window.location.origin);
    expect(signInUrl.searchParams.get('returnTo'))
      .toBe(`/manage/event/${eventId}?section=gallery&mode=album`);
  });
});

describe('moving a photo to Recently deleted', () => {
  it('sends no request until the confirmation is explicitly activated', async () => {
    const user = userEvent.setup();
    const { calls, fetchMock } = managerFetch();
    await openManager(fetchMock);

    await user.click(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /Move this photo to Recently deleted\?/i })).toBeInTheDocument();
    expect(calls.some((call) => call.includes('/trash'))).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Move to Recently deleted' }));
    await waitFor(() => {
      expect(calls.filter((call) => call === 'POST /api/manage/events/event-a/media/media-1/trash')).toHaveLength(1);
    });
  });

  it('states every boundary the host is agreeing to', async () => {
    const user = userEvent.setup();
    const { fetchMock } = managerFetch();
    await openManager(fetchMock);
    await user.click(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i }));

    const dialog = await screen.findByRole('dialog');
    const body = dialog.textContent ?? '';
    // Where it stops being visible, and what cannot be taken back.
    expect(body).toMatch(/Library/);
    expect(body).toMatch(/Album/);
    expect(body).toMatch(/Guest gallery/i);
    expect(body).toMatch(/cannot be recalled/i);
    // How long recovery lasts, and the two things that shorten it.
    expect(body).toMatch(/30 days/);
    expect(body).toMatch(/management access/i);
    // That the retained photo keeps spending capacity, and that a prepared export keeps its copy.
    expect(body).toMatch(/capacity/i);
    expect(body).toMatch(/already prepared/i);
    // The exact deadline does not exist yet, so the dialog must not claim one.
    expect(body).not.toMatch(/October 19/);
  });

  it('opens on Keep photo and returns focus to the control that opened it', async () => {
    const user = userEvent.setup();
    const { calls, fetchMock } = managerFetch();
    await openManager(fetchMock);

    const trigger = await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Keep photo' })).toHaveFocus();
    });

    await user.click(within(dialog).getByRole('button', { name: 'Keep photo' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
    expect(calls.some((call) => call.includes('/trash'))).toBe(false);
  });

  it('cancels on Escape without sending a request', async () => {
    const user = userEvent.setup();
    const { calls, fetchMock } = managerFetch();
    await openManager(fetchMock);

    const trigger = await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i });
    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
    expect(calls.some((call) => call.includes('/trash'))).toBe(false);
  });

  it('is not the dialog default submit and stays idempotent under double activation', async () => {
    const user = userEvent.setup();
    const { calls, fetchMock } = managerFetch();
    await openManager(fetchMock);
    await user.click(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i }));

    const dialog = await screen.findByRole('dialog');
    const destructive = within(dialog).getByRole('button', { name: 'Move to Recently deleted' });
    expect(destructive).toHaveAttribute('type', 'button');
    // Enter on the initially focused control must not reach the destructive one.
    await user.keyboard('{Enter}');
    expect(calls.some((call) => call.includes('/media/media-1/trash'))).toBe(false);

    await user.click(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i }));
    const reopened = await screen.findByRole('dialog');
    const button = within(reopened).getByRole('button', { name: 'Move to Recently deleted' });
    await user.click(button);
    await user.click(button).catch(() => undefined);
    await waitFor(() => {
      expect(calls.filter((call) => call === 'POST /api/manage/events/event-a/media/media-1/trash')).toHaveLength(1);
    });
  });

  it('announces the photo and the server deadline, and offers Undo', async () => {
    const user = userEvent.setup();
    const { fetchMock } = managerFetch();
    await openManager(fetchMock);
    await user.click(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move to Recently deleted' }));

    // The deadline comes from the response, rendered in the event's zone —
    // 2026-10-19T00:00Z is still the 18th in America/Chicago.
    const announced = () => screen.getAllByRole('status').map((node) => node.textContent ?? '').join(' ');
    await waitFor(() => expect(announced()).toMatch(/first-dance\.jpg moved to Recently deleted/));
    expect(announced()).toMatch(/October 18, 2026/);
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('retires an older offer before a deferred trash forward owns the replacement slot', async () => {
    let trashRequest = 0;
    let resolveSecondTrash!: (response: Response) => void;
    const secondTrash = new Promise<Response>((resolve) => { resolveSecondTrash = resolve; });
    const secondTrashed = {
      ...TRASHED,
      id: SECOND.id,
      originalFilename: SECOND.originalFilename,
      guestName: SECOND.guestName,
    };
    const { fetchMock } = managerFetch({
      onTrash: () => {
        trashRequest += 1;
        return trashRequest === 1 ? json({ media: TRASHED }) : secondTrash;
      },
    });
    const user = userEvent.setup();
    await openManager(fetchMock);

    await user.click(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i }));
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Move to Recently deleted' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();

    await user.click(await screen.findByRole('button', { name: /Move cake\.jpg to Recently deleted/i }));
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Move to Recently deleted' }));
    await waitFor(() => expect(trashRequest).toBe(2));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();

    resolveSecondTrash(await json({ media: secondTrashed }));
    const replacement = await screen.findByRole('button', { name: 'Undo' });
    expect(replacement.closest('.album-undo__bar'))
      .toHaveTextContent('cake.jpg moved to Recently deleted.');
  });

  it('keeps one Manager Undo bar and its API-only restore offer across an Intake unmount', async () => {
    const user = userEvent.setup();
    const { calls, fetchMock } = managerFetch();
    await openManager(fetchMock);
    await user.click(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move to Recently deleted' }));

    const undo = await screen.findByRole('button', { name: 'Undo' });
    expect(document.querySelectorAll('.manager-main > .album-undo')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByRole('heading', { name: 'Share your event' })).toBeVisible();
    expect(undo).toBeInTheDocument();

    await user.click(undo);
    await waitFor(() => {
      expect(calls.filter((call) => call === 'POST /api/manage/events/event-a/media/media-1/restore'))
        .toHaveLength(1);
    });
  });

  it('invalidates exactly the four affected Manager resources after trash confirms', async () => {
    const user = userEvent.setup();
    const { calls, fetchMock } = managerFetch();
    await openManager(fetchMock);
    const count = (suffix: string) => calls.filter((call) => call.endsWith(suffix)).length;
    await waitFor(() => {
      expect(count('/gallery/summary')).toBe(1);
      expect(count('/guestbook/summary')).toBe(1);
      expect(count('/exports')).toBe(1);
      expect(count('/entry')).toBe(1);
    });

    await user.click(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move to Recently deleted' }));

    await waitFor(() => {
      expect(count('/api/manage/events/event-a')).toBe(2);
      expect(count('/media')).toBe(2);
      expect(count('/gallery/summary')).toBe(2);
      expect(count('/guestbook/summary')).toBe(2);
    });
    expect(count('/exports')).toBe(1);
    expect(count('/entry')).toBe(1);
  });

  it('removes the card and moves focus to the next one', async () => {
    const user = userEvent.setup();
    const { fetchMock } = managerFetch();
    await openManager(fetchMock);
    await user.click(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move to Recently deleted' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i })).toBeNull();
    });
    expect(screen.getByRole('button', { name: /Move cake\.jpg to Recently deleted/i })).toBeInTheDocument();
  });

  it.each([
    {
      label: 'next card',
      media: [FIRST, SECOND],
      filename: 'first-dance.jpg',
      fallback: () => screen.getByRole('link', { name: 'Download original cake.jpg' }),
    },
    {
      label: 'previous card',
      media: [FIRST, SECOND],
      filename: 'cake.jpg',
      fallback: () => screen.getByRole('link', { name: 'Download original first-dance.jpg' }),
    },
    {
      label: 'Intake heading',
      media: [FIRST],
      filename: 'first-dance.jpg',
      fallback: () => screen.getByRole('heading', { name: 'Live intake' }),
    },
  ])('establishes the $label fallback before a pointer trash offer', async ({ media, filename, fallback }) => {
    const user = userEvent.setup();
    const { fetchMock } = managerFetch({ media });
    await openManager(fetchMock);
    await user.click(await screen.findByRole('button', {
      name: `Move ${filename} to Recently deleted`,
    }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move to Recently deleted' }));

    await screen.findByRole('button', { name: 'Undo' });
    expect(fallback()).toHaveFocus();
  });

  it('focuses Undo for keyboard confirmation and falls back to the current section heading once Intake disconnects', async () => {
    const user = userEvent.setup();
    const { fetchMock } = managerFetch();
    await openManager(fetchMock);
    await user.click(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Move to Recently deleted',
    }), { detail: 0 });

    const undo = await screen.findByRole('button', { name: 'Undo' });
    await waitFor(() => expect(undo).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Share' }));
    const shareHeading = await screen.findByRole('heading', { name: 'Share your event' });
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(shareHeading).toHaveFocus();
  });

  it('keeps the shell and reports a rejected transition as a notice', async () => {
    const user = userEvent.setup();
    const { fetchMock } = managerFetch({
      onTrash: () => apiError('MEDIA_STATE_CONFLICT', 'This photo is no longer available.', 409),
    });
    await openManager(fetchMock);
    await user.click(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move to Recently deleted' }));

    expect(await screen.findByText('This photo is no longer available.')).toBeInTheDocument();
    // The photo is still on screen: a refused removal removes nothing.
    expect(screen.getByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Live intake' })).toBeInTheDocument();
  });
});

describe('Recently deleted', () => {
  it('is a filter over Intake, and its URL never carries the live list filters', async () => {
    const user = userEvent.setup();
    const { calls, fetchMock } = managerFetch({ trash: [TRASHED] });
    await openManager(fetchMock);

    await user.type(screen.getByLabelText('Filter by guest name'), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => {
      expect(calls.some((call) => call.includes('guestName=Avery'))).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: /^Recently deleted/ }));
    await screen.findByRole('heading', { name: 'Recently deleted' });

    const trashCalls = calls.filter((call) => call.includes('/media/trash'));
    expect(trashCalls.length).toBeGreaterThan(0);
    for (const call of trashCalls) {
      expect(call).not.toMatch(/guestName/);
      expect(call).not.toMatch(/status=/);
    }
  });

  it('lists the deadline and offers Restore before it, and neither after', async () => {
    const user = userEvent.setup();
    const expired = { ...TRASHED, id: 'media-9', restoreUntil: '2020-01-01T00:00:00.000Z' };
    const { fetchMock } = managerFetch({ trash: [TRASHED, expired] });
    await openManager(fetchMock);
    await user.click(screen.getByRole('button', { name: /^Recently deleted/ }));

    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/Restore until/);
    expect(within(rows[0]!).getByRole('button', { name: /Restore/ })).toBeInTheDocument();

    expect(rows[1]!.textContent).toMatch(/Recovery expired · cleanup pending/);
    expect(within(rows[1]!).queryByRole('button', { name: /Restore/ })).toBeNull();
  });

  it('removes Restore while Recently deleted stays open through its nearest deadline', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-20T01:00:00.000Z'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const expiring = { ...TRASHED, restoreUntil: '2026-09-20T01:00:01.000Z' };
    const { fetchMock } = managerFetch({ trash: [expiring] });
    await openManager(fetchMock);
    await user.click(screen.getByRole('button', { name: /^Recently deleted/ }));

    expect(await screen.findByRole('button', { name: /Restore/ })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1_000); });

    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
    expect(screen.getByText('Recovery expired · cleanup pending')).toBeInTheDocument();
  });

  it('says the retained photos still use event capacity', async () => {
    const user = userEvent.setup();
    const { fetchMock } = managerFetch({ trash: [TRASHED] });
    await openManager(fetchMock);
    await user.click(screen.getByRole('button', { name: /^Recently deleted/ }));

    expect(await screen.findByText(/still use this event's capacity/i)).toBeInTheDocument();
  });

  it('offers no original download for a retained photo', async () => {
    const user = userEvent.setup();
    const { fetchMock } = managerFetch({ trash: [TRASHED] });
    await openManager(fetchMock);
    await user.click(screen.getByRole('button', { name: /^Recently deleted/ }));

    await screen.findAllByRole('listitem');
    expect(screen.queryByRole('link', { name: /Download original/i })).toBeNull();
    expect(screen.queryByRole('img', { name: /first-dance/i })).toBeNull();
  });

  it('removes a restored row and announces its return', async () => {
    const user = userEvent.setup();
    const { calls, fetchMock } = managerFetch({ trash: [TRASHED] });
    await openManager(fetchMock);
    await user.click(screen.getByRole('button', { name: /^Recently deleted/ }));

    await user.click(await screen.findByRole('button', { name: /Restore/ }));
    await waitFor(() => {
      expect(calls).toContain('POST /api/manage/events/event-a/media/media-1/restore');
    });
    await waitFor(() => expect(screen.queryAllByRole('listitem')).toHaveLength(0));
    const announcements = screen.getAllByRole('status').map((node) => node.textContent ?? '').join(' ');
    expect(announcements).toMatch(/first-dance\.jpg is back in Live intake/);
  });

  it('uses the same exact four-owner invalidation boundary for direct Restore', async () => {
    const user = userEvent.setup();
    const { calls, fetchMock } = managerFetch({ trash: [TRASHED] });
    await openManager(fetchMock);
    await user.click(screen.getByRole('button', { name: /^Recently deleted/ }));
    await screen.findByRole('button', { name: 'Restore first-dance.jpg' });
    const count = (suffix: string) => calls.filter((call) => call.endsWith(suffix)).length;
    const mediaReadsBeforeRestore = calls.filter((call) => call.startsWith('GET ') && call.includes('/media')).length;

    await user.click(screen.getByRole('button', { name: 'Restore first-dance.jpg' }));

    await waitFor(() => {
      expect(count('/api/manage/events/event-a')).toBe(2);
      expect(count('/gallery/summary')).toBe(2);
      expect(count('/guestbook/summary')).toBe(2);
      expect(calls.filter((call) => call.startsWith('GET ') && call.includes('/media')))
        .toHaveLength(mediaReadsBeforeRestore + 1);
    });
    expect(count('/exports')).toBe(1);
    expect(count('/entry')).toBe(1);
  });
});

describe('the capacity meter', () => {
  it('counts retained photos and names them', async () => {
    const { fetchMock } = managerFetch({
      event: { ...EVENT, storedMediaCount: 2, storedBytes: 2_048, recoverableMediaCount: 3, recoverableBytes: 3_072 },
    });
    await openManager(fetchMock);

    const capacity = screen.getByText('Event capacity').closest('section');
    expect(capacity?.textContent).toMatch(/5 of 10,000/);
    expect(capacity?.textContent).toMatch(/Includes 3 in Recently deleted/);
  });
});

describe('Manager resource ownership', () => {
  it('keeps every other panel when one resource fails retryably', async () => {
    const { fetchMock } = managerFetch({
      onExports: () => apiError('INTERNAL_ERROR', 'Something went wrong.', 500),
    });
    await openManager(fetchMock);

    // The shell, the header, the nav and Intake are all still here.
    expect(screen.getByRole('heading', { name: 'Live intake' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Maya & Theo' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i })).toBeInTheDocument();
    expect(screen.queryByText('Event manager unavailable')).toBeNull();
  });

  it('keeps its own Retry inside the failing panel and preserves the siblings', async () => {
    const user = userEvent.setup();
    let intakeReads = 0;
    const { fetchMock } = managerFetch({
      onIntakeLoad: () => {
        intakeReads += 1;
        return intakeReads === 1
          ? apiError('INTERNAL_ERROR', 'Something went wrong.', 500)
          : json({ media: [FIRST], nextCursor: null });
      },
    });
    await openManager(fetchMock);

    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByRole('heading', { name: 'Maya & Theo' })).toBeInTheDocument();

    await user.click(retry);
    expect(await screen.findByRole('button', { name: /Move first-dance\.jpg to Recently deleted/i })).toBeInTheDocument();
  });

  it('escalates a credential failure from a noncritical resource to the recovery surface', async () => {
    const { fetchMock } = managerFetch({
      onExports: () => apiError('TOKEN_REVOKED', 'This management link was replaced.', 401),
    });
    await openManager(fetchMock);

    // A revoked credential is never a retryable panel outage, so it leaves the
    // exports panel and reaches the recovery surface — with no Try again, which
    // would only fail the same way.
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('This management link was replaced.');
    expect(notice).toHaveTextContent('Open the latest management link you saved to start again.');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    // And the Manager the host was working in survives it.
    expect(screen.getByRole('heading', { name: 'Live intake' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Maya & Theo' })).toBeInTheDocument();
  });

  it('takes the page only when the event itself never loaded', async () => {
    const { fetchMock } = managerFetch({});
    const failing = vi.fn((input: RequestInfo | URL, init?: RequestInit) => (
      String(input).endsWith('/api/manage/events/event-a')
        ? apiError('TOKEN_REVOKED', 'This management link was replaced.', 401)
        : fetchMock(input, init)
    ));
    vi.stubGlobal('fetch', failing);
    const router = createAppRouter(['/manage/event/event-a']);
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: 'Event manager unavailable' })).toBeInTheDocument();
    expect(screen.getByText('This management link was replaced.')).toBeInTheDocument();
  });
});
