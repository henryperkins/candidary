import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GuestUploadFlow } from '../../src/features/uploads/GuestUploadFlow';
import type { UploadQueueItem, UploadTransport } from '../../src/features/uploads/upload-queue';

const event = {
  name: 'Alex & Jordan',
  eventDate: '2026-09-14',
  welcomeMessage: 'Help us remember tonight.',
  uploadsEnabled: true,
};

function transport(): UploadTransport {
  return {
    reserve: vi.fn(async (items: readonly UploadQueueItem[]) => items.map(({ id }) => ({
      id,
      status: 'accepted' as const,
      reservation: { mediaId: `media-${id}`, uploadUrl: `https://upload.test/${id}`, mimeType: 'image/jpeg' },
    }))),
    upload: vi.fn(async (_item, _reservation, progress) => progress(100)),
    finalize: vi.fn(async () => undefined),
  };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('mobile guest photo delivery', () => {
  it('requires and remembers a name before opening either photo source', async () => {
    const user = userEvent.setup();
    render(<GuestUploadFlow event={event} slug="alex-jordan" transport={transport()} />);
    const name = screen.getByLabelText('Your name');

    await user.click(screen.getByRole('button', { name: 'Take a photo' }));
    expect(screen.getByText('Enter your name before adding photos.')).toBeVisible();
    expect(name).toHaveFocus();

    await user.type(name, 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Take a photo' }));
    expect(localStorage.getItem('candidary_guest_name')).toBe('Taylor Morgan');
    expect(screen.getByLabelText('Take a photo from your camera')).toHaveAttribute('capture', 'environment');
    expect(screen.getByLabelText('Take a photo from your camera')).not.toHaveAttribute('multiple');
    expect(screen.getByLabelText('Choose recent photos from your library')).toHaveAttribute('multiple');
  });

  it('returns a new capture selected, appends recents, and waits for explicit Send', async () => {
    const user = userEvent.setup();
    const queueTransport = transport();
    render(<GuestUploadFlow event={event} slug="alex-jordan" transport={queueTransport} />);
    await user.type(screen.getByLabelText('Your name'), 'Taylor');

    const camera = screen.getByLabelText('Take a photo from your camera');
    const library = screen.getByLabelText('Choose recent photos from your library');
    fireEvent.change(camera, { target: { files: [new File(['new'], 'just-taken.jpg', { type: 'image/jpeg' })] } });
    expect(await screen.findByText('New')).toBeVisible();
    expect(screen.getByText('1 photo selected')).toBeVisible();

    fireEvent.change(library, { target: { files: [new File(['recent'], 'recent.jpg', { type: 'image/jpeg' })] } });
    expect(screen.getByText('2 photos selected')).toBeVisible();
    expect(queueTransport.reserve).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send 2 photos' }));
    await waitFor(() => expect(queueTransport.finalize).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: 'Your 2 photos were sent.' })).toBeVisible();
    expect(screen.getByText(/all done and can close this page/i)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/gallery|note/i)).not.toBeInTheDocument();
  });

  it('lets a returning guest reach the camera with one tap', async () => {
    localStorage.setItem('candidary_guest_name', 'Avery');
    render(<GuestUploadFlow event={event} slug="alex-jordan" transport={transport()} />);
    expect(screen.getByText('Sending as Avery')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit name' })).toBeVisible();
  });
});
