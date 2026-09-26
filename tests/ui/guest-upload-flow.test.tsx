import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { File as RuntimeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { BASELINE_UPLOAD_CAPABILITIES } from '../../src/features/uploads/upload-selection';

import {
  GuestUploadFlow as ControlledGuestUploadFlow,
  type GuestUploadEvent,
} from '../../src/features/uploads/GuestUploadFlow';
import { readGuestName, rememberGuestName } from '../../src/app/guest-name-storage';
import { GuestPhotoUpload } from '../../src/pages/EventPage';
import { useGuestUploadSession } from '../../src/features/uploads/use-guest-upload-session';
import type { UploadQueueItem, UploadTransport } from '../../src/features/uploads/upload-queue';

const event = {
  name: 'Alex & Jordan',
  eventDate: '2026-09-14',
  welcomeMessage: 'Help us remember tonight.',
  uploadsEnabled: true,
  cover: {
    revision: 0, hasCover: false, available2xProfiles: [], surfaceTreatment: 'none' as const,
  },
};

function GuestUploadFlow({
  event: uploadEvent,
  slug,
  transport: uploadTransport,
  onDelivered,
  guestName,
  onGuestNameChange,
  onLeaveGuestbook,
}: {
  event: GuestUploadEvent;
  slug: string;
  transport?: UploadTransport;
  onDelivered?: (count: number) => void;
  guestName?: string;
  onGuestNameChange?: (name: string) => void;
  onLeaveGuestbook?: () => void;
}) {
  const [fallbackName, setFallbackName] = useState(readGuestName);
  const currentName = guestName ?? fallbackName;
  const changeName = (name: string) => {
    if (guestName === undefined) {
      setFallbackName(name);
      rememberGuestName(name);
    }
    onGuestNameChange?.(name);
  };
  const session = useGuestUploadSession({
    slug,
    guestName: currentName,
    uploadsAvailable: uploadEvent.uploadsEnabled,
    transport: uploadTransport,
    onDelivered,
  });
  return <ControlledGuestUploadFlow
    event={uploadEvent}
    slug={slug}
    session={session}
    uploadsAvailable={uploadEvent.uploadsEnabled}
    unavailableMessage="The host has paused photo delivery for now."
    guestName={currentName}
    onGuestNameChange={changeName}
    onLeaveGuestbook={onLeaveGuestbook}
  />;
}

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

/* The shipped transfer, with only the network stubbed. The bytes leave over XHR so the guest sees
   progress, and nothing about the request depends on the reservation answer beyond where to put the
   photo and what to call it. */
class DeliveringXMLHttpRequest {
  static requests: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];

  status = 200;
  withCredentials = false;
  readonly upload = { addEventListener: () => {} };
  private readonly listeners = new Map<string, Set<() => void>>();
  private method = '';
  private url = '';
  private readonly headers: Record<string, string> = {};

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  abort() {}

  send(body: unknown) {
    DeliveringXMLHttpRequest.requests.push({
      method: this.method,
      url: this.url,
      headers: { ...this.headers },
      body,
    });
    for (const listener of this.listeners.get('load') ?? []) listener();
  }
}

function uploadJson(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{
      target,
      contentRect: { width: 390 } as DOMRectReadOnly,
    } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  localStorage.clear();
  DeliveringXMLHttpRequest.requests = [];
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mobile guest photo delivery', () => {
  it.each(['creation', 'decode'] as const)('delivers the same original after thumbnail %s failure and cleans up only created URLs', async (failure) => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => {
      if (failure === 'creation') throw new Error('unavailable');
      return 'blob:guest-original';
    } });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const queueTransport = transport();
    const view = render(<GuestUploadFlow event={event} slug="alex-jordan" guestName="Taylor" transport={queueTransport} />);
    try {
      const file = new File(['untouched original'], 'original.jpg', { type: 'image/jpeg' });
      fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), { target: { files: [file] } });
      if (failure === 'decode') fireEvent.error(view.container.querySelector('.selection-card__image img')!);
      expect(view.container.querySelector('.selection-card__image img')).toBeNull();
      expect(screen.getByText('original.jpg')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Send 1 photo' }));
      expect(await screen.findByRole('heading', { name: 'Your 1 photo was sent.' })).toBeVisible();
      expect(vi.mocked(queueTransport.upload).mock.calls[0]?.[0].file).toBe(file);
      view.unmount();
      expect(revoke.mock.calls).toEqual(failure === 'creation' ? [] : [['blob:guest-original']]);
    } finally {
      view.unmount();
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('distills review to previews and one add action while preserving source choice and name editing', async () => {
    const user = userEvent.setup();
    const session = {
      items: [{ id: 'photo-a', file: new File(['photo'], 'keeper.jpg', { type: 'image/jpeg' }),
        previewUrl: 'blob:keeper', state: 'selected' as const, progress: 0, isNewCapture: false }],
      sending: false, receiptCount: 0, adoptFiles: vi.fn(), canRemoveItem: () => true,
      removeItem: vi.fn(), send: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    };
    const { container } = render(<ControlledGuestUploadFlow event={event} slug="alex-jordan"
      guestName="Taylor" session={session} uploadsAvailable unavailableMessage="Paused" />);

    expect(screen.getByRole('heading', { name: 'Send photos to the host' })).toBeVisible();
    expect(screen.queryByText('keeper.jpg')).not.toBeInTheDocument();
    expect(screen.queryByText('Selected')).not.toBeInTheDocument();
    expect(screen.queryByText('1 photo selected')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove keeper.jpg' })).toBeEnabled();
    expect(screen.getByText('Photos go privately to the host.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Take another photo' })).not.toBeInTheDocument();

    const add = screen.getByRole('button', { name: 'Add photos' });
    await user.click(add);
    expect(add).toHaveAttribute('aria-expanded', 'true');
    const library = screen.getByLabelText('Choose recent photos from your library');
    const camera = screen.getByLabelText('Take a photo from your camera');
    const libraryClick = vi.spyOn(library, 'click');
    const cameraClick = vi.spyOn(camera, 'click');
    await user.click(screen.getByRole('button', { name: 'Choose photos' }));
    expect(libraryClick).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Take another photo' }));
    expect(cameraClick).toHaveBeenCalledOnce();
    fireEvent.change(camera, { target: { files: [new File(['capture'], 'another.jpg', { type: 'image/jpeg' })] } });
    expect(session.adoptFiles).toHaveBeenCalledWith(expect.anything(), true);
    expect(add).toHaveAttribute('aria-expanded', 'false');
    expect(session.send).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Edit name' }));
    await waitFor(() => expect(screen.getByLabelText('Your name')).toHaveFocus());
    fireEvent.error(container.querySelector('.selection-card__image img')!);
    expect(screen.getByText('keeper.jpg')).toBeVisible();
  });

  it('renders the nested cover through a current-revision same-origin slot', () => {
    window.innerWidth = 390;
    window.innerHeight = 844;
    const { container } = render(<GuestUploadFlow
      event={{ ...event, cover: { ...event.cover, revision: 7, hasCover: true } }}
      slug="alex/jordan?"
      transport={transport()}
    />);

    const hero = container.querySelector('.photo-drop__hero') as HTMLElement;
    expect(hero.querySelector('.photo-drop__hero-copy')).not.toBeNull();
    const image = hero.querySelector('img')!;
    expect(image.getAttribute('src'))
      .toBe('/api/event/alex%2Fjordan%3F/cover/7/compact-default/1x.jpeg');
    expect(image.getAttribute('src')).not.toContain('blob:');
  });

  it('keeps the exact gradient-only path when the nested view has no cover', () => {
    const { container } = render(<GuestUploadFlow
      event={event}
      slug="alex-jordan"
      transport={transport()}
    />);

    const hero = container.querySelector('.photo-drop__hero') as HTMLElement;
    expect(hero.querySelector('picture')).toBeNull();
    expect(hero.querySelector('.responsive-cover--gradient')).not.toBeNull();
    expect(hero.querySelector('.photo-drop__hero-copy')).not.toBeNull();
  });

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
    expect(screen.getByRole('button', { name: 'Remove just-taken.jpg' })).toBeEnabled();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    const addPhotos = screen.getByRole('button', { name: 'Add photos' });
    await waitFor(() => expect(addPhotos).toHaveFocus());

    await user.click(addPhotos);
    await user.click(screen.getByRole('button', { name: 'Choose photos' }));
    fireEvent.change(library, { target: { files: [new File(['recent'], 'recent.jpg', { type: 'image/jpeg' })] } });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    await waitFor(() => expect(addPhotos).toHaveFocus());
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

    expect(await screen.findByRole('heading', { name: 'Send photos to the host' })).toBeVisible();
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
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

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

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
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

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
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
    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Send 1 photo' }));
    expect(screen.getByRole('heading', { name: 'Sending photos' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel sending' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Cancel sending' }));

    expect(await screen.findByRole('button', { name: 'Retry 1 photo' })).toBeEnabled();
    expect(screen.getByText('Sending was cancelled. Retry when you are ready.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Send photos to the host' })).toBeVisible();
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

  it('survives StrictMode effect replay and still reaches a receipt', async () => {
    // Mutation caught: leaving the guest owner marked unmounted after the replay cleanup.
    const queueTransport = transport();
    const user = userEvent.setup();
    render(<StrictMode>
      <GuestUploadFlow event={event} slug="alex-jordan" transport={queueTransport} />
    </StrictMode>);
    await user.type(screen.getByLabelText('Your name'), 'Taylor');
    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['keeper'], 'strict-guest.jpg', { type: 'image/jpeg' })] },
    });

    await user.click(await screen.findByRole('button', { name: 'Send 1 photo' }));

    expect(await screen.findByRole('heading', { name: 'Your 1 photo was sent.' })).toBeVisible();
  });

  it('owns a transfer only for the photos-primary phase and starts fresh after re-entry', async () => {
    // Mutations caught: hoisting the owner above the phase boundary or reusing stale queue state.
    let heldSignal: AbortSignal | undefined;
    const heldTransport: UploadTransport = {
      ...transport(),
      upload: vi.fn((_item, _reservation, _progress, signal) => new Promise<void>((_resolve, reject) => {
        heldSignal = signal;
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Sending was cancelled.', 'AbortError')),
          { once: true },
        );
      })),
    };
    const freshTransport = transport();
    const onDelivered = vi.fn();

    function PhaseHarness({ active, uploadTransport }: {
      active: boolean;
      uploadTransport: UploadTransport;
    }) {
      const [guestName, setGuestName] = useState('Taylor');
      return active ? <GuestPhotoUpload
        event={event}
        slug="alex-jordan"
        guestName={guestName}
        onGuestNameChange={setGuestName}
        onDelivered={onDelivered}
        onLeaveGuestbook={vi.fn()}
        transport={uploadTransport}
      /> : <p>Photos are not primary.</p>;
    }

    const user = userEvent.setup();
    const view = render(<PhaseHarness active uploadTransport={heldTransport} />);
    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['held'], 'held.jpg', { type: 'image/jpeg' })] },
    });
    await user.click(await screen.findByRole('button', { name: 'Send 1 photo' }));
    await waitFor(() => expect(heldSignal).toBeDefined());

    view.rerender(<PhaseHarness active={false} uploadTransport={heldTransport} />);
    expect(heldSignal?.aborted).toBe(true);
    expect(screen.getByText('Photos are not primary.')).toBeVisible();

    view.rerender(<PhaseHarness active uploadTransport={freshTransport} />);
    expect(screen.queryByText('held.jpg')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /photo.*sent/iu })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose recent photos' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['fresh'], 'fresh.jpg', { type: 'image/jpeg' })] },
    });
    await user.click(await screen.findByRole('button', { name: 'Send 1 photo' }));

    expect(await screen.findByRole('heading', { name: 'Your 1 photo was sent.' })).toBeVisible();
    expect(onDelivered).toHaveBeenCalledWith(1);
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

  /* End to end over the shipped adapter, against the reservation and confirmation answers exactly
     as the contract writes them. `{ id, mimeType, uploadState }` is everything the server says about
     the photo; the filename on the card, the bytes on the wire, and the receipt the guest reads all
     come from the file this device has held since it was chosen. */
  it('uses admitted formats, shows confirming without a receipt and aborts polling on unmount', async () => {
    sessionStorage.clear(); vi.stubGlobal('crypto',webcrypto);
    const transfer={id:'transfer-a',mediaId:'media-a',state:'receiving',partBytes:8*1024**2,partCount:1,
      acceptedParts:[] as number[],expiresAt:new Date(Date.now()+3600_000).toISOString(),hardExpiresAt:new Date(Date.now()+6*3600_000).toISOString(),previewState:'pending'};
    let pollingSignal:AbortSignal|undefined;
    const fetchMock=vi.fn(async (input:RequestInfo|URL,init:RequestInit={}) => {
      const url=String(input);
      if (url.endsWith('/capabilities')) return uploadJson({...BASELINE_UPLOAD_CAPABILITIES,mimeTypes:[...BASELINE_UPLOAD_CAPABILITIES.mimeTypes,'image/dng'],extensions:['dng'],maxOriginalBytes:512*1024**2});
      if (url.endsWith('/batch')) return uploadJson({items:[{idempotencyKey:JSON.parse(String(init.body)).files[0].idempotencyKey,
        status:'accepted',transport:'parts-v1',media:{id:'media-a',mimeType:'image/dng',uploadState:'reserved'},transfer}]});
      if (url.endsWith('/verify')) return uploadJson({verifiedParts:transfer.acceptedParts});
      if (url.endsWith('/parts/0')) {expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(new Uint8Array([1,2,3])); transfer.acceptedParts=[0]; return uploadJson({index:0,accepted:true});}
      if (url.endsWith('/complete')) {transfer.state='processing'; return uploadJson({transfer});}
      pollingSignal=init.signal ?? undefined; return uploadJson({transfer});
    });
    vi.stubGlobal('fetch',fetchMock);
    const view=render(<GuestUploadFlow event={event} slug="alex-jordan" guestName="Avery" />);
    const picker=screen.getByLabelText('Choose recent photos from your library');
    await waitFor(() => expect(picker.getAttribute('accept')).toContain('image/dng'));
    expect(picker.getAttribute('accept')).toContain('.dng');
    const original=new RuntimeFile([new Uint8Array([1,2,3])],'original.dng',{type:'image/dng'}) as unknown as File;
    fireEvent.change(picker,{target:{files:[original]}});
    await userEvent.click(screen.getByRole('button',{name:'Send 1 photo'}));
    expect(await screen.findByText('Confirming delivery')).toBeVisible();
    expect(screen.queryByRole('heading',{name:'Your 1 photo was sent.'})).toBeNull();
    await waitFor(() => expect(pollingSignal).toBeDefined());
    view.unmount(); expect(pollingSignal!.aborted).toBe(true);
    expect(fetchMock.mock.calls.some(([,init]) => init?.method==='DELETE')).toBe(false);
    sessionStorage.clear();
  });

  it('delivers through the shipped adapter on the allowlisted upload answers alone', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('XMLHttpRequest', DeliveringXMLHttpRequest as unknown as typeof XMLHttpRequest);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/uploads/batch')) {
        const sent = JSON.parse(String(init?.body)) as { files: Array<{ idempotencyKey: string }> };
        return uploadJson({
          items: sent.files.map(({ idempotencyKey }) => ({
            idempotencyKey,
            status: 'accepted',
            alreadyDelivered: false,
            media: { id: 'media-a', mimeType: 'image/jpeg', uploadState: 'reserved' },
            uploadUrl: '/api/event/alex-jordan/uploads/media-a/content',
            uploadUrlExpiresAt: '2026-09-14T00:10:00.000Z',
          })),
        });
      }
      if (url.endsWith('/uploads/media-a/finalize')) {
        return uploadJson({ media: { id: 'media-a', mimeType: 'image/jpeg', uploadState: 'stored' } });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<GuestUploadFlow event={event} slug="alex-jordan" />);
    await user.type(screen.getByLabelText('Your name'), 'Taylor');
    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['keeper'], 'keeper.jpg', { type: 'image/jpeg' })] },
    });
    expect(await screen.findByRole('button', { name: 'Remove keeper.jpg' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Send 1 photo' }));

    expect(await screen.findByRole('heading', { name: 'Your 1 photo was sent.' })).toBeVisible();
    expect(DeliveringXMLHttpRequest.requests).toHaveLength(1);
    const transfer = DeliveringXMLHttpRequest.requests[0]!;
    expect(transfer.method).toBe('PUT');
    expect(transfer.url).toBe('/api/event/alex-jordan/uploads/media-a/content');
    expect(transfer.headers['Content-Type']).toBe('image/jpeg');
    expect((transfer.body as File).name).toBe('keeper.jpg');
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/event/alex-jordan/uploads/capabilities',
      '/api/event/alex-jordan/uploads/batch',
      '/api/event/alex-jordan/uploads/media-a/finalize',
    ]);
  });

  it('lets a returning guest reach the camera with one tap', async () => {
    localStorage.setItem('candidary_guest_name', 'Avery');
    render(<GuestUploadFlow event={event} slug="alex-jordan" transport={transport()} />);
    expect(screen.getByText('Sending as Avery')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit name' })).toBeVisible();
  });

  it('uses the controlled remembered name and reports edits immediately', async () => {
    const onGuestNameChange = vi.fn();
    function ControlledUpload({ externalName = 'Taylor' }: { externalName?: string }) {
      const [guestName, setGuestName] = useState(externalName);
      return <GuestUploadFlow
        event={event}
        slug="alex-jordan"
        transport={transport()}
        guestName={guestName}
        onGuestNameChange={(name) => { setGuestName(name); onGuestNameChange(name); }}
      />;
    }
    const view = render(<ControlledUpload />);

    expect(screen.getByText('Sending as Taylor')).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit name' }));
    await userEvent.setup().clear(screen.getByLabelText('Your name'));
    await userEvent.setup().type(screen.getByLabelText('Your name'), 'Avery');
    expect(onGuestNameChange).toHaveBeenLastCalledWith('Avery');

    view.rerender(<GuestUploadFlow
      event={event}
      slug="alex-jordan"
      transport={transport()}
      guestName="Morgan"
      onGuestNameChange={onGuestNameChange}
    />);
    expect(screen.getByText('Sending as Morgan')).toBeVisible();
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
