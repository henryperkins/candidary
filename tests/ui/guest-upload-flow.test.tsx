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

function deferredTransport(): UploadTransport {
  return {
    ...transport(),
    upload: vi.fn((_item, _reservation, _progress, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Sending was cancelled.', 'AbortError')), { once: true });
    })),
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it('keeps the event name and date in the review header', async () => {
    render(<GuestUploadFlow event={event} slug="alex-jordan" transport={transport()} />);
    await userEvent.type(screen.getByLabelText('Your name'), 'Taylor');

    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['keeper'], 'keeper.jpg', { type: 'image/jpeg' })] },
    });

    expect(await screen.findByRole('heading', { name: 'Ready to send' })).toBeVisible();
    const identity = screen.getByText(/Alex & Jordan/);
    expect(identity).toBeVisible();
    expect(identity).toHaveTextContent('Sep 14');
  });

  it('receipts the delivered photo when an invalid file stays behind', async () => {
    const user = userEvent.setup();
    const queueTransport = transport();
    render(<GuestUploadFlow event={event} slug="alex-jordan" transport={queueTransport} />);
    await user.type(screen.getByLabelText('Your name'), 'Taylor');

    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: {
        files: [
          new File(['keeper'], 'keeper.jpg', { type: 'image/jpeg' }),
          new File(['notes'], 'notes.txt', { type: 'text/plain' }),
        ],
      },
    });
    expect(await screen.findByText('2 photos selected')).toBeVisible();

    expect(screen.queryByRole('button', { name: /^Retry/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send 1 photo' }));
    await waitFor(() => expect(queueTransport.finalize).toHaveBeenCalledTimes(1));

    expect(await screen.findByRole('heading', { name: 'Your 1 photo was sent.' })).toBeVisible();
    expect(screen.getByText('1 photo could not be added.')).toBeVisible();
  });

  it('holds an all-invalid selection in review with recovery guidance', async () => {
    render(<GuestUploadFlow event={event} slug="alex-jordan" transport={transport()} />);
    await userEvent.type(screen.getByLabelText('Your name'), 'Taylor');

    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    });

    expect(await screen.findByText('1 photo selected')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Send/u })).not.toBeInTheDocument();
    expect(screen.getByText('Remove or replace the photos that need attention.')).toBeVisible();
    expect(screen.queryByText('Keep this page open while your photos transfer.')).not.toBeInTheDocument();
  });

  it('accepts vendor HEIC MIME values provisionally for final server inspection', async () => {
    render(<GuestUploadFlow event={event} slug="alex-jordan" transport={transport()} />);
    await userEvent.type(screen.getByLabelText('Your name'), 'Taylor');

    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['heic'], 'phone.heic', { type: 'image/x-heic' })] },
    });

    expect(await screen.findByText('1 photo selected')).toBeVisible();
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send 1 photo' })).toBeEnabled();
  });

  it('keeps the send action mounted while sending and recovers a cancelled transfer', async () => {
    const user = userEvent.setup();
    const queueTransport = deferredTransport();
    render(<GuestUploadFlow event={event} slug="alex-jordan" transport={queueTransport} />);
    await user.type(screen.getByLabelText('Your name'), 'Taylor');

    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['keeper'], 'keeper.jpg', { type: 'image/jpeg' })] },
    });
    expect(await screen.findByText('1 photo selected')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Send 1 photo' }));
    expect(screen.getByRole('heading', { name: 'Sending photos' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel sending' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Cancel sending' }));

    expect(await screen.findByRole('button', { name: 'Retry 1 photo' })).toBeEnabled();
    expect(screen.getByText('Sending was cancelled. Retry when you are ready.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Ready to send' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel sending' })).not.toBeInTheDocument();
    expect(queueTransport.finalize).not.toHaveBeenCalled();
  });

  it('aborts the shipped adapter when the guest flow unmounts', async () => {
    let reserveSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      reserveSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        reserveSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('Sending was cancelled.', 'AbortError')),
          { once: true },
        );
      });
    }));
    const view = render(<GuestUploadFlow event={event} slug="alex-jordan" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your name'), 'Taylor');
    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['keeper'], 'keeper.jpg', { type: 'image/jpeg' })] },
    });
    await user.click(await screen.findByRole('button', { name: 'Send 1 photo' }));
    await waitFor(() => expect(reserveSignal).toBeDefined());

    view.unmount();

    expect(reserveSignal?.aborted).toBe(true);
  });

  it('turns shipped-adapter cancellation into visible retry guidance', async () => {
    let reserveSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      reserveSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        reserveSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('Sending was cancelled.', 'AbortError')),
          { once: true },
        );
      });
    }));
    render(<GuestUploadFlow event={event} slug="alex-jordan" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your name'), 'Taylor');
    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['keeper'], 'keeper.jpg', { type: 'image/jpeg' })] },
    });
    await user.click(await screen.findByRole('button', { name: 'Send 1 photo' }));
    await waitFor(() => expect(reserveSignal).toBeDefined());

    await user.click(screen.getByRole('button', { name: 'Cancel sending' }));

    expect(reserveSignal?.aborted).toBe(true);
    expect(await screen.findByRole('button', { name: 'Retry 1 photo' })).toBeEnabled();
    expect(screen.getByText('Sending was cancelled. Retry when you are ready.')).toBeVisible();
  });

  it('lets a returning guest reach the camera with one tap', async () => {
    localStorage.setItem('candidary_guest_name', 'Avery');
    render(<GuestUploadFlow event={event} slug="alex-jordan" transport={transport()} />);
    expect(screen.getByText('Sending as Avery')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit name' })).toBeVisible();
  });

  // iOS Safari with "Block All Cookies" throws on the storage access itself rather than returning
  // null, so the drop has to keep working without the convenience of a remembered name.
  it('still delivers when the browser refuses local storage', async () => {
    const user = userEvent.setup();
    const blocked = {
      getItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError'); },
      setItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    };
    vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue(blocked as unknown as Storage);

    render(<GuestUploadFlow event={event} slug="alex-jordan" transport={transport()} />);
    await user.type(screen.getByLabelText('Your name'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Take a photo' }));

    expect(screen.queryByText('Enter your name before adding photos.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Take a photo from your camera')).toBeInTheDocument();
  });
});
