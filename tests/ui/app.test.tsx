import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '../../src/app/router';

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('public Candidary experience', () => {
  it('presents the approved value proposition and workflow', () => {
    render(<RouterProvider router={createAppRouter(['/'])} />);
    expect(screen.getByRole('heading', { name: 'Gather the moments you didn’t see.' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Create your event' })).toHaveAttribute('href', '/create');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('creates an event and clearly returns both access links', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({
      event: { id: 'event-a', name: 'Maya & Theo', slug: 'maya-theo' },
      guestLink: 'https://example.test/join/guest-secret',
      managementLink: 'https://example.test/manage/manager-secret', csrfToken: 'csrf-a',
    }, 201)));
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Event name'), 'Maya & Theo');
    await user.type(screen.getByLabelText('Event date'), '2026-09-19');
    await user.type(screen.getByLabelText('Welcome message'), 'Come share the moments you caught.');
    await user.click(screen.getByRole('button', { name: 'Create private event' }));
    expect(await screen.findByRole('heading', { name: 'Your event is ready.' })).toBeVisible();
    expect(screen.getByText('Guest link')).toBeVisible();
    expect(screen.getByText('Management link')).toBeVisible();
    expect(screen.getByText(/cannot be recovered/i)).toBeVisible();
  });
});

describe('guest event experience', () => {
  it('loads the private photo drop first and keeps the gallery and notes secondary', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: {
        id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
        welcomeMessage: 'We would love to see the day through your eyes.', uploadsEnabled: true,
        galleryVisible: true, moderationRequired: true,
      }, role: 'guest' });
      if (url.endsWith('/gallery')) return json({ media: [{
        id: 'media-a', originalFilename: 'toast.png', guestName: 'Avery', caption: 'Golden hour',
        publicationStatus: 'published', uploadState: 'stored', width: 800, height: 600,
      }] });
      if (url.endsWith('/contributions')) return json({ media: [] });
      if (url.endsWith('/messages')) return json({ items: [{ id: 'note-a', kind: 'message', guestName: 'Sam', body: 'To many happy years.', createdAt: '2026-09-19T20:00:00Z', moderationStatus: 'approved' }] });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();
    expect(screen.getByText(/Maya & Theo/, { selector: '.photo-drop__event' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Choose recent photos' })).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByText(/Shared gallery/, { selector: 'span' }));
    expect(await screen.findByAltText('Golden hour')).toBeVisible();
    await user.click(screen.getByText(/Leave a note/, { selector: 'span' }));
    expect(screen.getByText('To many happy years.')).toBeVisible();
  });
});

describe('manager experience', () => {
  it('loads the management summary and moderates selected pending media only', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: {
        id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
        welcomeMessage: 'Welcome.', uploadsEnabled: true, galleryVisible: true,
        moderationRequired: true, storedMediaCount: 2, storedBytes: 128,
        guestAccessExpiresAt: '2026-10-19T00:00:00Z', purgeAfter: '2026-12-19T00:00:00Z',
      } });
      if (url.includes('/media')) {
        if (init?.method === 'POST') return json({ changed: ['media-a'] });
        return json({ media: [
          { id: 'media-a', originalFilename: 'toast.png', guestName: 'Avery', caption: 'The toast', moderationStatus: 'pending', uploadState: 'stored' },
          { id: 'media-b', originalFilename: 'dance.png', guestName: 'Jamie', caption: 'First dance', moderationStatus: 'pending', uploadState: 'stored' },
        ] });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Maya & Theo' })).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: /toast.png/i }));
    await user.click(screen.getByRole('button', { name: 'Approve selected' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/manage/events/event-a/media/bulk',
      expect.objectContaining({ body: expect.stringContaining('media-a') }),
    ));
    const bulkCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/media/bulk'));
    expect(bulkCall?.[1]?.body).not.toContain('media-b');
  });
});
