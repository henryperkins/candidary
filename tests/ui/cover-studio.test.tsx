import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventCoverEffectId, EventCoverPreparationView } from '../../shared/event-cover';
import { CoverStudio, type CoverStudioDraft } from '../../src/features/cover/CoverStudio';
import {
  createCoverOperationController,
  type CoverOperationState,
} from '../../src/features/cover/cover-operation-controller';

/**
 * Cover Studio ships complete and reachable from nothing. These cover the
 * contracts in §6 and §13 directly, because no shipped surface can.
 */

const DRAFT: CoverStudioDraft = {
  id: 'draft-a',
  safeZoomMaximum: 1.6,
  previewUrl: 'blob:preview',
  available2xProfiles: ['compact-default'],
  automaticFocus: { x: 0.5, y: 0.4, zoom: 1 },
};

function preparing(patch: Partial<EventCoverPreparationView> = {}): EventCoverPreparationView {
  return {
    operationId: 'operation-a',
    status: 'preparing',
    completedSteps: 1,
    requiredSteps: 6,
    retryable: false,
    safeFailureCode: null,
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...patch,
  };
}

function Harness({
  draft = null,
  canRemove = false,
  onPublish = vi.fn(),
  onDiscardDraft = vi.fn(),
  onClose = vi.fn(),
  onUpload = vi.fn(),
  initialEffect = 'natural' as EventCoverEffectId,
}: {
  draft?: CoverStudioDraft | null;
  canRemove?: boolean;
  onPublish?: (intent: unknown) => void;
  onDiscardDraft?: () => void;
  onClose?: () => void;
  onUpload?: (file: File) => void;
  initialEffect?: EventCoverEffectId;
}) {
  const [controller] = useState(() => createCoverOperationController({
    eventId: 'event-a',
    // No real timers: polling cadence is the controller's own test, not the
    // sheet's.
    schedule: () => () => undefined,
  }));
  const [state, setState] = useState<CoverOperationState>(controller.getState());
  const [live] = useState(() => {
    controller.subscribe(setState);
    return controller;
  });

  return <CoverStudio
    open
    operation={live}
    operationState={state}
    draft={draft}
    initialSource={null}
    initialEffect={initialEffect}
    canRemove={canRemove}
    presetThumbnail={(presetId) => `/assets/event-covers/v1/${presetId}.webp`}
    styleThumbnail={(effect) => `blob:${effect}`}
    onUpload={onUpload}
    onPublish={onPublish}
    onDiscardDraft={onDiscardDraft}
    onClose={onClose}
  />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('cover studio', () => {
  it('is a modal with a stable accessible name', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Cover Studio' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('offers exactly six built-in designs, each named and ready for every size', () => {
    render(<Harness />);
    const presets = screen.getAllByRole('radio').filter((radio) => radio.getAttribute('value') !== 'upload');
    expect(presets).toHaveLength(6);
    for (const name of [
      'Warm Linen', 'Botanical Shadow', 'Pressed Paper',
      'Candlelit Grain', 'Coastal Haze', 'Midnight Wash',
    ]) {
      expect(screen.getByText(name)).toBeVisible();
    }
    expect(screen.getAllByText('Ready for every size')).toHaveLength(6);
  });

  it('walks a built-in design through the accurate three-step path', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByText('Step 1 of 3')).toBeVisible();

    await user.click(screen.getByRole('radio', { name: /Warm Linen/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    // A design is already composed for every size, so Compose never appears.
    expect(screen.getByRole('heading', { name: 'Choose a style' })).toBeVisible();
    expect(screen.getByText('Step 2 of 3')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Step 3 of 3')).toBeVisible();
  });

  it('walks an upload through four steps and moves focus to each heading', async () => {
    const user = userEvent.setup();
    render(<Harness draft={DRAFT} />);
    await user.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    expect(screen.getByText('Step 1 of 4')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const composing = screen.getByRole('heading', { name: 'Position the photo' });
    expect(composing).toBeVisible();
    // Focus follows the step rather than staying on a button whose meaning moved.
    expect(document.activeElement).toBe(composing);
  });

  it('sends removal straight to a focused Done', async () => {
    const user = userEvent.setup();
    render(<Harness canRemove />);
    await user.click(screen.getByRole('button', { name: 'Remove cover' }));
    const heading = screen.getByRole('heading', { name: 'Save this cover' });
    expect(heading).toBeVisible();
    expect(document.activeElement).toBe(heading);
    // No meaningless Compose or Style screens on the way.
    expect(screen.queryByRole('heading', { name: 'Choose a style' })).not.toBeInTheDocument();
  });

  it('keeps Done disabled until an uploaded draft is ready', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness draft={null} />);
    await user.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    // Compose cannot render without a draft, so Continue carries to Style.
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();

    rerender(<Harness draft={DRAFT} />);
    expect(screen.getByRole('dialog', { name: 'Cover Studio' })).toBeVisible();
  });

  it('publishes the chosen design and style', async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn();
    render(<Harness onPublish={onPublish} />);
    await user.click(screen.getByRole('radio', { name: /Coastal Haze/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('radio', { name: /Monochrome/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(onPublish).toHaveBeenCalledWith({
      source: { kind: 'preset', presetId: 'coastal-haze' },
      focus: null,
      effect: 'monochrome',
    });
  });

  it('confirms before discarding a changed draft, and Escape uses the same path', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDiscardDraft = vi.fn();
    render(<Harness onClose={onClose} onDiscardDraft={onDiscardDraft} />);
    await user.click(screen.getByRole('radio', { name: /Pressed Paper/u }));

    fireEvent.keyDown(document, { key: 'Escape' });
    const confirm = screen.getByRole('alertdialog', { name: 'Discard cover changes' });
    expect(onClose).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole('button', { name: 'Discard' }));
    expect(onDiscardDraft).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes without confirmation when nothing has changed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('exposes the three crop ranges with bounds, step, and value text', async () => {
    const user = userEvent.setup();
    render(<Harness draft={DRAFT} />);
    await user.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const horizontal = screen.getByRole('slider', { name: 'Horizontal focus' });
    const vertical = screen.getByRole('slider', { name: 'Vertical focus' });
    const zoom = screen.getByRole('slider', { name: 'Zoom' });

    expect(horizontal).toHaveAttribute('min', '0');
    expect(horizontal).toHaveAttribute('max', '100');
    expect(horizontal).toHaveAttribute('step', '1');
    expect(horizontal).toHaveAttribute('aria-valuetext', '50 percent from left');
    expect(vertical).toHaveAttribute('aria-valuetext', '40 percent from top');
    // The draft's server-calculated ceiling, not the absolute 2.0.
    expect(zoom).toHaveAttribute('max', '160');
    expect(zoom).toHaveAttribute('step', '5');
    expect(zoom).toHaveAttribute('aria-valuetext', '100 percent zoom');
  });

  it('adjusts the crop from the keyboard and announces only once settled', async () => {
    vi.useFakeTimers();
    render(<Harness draft={DRAFT} />);
    fireEvent.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const horizontal = screen.getByRole('slider', { name: 'Horizontal focus' });
    fireEvent.change(horizontal, { target: { value: '70' } });
    expect(horizontal).toHaveAttribute('aria-valuetext', '70 percent from left');
    // Nothing announced yet: a summary on every key press makes a screen reader
    // unusable.
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByRole('status').textContent)
      .toContain('70 percent from left');
    vi.useRealTimers();
  });

  it('resets to the automatic composition', async () => {
    const user = userEvent.setup();
    render(<Harness draft={DRAFT} />);
    await user.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    fireEvent.change(screen.getByRole('slider', { name: 'Vertical focus' }), { target: { value: '90' } });
    expect(screen.getByRole('slider', { name: 'Vertical focus' }))
      .toHaveAttribute('aria-valuetext', '90 percent from top');

    await user.click(screen.getByRole('button', { name: 'Reset to automatic' }));
    expect(screen.getByRole('slider', { name: 'Vertical focus' }))
      .toHaveAttribute('aria-valuetext', '40 percent from top');
  });

  it('shows the softness note only when no 2x profile qualifies', async () => {
    const user = userEvent.setup();
    render(<Harness draft={{ ...DRAFT, available2xProfiles: [] }} />);
    await user.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText(/may look slightly softer on some high-density screens/u)).toBeVisible();

    cleanup();
    render(<Harness draft={DRAFT} />);
    await user.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.queryByText(/high-density screens/u)).not.toBeInTheDocument();
  });

  it('offers exactly five styles, each named', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('radio', { name: /Warm Linen/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const styles = screen.getAllByRole('radio');
    expect(styles).toHaveLength(5);
    for (const name of ['Natural', 'Warm', 'Film', 'Soft', 'Monochrome']) {
      expect(screen.getByText(name)).toBeVisible();
    }
    // No intensity slider anywhere in this step.
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });
});

describe('cover operation controller', () => {
  function controllerHarness(overrides: Parameters<typeof createCoverOperationController>[0] = { eventId: 'event-a' }) {
    const pending: Array<() => void> = [];
    const controller = createCoverOperationController({
      ...overrides,
      schedule: (callback) => {
        pending.push(callback);
        return () => undefined;
      },
    });
    return { controller, run: () => pending.splice(0).forEach((callback) => callback()) };
  }

  it('treats a dispatched operation as ambiguous whatever the client saw', () => {
    const { controller } = controllerHarness();
    expect(controller.canDiscardDraft()).toBe(true);

    controller.beginDispatch('operation-a');
    // No response at all — not a 202, not a 503, nothing.
    expect(controller.getState().dispatched).toBe(true);
    expect(controller.canDiscardDraft()).toBe(false);
  });

  it('allows a discard again only after a terminal, non-retryable outcome', () => {
    const { controller } = controllerHarness();
    controller.beginDispatch('operation-a');
    controller.dispatchSettled(preparing());
    expect(controller.canDiscardDraft()).toBe(false);

    controller.dispatchSettled(preparing({ status: 'retryable-failed', retryable: true }));
    // A retryable failure keeps the draft: the same operation may restart.
    expect(controller.canDiscardDraft()).toBe(false);

    controller.dispatchSettled(preparing({ status: 'conflict' }));
    expect(controller.canDiscardDraft()).toBe(true);
  });

  it('reports a terminal outcome once', () => {
    const onSettled = vi.fn();
    const { controller } = controllerHarness({ eventId: 'event-a', onSettled });
    controller.beginDispatch('operation-a');
    controller.dispatchSettled(preparing({ status: 'applied' }));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe('applied');
  });

  it('detaching stops polling without cancelling the operation', () => {
    const { controller, run } = controllerHarness();
    controller.attach();
    controller.beginDispatch('operation-a');
    controller.dispatchSettled(preparing());
    controller.detach();
    run();
    // Still dispatched, still undiscardable: closing a sheet decides nothing.
    expect(controller.getState().dispatched).toBe(true);
    expect(controller.canDiscardDraft()).toBe(false);
  });

  it('marks a slow operation from elapsed time without failing it', () => {
    let clock = 0;
    const { controller } = controllerHarness({ eventId: 'event-a', now: () => clock });
    controller.beginDispatch('operation-a');
    controller.dispatchSettled(preparing());
    expect(controller.getState().slow).toBe(false);

    clock = 60_000;
    controller.dispatchSettled(preparing());
    expect(controller.getState().slow).toBe(true);
    // Elapsed time never becomes a failure.
    expect(controller.getState().phase).toBe('preparing');
  });
});
