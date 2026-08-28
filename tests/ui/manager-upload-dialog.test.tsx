import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostUploadAvailability } from '../../shared/contracts';
import { MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR } from '../fixtures/manager-upload-errors';
import { ManagerUploadDialog } from '../../src/features/uploads/ManagerUploadDialog';
import { useManagerUploadSession } from '../../src/features/uploads/use-manager-upload-session';
import type { BrowserUploadTransport } from '../../src/features/uploads/browser-upload-transport';
import type { UploadQueueItem } from '../../src/features/uploads/upload-queue';

const event = {
  name: 'Alex & Jordan',
  eventDate: '2026-09-14',
  welcomeMessage: 'Help us remember tonight.',
  uploadsEnabled: false,
  cover: {
    revision: 0, hasCover: false, available2xProfiles: [], surfaceTreatment: 'none' as const,
  },
};

function deliveringTransport(): BrowserUploadTransport {
  return {
    reserve: vi.fn(async (items: readonly UploadQueueItem[]) => items.map(({ id }) => ({
      id,
      status: 'accepted' as const,
      reservation: {
        mediaId: `media-${id}`,
        uploadUrl: `/api/manage/events/event-a/uploads/media-${id}/content`,
        mimeType: 'image/jpeg',
      },
    }))),
    upload: vi.fn(async (_item, _reservation, progress) => progress(100)),
    finalize: vi.fn(async () => undefined),
    cancelReservation: vi.fn(async () => undefined),
  };
}

interface RenderDialogOptions {
  availability?: HostUploadAvailability;
  transport?: BrowserUploadTransport | null;
  hasUsableAccountCredential?: boolean;
  onClose?: () => void;
  onExitGateChange?: (state: { ownsBlock: boolean; warnBeforeUnload: boolean }) => void;
  onEscalate?: Parameters<typeof ManagerUploadDialog>[0]['onEscalate'];
  onRefreshAfterTerminal?: () => void;
  onFinalized?: (result: { itemId: string; mediaId: string }) => void;
}

function DialogHarness({
  availability = { enabled: true, reason: null },
  transport = deliveringTransport(),
  hasUsableAccountCredential = true,
  onClose = vi.fn(),
  onExitGateChange = vi.fn(),
  onEscalate = vi.fn(),
  onRefreshAfterTerminal = vi.fn(),
  onFinalized,
}: RenderDialogOptions) {
  const invokerRef = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={invokerRef}>Add photos toolbar</button>
    <ManagerUploadDialog
      eventId="event-a"
      event={event}
      availability={availability}
      returnFocusRef={invokerRef}
      transport={transport ?? undefined}
      hasUsableAccountCredential={hasUsableAccountCredential}
      onClose={onClose}
      onExitGateChange={onExitGateChange}
      onEscalate={onEscalate}
      onRefreshAfterTerminal={onRefreshAfterTerminal}
      onFinalized={onFinalized}
    />
  </>;
}

function choose(...names: string[]) {
  const filenames = names.length > 0 ? names : ['host-photo.jpg'];
  fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
    target: { files: filenames.map((name) => new File(['photo'], name, { type: 'image/jpeg' })) },
  });
}

function gateTransitions(states: Array<{ ownsBlock: boolean; warnBeforeUnload: boolean }>) {
  return states
    .map(({ ownsBlock, warnBeforeUnload }) => `${ownsBlock}:${warnBeforeUnload}`)
    .filter((state, index, all) => index === 0 || state !== all[index - 1]);
}

beforeEach(() => {
  document.cookie = 'candidary_csrf=event-csrf';
  document.cookie = 'candidary_host_csrf=host-csrf';
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ManagerUploadDialog', () => {
  it('keeps one Add photos label while the paused guest event completes through the shared flow', async () => {
    // Mutations caught: consulting event.uploadsEnabled, rendering guest identity/copy, or shifting the modal label.
    const transport = deliveringTransport();
    const onClose = vi.fn();
    const onFinalized = vi.fn();
    const user = userEvent.setup();

    render(<DialogHarness transport={transport} onClose={onClose} onFinalized={onFinalized} />);

    const dialog = screen.getByRole('dialog', { name: 'Add photos' });
    expect(within(dialog).getAllByRole('heading', { name: 'Add photos' })).toHaveLength(1);
    expect(within(dialog).queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Take a photo' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Choose recent photos' })).toBeEnabled();
    expect(within(dialog).queryByText(/host has paused photo delivery/iu)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Your name')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/guestbook/iu)).not.toBeInTheDocument();

    choose();
    expect(await within(dialog).findByText('From Host')).toBeVisible();
    expect(within(dialog).getAllByRole('heading', { name: 'Add photos' })).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Send 1 photo' }));

    expect(await within(dialog).findByRole('heading', { name: '1 photo was added.' })).toBeVisible();
    expect(within(dialog).getAllByRole('heading', { name: 'Add photos' })).toHaveLength(1);
    expect(onFinalized).toHaveBeenCalledOnce();
    const done = within(dialog).getByRole('button', { name: 'Done' });
    expect(done).toBeEnabled();
    expect(done).toHaveFocus();
    await user.click(done);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['media-cap', 'This event has reached its photo limit.'],
    ['storage-cap', 'This event has reached its storage limit.'],
    ['event-unavailable', 'This event is no longer available for uploads.'],
  ] as const)('disables both source states with the named %s reason', async (reason, message) => {
    // Mutation caught: substituting the guest pause flag or one generic unavailable sentence.
    render(<DialogHarness availability={{ enabled: false, reason }} />);
    const dialog = screen.getByRole('dialog', { name: 'Add photos' });

    expect(within(dialog).getByRole('button', { name: 'Take a photo' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Choose recent photos' })).toBeDisabled();
    expect(within(dialog).getByText(message)).toBeVisible();
    expect(within(dialog).queryByText(/host has paused photo delivery/iu)).not.toBeInTheDocument();
  });

  it('rechecks availability in the session before dispatch when it changes after selection', async () => {
    // Mutation caught: guarding only the rendered controls while the owner still starts the queue.
    const transport = deliveringTransport();

    function SessionHarness({ available }: { available: boolean }) {
      const session = useManagerUploadSession({
        eventId: 'event-a',
        uploadsAvailable: available,
        transport,
        hasUsableAccountCredential: true,
        onExitGateChange: vi.fn(),
        onEscalate: vi.fn(),
      });
      return <>
        <button onClick={() => session.flow.adoptFiles({
          0: new File(['photo'], 'late.jpg', { type: 'image/jpeg' }),
          length: 1,
          item: () => null,
        } as unknown as FileList, false)}>Adopt</button>
        <button onClick={() => void session.flow.send()}>Direct send</button>
        <span>{session.flow.items.length}</span>
      </>;
    }

    const user = userEvent.setup();
    const view = render(<SessionHarness available />);
    await user.click(screen.getByRole('button', { name: 'Adopt' }));
    expect(screen.getByText('1')).toBeVisible();
    view.rerender(<SessionHarness available={false} />);
    await user.click(screen.getByRole('button', { name: 'Direct send' }));

    expect(transport.reserve).not.toHaveBeenCalled();
  });

  it('discards a browser-only selection on Close and restores focus to the invoker', async () => {
    // Mutation caught: treating unattempted local files as server cleanup work or losing return focus.
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DialogHarness onClose={onClose} />);
    choose();

    await user.click(screen.getByRole('button', { name: 'Close Add photos' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('locks ordinary close during transfer and waits for queue settlement before cleanup and close', async () => {
    // Mutations caught: enabling Escape/Close during a transfer or cleaning before the queue settles.
    let settleCleanup!: () => void;
    let uploadSignal: AbortSignal | undefined;
    const calls: string[] = [];
    const exitStates: Array<{ ownsBlock: boolean; warnBeforeUnload: boolean }> = [];
    const transport = deliveringTransport();
    transport.upload = vi.fn((_item, _reservation, _progress, signal) => new Promise<void>((_resolve, reject) => {
      uploadSignal = signal;
      signal?.addEventListener('abort', () => {
        calls.push('queue-settled');
        reject(new DOMException('cancelled', 'AbortError'));
      }, { once: true });
    }));
    transport.cancelReservation = vi.fn(() => new Promise<void>((resolve) => {
      calls.push('cleanup');
      settleCleanup = resolve;
    }));
    const onClose = vi.fn(() => {
      expect(exitStates.at(-1)).toEqual({ ownsBlock: false, warnBeforeUnload: false });
      calls.push('closed');
    });
    const onExitGateChange = vi.fn((state: { ownsBlock: boolean; warnBeforeUnload: boolean }) => {
      exitStates.push(state);
    });
    const user = userEvent.setup();
    render(<DialogHarness
      transport={transport}
      onClose={onClose}
      onExitGateChange={onExitGateChange}
    />);
    choose();
    await user.click(screen.getByRole('button', { name: 'Send 1 photo' }));
    await waitFor(() => expect(uploadSignal).toBeDefined());

    expect(screen.queryByRole('button', { name: 'Close Add photos' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel uploads' }));
    expect(uploadSignal?.aborted).toBe(true);

    expect(await screen.findByText('Cleaning up temporary uploads…')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Add photos' })).toHaveFocus();
    await waitFor(() => expect(settleCleanup).toBeTypeOf('function'));
    await act(async () => settleCleanup());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(calls).toEqual(['queue-settled', 'cleanup', 'closed']);
    expect(gateTransitions(exitStates).slice(-2)).toEqual(['true:true', 'false:false']);
  });

  it('keeps unresolved cleanup open with its exact count after a network failure', async () => {
    // Mutation caught: treating an unknown lost response as a confirmed cancellation.
    const transport = deliveringTransport();
    transport.upload = vi.fn(async () => { throw new Error('Reception dropped out.'); });
    transport.cancelReservation = vi.fn(async () => { throw new Error('Network lost.'); });
    const user = userEvent.setup();
    render(<DialogHarness transport={transport} />);
    choose();
    await user.click(screen.getByRole('button', { name: 'Send 1 photo' }));
    expect(await screen.findByRole('button', { name: 'Remove host-photo.jpg' })).toBeDisabled();
    await user.click(await screen.findByRole('button', { name: 'Cancel uploads' }));

    const retry = await screen.findByRole('button', { name: 'Retry cleanup' });
    expect(retry).toBeVisible();
    expect(retry).toHaveFocus();
    expect(screen.getByText('1 temporary upload still needs cleanup.')).toBeVisible();
    expect(screen.queryByText(/was canceled/iu)).not.toBeInTheDocument();
  });

  it('keeps an ambiguous reserve failure fenced from local removal', async () => {
    // Mutation caught: treating an unknown reserve response as proof that no server row exists.
    const transport = deliveringTransport();
    transport.reserve = vi.fn(async () => { throw new Error('The reserve response was lost.'); });
    const user = userEvent.setup();
    render(<DialogHarness transport={transport} />);
    choose('ambiguous.jpg');

    await user.click(screen.getByRole('button', { name: 'Send 1 photo' }));

    expect(await screen.findByRole('button', { name: 'Remove ambiguous.jpg' })).toBeDisabled();
  });

  it('removes a known-absent rejection and receipts the delivered item in a mixed batch', async () => {
    // Mutations caught: fencing a confirmed rejection or hiding an already-delivered mixed result.
    const transport = deliveringTransport();
    transport.reserve = vi.fn(async (items: readonly UploadQueueItem[]) => [
      { id: items[0]!.id, status: 'delivered' as const, mediaId: 'media-already-delivered' },
      { id: items[1]!.id, status: 'rejected' as const, error: 'This file was rejected.' },
    ]);
    const user = userEvent.setup();
    render(<DialogHarness transport={transport} />);
    choose('delivered.jpg', 'rejected.jpg');

    await user.click(screen.getByRole('button', { name: 'Send 2 photos' }));
    const removeRejected = await screen.findByRole('button', { name: 'Remove rejected.jpg' });
    await waitFor(() => expect(removeRejected).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Remove delivered.jpg' })).not.toBeInTheDocument();
    await user.click(removeRejected);

    expect(await screen.findByRole('heading', { name: '1 photo was added.' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
  });

  it('reaches terminal handoff from a real flat RESOURCE_FORBIDDEN content response', async () => {
    // Mutation caught: collapsing the XHR response to a network sentence or mocking the terminal outcome.
    class RefusingXMLHttpRequest {
      static requests = 0;
      status = 403;
      responseText = JSON.stringify(MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR);
      withCredentials = false;
      readonly upload = { addEventListener: () => {} };
      private readonly listeners = new Map<string, Set<() => void>>();
      open() {}
      setRequestHeader() {}
      addEventListener(type: string, listener: () => void) {
        const listeners = this.listeners.get(type) ?? new Set<() => void>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: () => void) {
        this.listeners.get(type)?.delete(listener);
      }
      abort() {
        for (const listener of this.listeners.get('abort') ?? []) listener();
      }
      send() {
        RefusingXMLHttpRequest.requests += 1;
        for (const listener of this.listeners.get('load') ?? []) listener();
      }
    }
    vi.stubGlobal('XMLHttpRequest', RefusingXMLHttpRequest as unknown as typeof XMLHttpRequest);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/uploads/batch')) {
        const body = JSON.parse(String(init?.body)) as { files: Array<{ idempotencyKey: string }> };
        return Promise.resolve(new Response(JSON.stringify({
          data: {
            items: [{
              idempotencyKey: body.files[0]?.idempotencyKey,
              status: 'accepted',
              alreadyDelivered: false,
              media: { id: 'media-terminal', mimeType: 'image/jpeg', uploadState: 'reserved' },
              uploadUrl: '/api/manage/events/event-a/uploads/media-terminal/content',
              uploadUrlExpiresAt: '2026-09-14T00:10:00.000Z',
            }],
          },
          requestId: 'reserve-a',
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    const onClose = vi.fn();
    const onEscalate = vi.fn();
    const exitStates: Array<{ ownsBlock: boolean; warnBeforeUnload: boolean }> = [];
    const onExitGateChange = vi.fn((state: { ownsBlock: boolean; warnBeforeUnload: boolean }) => {
      exitStates.push(state);
    });
    const user = userEvent.setup();

    render(<DialogHarness
      transport={null}
      hasUsableAccountCredential={false}
      onClose={() => {
        expect(exitStates.at(-1)).toEqual({ ownsBlock: false, warnBeforeUnload: false });
        onClose();
      }}
      onExitGateChange={onExitGateChange}
      onEscalate={onEscalate}
    />);
    choose('terminal.jpg');
    await user.click(screen.getByRole('button', { name: 'Send 1 photo' }));

    await waitFor(() => expect(onEscalate).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onEscalate.mock.calls[0]?.[0]).toMatchObject({ retryable: false });
    expect(screen.queryByText(/was canceled/iu)).not.toBeInTheDocument();
    expect(gateTransitions(exitStates).slice(-2)).toEqual(['true:true', 'false:false']);
  });

  it('keeps an account-authorized terminal handoff honest and refreshable', async () => {
    // Mutation caught: claiming unresolved reservations were canceled or yielding unnecessarily to link recovery.
    const transport = deliveringTransport();
    transport.upload = vi.fn(async () => {
      const { ClientApiError } = await import('../../src/app/api');
      throw new ClientApiError('RESOURCE_FORBIDDEN', 'Actor expired.', undefined, undefined, 403, 'request-a');
    });
    const onRefreshAfterTerminal = vi.fn();
    const onEscalate = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DialogHarness
      transport={transport}
      onRefreshAfterTerminal={onRefreshAfterTerminal}
      onEscalate={onEscalate}
      onClose={onClose}
    />);
    choose();
    await user.click(screen.getByRole('button', { name: 'Send 1 photo' }));

    expect(await screen.findByText('Temporary uploads will expire automatically.')).toBeVisible();
    expect(onRefreshAfterTerminal).toHaveBeenCalledOnce();
    expect(onEscalate).not.toHaveBeenCalled();
    const returnToIntake = screen.getByRole('button', { name: 'Return to Intake' });
    expect(returnToIntake).toHaveFocus();
    await user.click(returnToIntake);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('survives StrictMode effect replay and releases a live exit gate on unmount', async () => {
    // Mutations caught: leaving mountedRef false after replay or leaving the parent blocker armed.
    let uploadSignal: AbortSignal | undefined;
    const transport = deliveringTransport();
    transport.upload = vi.fn((_item, _reservation, _progress, signal) => new Promise<void>((_resolve, reject) => {
      uploadSignal = signal;
      signal?.addEventListener(
        'abort',
        () => reject(new DOMException('cancelled', 'AbortError')),
        { once: true },
      );
    }));
    const exitStates: Array<{ ownsBlock: boolean; warnBeforeUnload: boolean }> = [];
    const onExitGateChange = vi.fn((state: { ownsBlock: boolean; warnBeforeUnload: boolean }) => {
      exitStates.push(state);
    });
    const user = userEvent.setup();
    const view = render(<StrictMode>
      <DialogHarness transport={transport} onExitGateChange={onExitGateChange} />
    </StrictMode>);
    choose('strict-manager.jpg');

    await user.click(screen.getByRole('button', { name: 'Send 1 photo' }));
    await waitFor(() => expect(uploadSignal).toBeDefined());
    await waitFor(() => expect(exitStates).toContainEqual({ ownsBlock: true, warnBeforeUnload: true }));
    view.unmount();

    expect(uploadSignal?.aborted).toBe(true);
    expect(exitStates.at(-1)).toEqual({ ownsBlock: false, warnBeforeUnload: false });
  });
});
