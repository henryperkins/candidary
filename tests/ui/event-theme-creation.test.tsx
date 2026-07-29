import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { createAppRouter } from '../../src/app/router';
import { RouterProvider } from 'react-router-dom';

const CREATED = {
  event: { id: 'event-a', name: 'Maya & Theo', slug: 'maya-theo' },
  guestLink: 'https://example.test/join/guest-secret',
  managementLink: 'https://example.test/manage/manager-secret',
  csrfToken: 'csrf-a',
};

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('selects a theme during creation and submits its canonical configuration', async () => {
  const fetchMock = vi.fn<typeof fetch>(() => json(CREATED, 201));
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  render(<RouterProvider router={createAppRouter(['/create'])} />);

  const defaultTheme = screen.getByRole('radio', { name: 'Candidary Default' });
  expect(defaultTheme).toBeChecked();
  expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-label'))).toEqual([
    'Candidary Default', 'Garden Party', 'Midnight Film', 'Coastal Light',
  ]);

  defaultTheme.focus();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('radio', { name: 'Garden Party' })).toBeChecked();

  const themeSelector = screen.getByRole('group', { name: 'Event appearance' });
  const welcomeMessage = screen.getByLabelText('Welcome message');
  const coverPhoto = screen.getByText('Cover photo').closest('label');
  expect(coverPhoto).not.toBeNull();
  expect(welcomeMessage.compareDocumentPosition(themeSelector) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(themeSelector.compareDocumentPosition(coverPhoto!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  await user.click(screen.getByRole('radio', { name: 'Coastal Light' }));
  expect(screen.getByRole('radio', { name: 'Coastal Light' })).toBeChecked();
  expect(screen.getByRole('heading', { name: 'Event details' })).toBeVisible();

  await user.type(screen.getByLabelText('Event name'), 'Maya & Theo');
  await user.type(screen.getByLabelText('Event date'), '2026-09-19');
  await user.type(welcomeMessage, 'Come share the moments you caught.');
  await user.click(screen.getByRole('button', { name: 'Create private event' }));
  await screen.findByRole('heading', { name: 'Your event is ready.' });

  expect(fetchMock).toHaveBeenCalledOnce();
  const [, request] = fetchMock.mock.calls[0]!;
  expect(JSON.parse(String(request?.body))).toEqual({
    name: 'Maya & Theo',
    eventDate: '2026-09-19',
    welcomeMessage: 'Come share the moments you caught.',
    theme: { version: 1, presetId: 'coastal-light', overrides: {} },
  });
});
