import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ManagerUndoBar,
  ManagerUndoProvider,
  TRASH_UNDO_WINDOW_MS,
  UNDO_FAILED_MESSAGE,
  UNDO_WINDOW_MS,
  useManagerUndo,
  type ManagerUndoController,
  type ManagerUndoOffer,
} from '../../src/features/gallery/undo';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function offer(overrides: Partial<ManagerUndoOffer> = {}): ManagerUndoOffer {
  return {
    eventId: 'event-a',
    message: 'Photo removed from Album. The delivered original is untouched.',
    durationMs: UNDO_WINDOW_MS,
    input: 'pointer',
    run: () => Promise.resolve(),
    ...overrides,
  };
}

function ControllerProbe({ capture }: { capture(controller: ManagerUndoController): void }) {
  capture(useManagerUndo());
  return null;
}

function LayoutOffer({ eventId, run }: { eventId: string; run(): Promise<void> }) {
  const { present } = useManagerUndo();
  const fallback = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    present(offer({ eventId, message: `${eventId} layout offer.`, run }), {
      fallback: fallback.current,
    });
  }, [eventId, present, run]);
  return <button ref={fallback} type="button">{eventId} fallback</button>;
}

function renderUndo(eventId = 'event-a') {
  let current: ManagerUndoController | null = null;
  const view = (nextEventId: string) => <ManagerUndoProvider eventId={nextEventId}>
    <main>
      <section aria-labelledby="manager-section-heading">
        <h2 id="manager-section-heading" tabIndex={-1}>Gallery</h2>
        <button type="button">Origin</button>
        <button type="button">Later control</button>
      </section>
      <ControllerProbe capture={(controller) => { current = controller; }} />
      <ManagerUndoBar />
    </main>
  </ManagerUndoProvider>;
  const rendered = render(view(eventId));

  return {
    controller() {
      if (current === null) throw new Error('Manager Undo controller was not captured.');
      return current;
    },
    rerender(nextEventId: string) {
      rendered.rerender(view(nextEventId));
    },
  };
}

async function settle() {
  await act(async () => {});
}

describe('Manager Undo provider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00.000Z'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('atomically replaces an offered or failed slot while leaving one Undo action', async () => {
    const firstRun = vi.fn(() => Promise.reject(new Error('private provider detail')));
    const rendered = renderUndo();

    act(() => {
      expect(rendered.controller().present(offer({ message: 'First change.', run: firstRun }), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      })).toBe(true);
      expect(rendered.controller().present(offer({ message: 'Replacement change.' }), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      })).toBe(true);
    });
    expect(screen.queryByText('First change.')).not.toBeInTheDocument();
    expect(screen.getByText('Replacement change.')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await settle();
    expect(rendered.controller().state).toBe('idle');

    act(() => {
      rendered.controller().present(offer({ message: 'Failing change.', run: firstRun }), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await settle();
    expect(rendered.controller().state).toBe('failed');

    act(() => {
      expect(rendered.controller().present(offer({ message: 'After failure.' }), {
        fallback: screen.getByRole('button', { name: 'Later control' }),
      })).toBe(true);
    });
    expect(screen.getByText('After failure.')).toBeVisible();
    expect(screen.queryByText(UNDO_FAILED_MESSAGE)).not.toBeInTheDocument();
  });

  it('re-adds identical pointer copy to the persistent live region for a replacement offer', () => {
    const rendered = renderUndo();
    const status = screen.getByRole('status');
    const repeated = offer({ message: '1 photo picked for Album. Nothing was published.' });

    act(() => {
      rendered.controller().present(repeated, {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
    });
    const firstPayload = status.firstChild;
    expect(firstPayload).not.toBeNull();

    act(() => {
      rendered.controller().present(repeated, {
        fallback: screen.getByRole('button', { name: 'Later control' }),
      });
    });

    expect(screen.getByRole('status')).toBe(status);
    expect(status.firstChild).not.toBe(firstPayload);
    expect(status).toHaveTextContent(
      '1 photo picked for Album. Nothing was published. Undo is available for nine seconds.',
    );
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
  });

  it('locks a running slot and reports canPresent false until that exact run settles', async () => {
    const gate = deferred();
    const rendered = renderUndo();
    act(() => {
      rendered.controller().present(offer({ message: 'Running change.', run: () => gate.promise }), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(rendered.controller().state).toBe('running');
    expect(rendered.controller().canPresent).toBe(false);
    act(() => {
      expect(rendered.controller().present(offer({ message: 'Must be rejected.' }), {
        fallback: screen.getByRole('button', { name: 'Later control' }),
      })).toBe(false);
    });
    expect(screen.getByText('Running change.')).toBeVisible();

    gate.resolve();
    await settle();
    expect(rendered.controller().state).toBe('idle');
    expect(rendered.controller().canPresent).toBe(true);
  });

  it('rejects an offer for a different event without disturbing the current event slot', () => {
    const rendered = renderUndo();
    act(() => {
      rendered.controller().present(offer({ message: 'Current event.' }), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
    });

    act(() => {
      expect(rendered.controller().present(offer({ eventId: 'event-b', message: 'Wrong event.' }), {
        fallback: screen.getByRole('button', { name: 'Later control' }),
      })).toBe(false);
    });
    expect(screen.getByText('Current event.')).toBeVisible();
    expect(screen.queryByText('Wrong event.')).not.toBeInTheDocument();
  });

  it('clears timers and nested holds on event change so they cannot keep the next event alive', () => {
    const rendered = renderUndo();
    act(() => {
      rendered.controller().present(offer({ message: 'Old event.' }), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
    });
    const oldBar = screen.getByRole('button', { name: 'Undo' }).closest('.album-undo__bar')!;
    fireEvent.pointerEnter(oldBar);
    fireEvent.focus(screen.getByRole('button', { name: 'Undo' }));

    rendered.rerender('event-b');
    expect(rendered.controller().state).toBe('idle');
    expect(screen.queryByText('Old event.')).not.toBeInTheDocument();
    act(() => {
      rendered.controller().present(offer({ eventId: 'event-b', message: 'New event.' }), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(screen.queryByText('New event.')).not.toBeInTheDocument();
  });

  it('ignores an old event run settlement after the provider changes event', async () => {
    const gate = deferred();
    const rendered = renderUndo();
    act(() => {
      rendered.controller().present(offer({ message: 'Old running event.', run: () => gate.promise }), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    rendered.rerender('event-b');
    act(() => {
      rendered.controller().present(offer({ eventId: 'event-b', message: 'New event offer.' }), {
        fallback: screen.getByRole('button', { name: 'Later control' }),
      });
    });

    gate.reject(new Error('stale request detail'));
    await settle();
    expect(rendered.controller().state).toBe('offered');
    expect(screen.getByText('New event offer.')).toBeVisible();
    expect(screen.queryByText(UNDO_FAILED_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByText('stale request detail')).not.toBeInTheDocument();
  });

  it('lets a new-event descendant layout registration survive the event boundary reset', async () => {
    const oldRun = deferred();
    const newRun = vi.fn(() => Promise.resolve());
    const view = (eventId: string, run: () => Promise<void>) => <ManagerUndoProvider eventId={eventId}>
      <main>
        <LayoutOffer eventId={eventId} run={run} />
        <ManagerUndoBar />
      </main>
    </ManagerUndoProvider>;
    const rendered = render(view('event-a', () => oldRun.promise));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'Undoing…' })).toBeDisabled();

    rendered.rerender(view('event-b', newRun));
    expect(screen.getByText('event-b layout offer.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();

    oldRun.reject(new Error('old event settlement'));
    await settle();
    expect(screen.getByText('event-b layout offer.')).toBeVisible();
    expect(screen.queryByText(UNDO_FAILED_MESSAGE)).not.toBeInTheDocument();
  });

  it('resumes the exact remaining duration only after the final nested hold releases', () => {
    const rendered = renderUndo();
    act(() => {
      rendered.controller().present(offer(), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
      vi.advanceTimersByTime(3_000);
    });
    const undo = screen.getByRole('button', { name: 'Undo' });
    const bar = undo.closest('.album-undo__bar')!;
    fireEvent.pointerEnter(bar);
    fireEvent.focus(undo);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(undo).toBeVisible();

    fireEvent.pointerLeave(bar);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(undo).toBeVisible();

    fireEvent.blur(undo, { relatedTarget: screen.getByRole('button', { name: 'Later control' }) });
    act(() => { vi.advanceTimersByTime(5_999); });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('expires synchronously when a delayed duration timer is overdue before a hold starts', () => {
    let monotonicTime = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicTime);
    const rendered = renderUndo();
    act(() => {
      rendered.controller().present(offer(), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
    });
    const bar = screen.getByRole('button', { name: 'Undo' }).closest('.album-undo__bar')!;

    monotonicTime = UNDO_WINDOW_MS + 1;
    fireEvent.pointerEnter(bar);

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('expires synchronously when a delayed duration timer is overdue before run starts', () => {
    let monotonicTime = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicTime);
    const run = vi.fn(() => Promise.resolve());
    const rendered = renderUndo();
    act(() => {
      rendered.controller().present(offer({ run }), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
    });

    monotonicTime = UNDO_WINDOW_MS + 1;
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('preserves an active focus hold when an offered slot is replaced in the same bar', () => {
    const rendered = renderUndo();
    act(() => {
      rendered.controller().present(offer({ message: 'First focused offer.' }), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
    });
    const undo = screen.getByRole('button', { name: 'Undo' });
    undo.focus();

    act(() => {
      rendered.controller().present(offer({ message: 'Replacement focused offer.' }), {
        fallback: screen.getByRole('button', { name: 'Later control' }),
      });
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('Replacement focused offer.')).toBeVisible();

    screen.getByRole('button', { name: 'Later control' }).focus();
    act(() => { vi.advanceTimersByTime(UNDO_WINDOW_MS - 1); });
    expect(screen.getByText('Replacement focused offer.')).toBeVisible();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Replacement focused offer.')).not.toBeInTheDocument();
  });

  it('preserves an active pointer hold when a failed slot is replaced in the same bar', async () => {
    const rendered = renderUndo();
    act(() => {
      rendered.controller().present(offer({
        message: 'First pointer offer.',
        run: () => Promise.reject(new Error('failure')),
      }), { fallback: screen.getByRole('button', { name: 'Origin' }) });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await settle();
    const bar = screen.getByRole('button', { name: 'Undo' }).closest('.album-undo__bar')!;
    fireEvent.pointerEnter(bar);

    act(() => {
      rendered.controller().present(offer({ message: 'Replacement pointer offer.' }), {
        fallback: screen.getByRole('button', { name: 'Later control' }),
      });
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('Replacement pointer offer.')).toBeVisible();

    fireEvent.pointerLeave(bar);
    act(() => { vi.advanceTimersByTime(UNDO_WINDOW_MS - 1); });
    expect(screen.getByText('Replacement pointer offer.')).toBeVisible();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Replacement pointer offer.')).not.toBeInTheDocument();
  });

  it('pauses while running and returns a failed run with its pre-run remainder', async () => {
    const gate = deferred();
    const rendered = renderUndo();
    act(() => {
      rendered.controller().present(offer({ run: () => gate.promise }), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
      vi.advanceTimersByTime(4_000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(rendered.controller().state).toBe('running');

    gate.reject(new Error('do not expose this'));
    await settle();
    expect(rendered.controller().state).toBe('failed');
    act(() => { vi.advanceTimersByTime(4_999); });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('never pauses trash absolute expiry during focus and pointer holds', () => {
    const rendered = renderUndo();
    const absoluteDeadline = '2026-08-25T12:00:10.000Z';
    act(() => {
      rendered.controller().present(offer({
        absoluteDeadline,
        durationMs: TRASH_UNDO_WINDOW_MS,
        message: 'Photo moved to Recently deleted.',
      }), { fallback: screen.getByRole('button', { name: 'Origin' }) });
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      `Undo for up to 30 seconds, before ${absoluteDeadline}.`,
    );
    const undo = screen.getByRole('button', { name: 'Undo' });
    const bar = undo.closest('.album-undo__bar')!;
    fireEvent.focus(undo);
    fireEvent.pointerEnter(bar);
    act(() => { vi.advanceTimersByTime(9_999); });
    expect(undo).toBeVisible();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('rejects an already-expired cap and closes a near-deadline offer before run can start', () => {
    const run = vi.fn(() => Promise.resolve());
    const rendered = renderUndo();
    act(() => {
      expect(rendered.controller().present(offer({
        absoluteDeadline: '2026-08-25T11:59:59.999Z', durationMs: TRASH_UNDO_WINDOW_MS, run,
      }), { fallback: screen.getByRole('button', { name: 'Origin' }) })).toBe(false);
    });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();

    act(() => {
      expect(rendered.controller().present(offer({
        absoluteDeadline: '2026-08-25T12:00:00.500Z', durationMs: TRASH_UNDO_WINDOW_MS, run,
      }), { fallback: screen.getByRole('button', { name: 'Origin' }) })).toBe(true);
      vi.setSystemTime(new Date('2026-08-25T12:00:01.000Z'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('focuses keyboard Undo, preserves pointer focus, and returns to a connected fallback', () => {
    const rendered = renderUndo();
    const origin = screen.getByRole('button', { name: 'Origin' });
    origin.focus();
    act(() => {
      rendered.controller().present(offer({ input: 'keyboard' }), { fallback: origin });
    });
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(origin).toHaveFocus();

    origin.focus();
    act(() => {
      rendered.controller().present(offer({ input: 'pointer' }), { fallback: origin });
    });
    expect(origin).toHaveFocus();
  });

  it('falls back to the current section heading when the stored origin disconnects', () => {
    const rendered = renderUndo();
    const origin = screen.getByRole('button', { name: 'Origin' });
    origin.focus();
    act(() => {
      rendered.controller().present(offer({ input: 'keyboard' }), { fallback: origin });
    });
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    origin.remove();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.getByRole('heading', { name: 'Private Gallery' })).toHaveFocus();
  });

  it('does not steal focus when delayed confirmation finds the host on another control', () => {
    const rendered = renderUndo();
    const origin = screen.getByRole('button', { name: 'Origin' });
    const later = screen.getByRole('button', { name: 'Later control' });
    origin.focus();
    later.focus();
    act(() => {
      rendered.controller().present(offer({ input: 'keyboard' }), { fallback: origin });
    });

    expect(later).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Undo is available for nine seconds.');
    expect(screen.getByRole('button', { name: 'Undo' })).not.toHaveFocus();
  });

  it('normalizes failed reversal copy, retains the offer, and retries the same command', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('R2 key private/secret failed'))
      .mockResolvedValueOnce(undefined);
    const rendered = renderUndo();
    act(() => {
      rendered.controller().present(offer({ run }), {
        fallback: screen.getByRole('button', { name: 'Origin' }),
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await settle();

    expect(rendered.controller().state).toBe('failed');
    expect(screen.getByRole('alert')).toHaveTextContent(UNDO_FAILED_MESSAGE);
    expect(screen.queryByText(/R2 key private\/secret failed/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(rendered.controller().state).toBe('idle');
    expect(screen.getByRole('status')).toHaveTextContent('Change undone.');
  });
});
