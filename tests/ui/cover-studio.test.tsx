import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventCoverEffectId, EventCoverPreparationView } from '../../shared/event-cover';
import {
  CoverStudio,
  type CoverPublishIntent,
  type CoverStudioDraft,
} from '../../src/features/cover/CoverStudio';
import type { CoverFocusValue } from '../../src/features/cover/CoverComposer';
import type { CoverOperationAnswer } from '../../src/features/cover/cover-draft-client';
import type { CoverSourceChoice } from '../../src/features/cover/CoverSourcePicker';
import type { CoverDraftSessionState, CoverStyleThumbnail } from '../../src/features/cover/use-cover-studio-session';
import type { CoverAccessFailure } from '../../src/features/cover/use-cover-operation-reconciler';
import {
  createCoverOperationController,
  type CoverOperationState,
} from '../../src/features/cover/cover-operation-controller';

/** Cover Studio component contracts beneath the live Manager canvas owner. */

const DRAFT: CoverStudioDraft = {
  id: 'draft-a',
  master: { width: 1600, height: 1000, safeZoomMaximum: 1.6 },
  available2xProfiles: [
    'compact-default',
    'compact-expanded',
    'framed-default',
    'short-lookup',
    'standard-default',
    'wide-expanded',
  ],
  initialFocus: { x: 0.5, y: 0.4, zoom: 1 },
  automaticFocus: { x: 0.5, y: 0.4, zoom: 1 },
};

function readyThumbnail(effect: EventCoverEffectId): CoverStyleThumbnail {
  return { status: 'ready', url: `blob:${effect}`, error: null };
}

function canvasAtFocus(focus: CoverFocusValue): ReactNode {
  return <figure className="event-appearance-canvas">
    <div className="event-appearance-canvas__guest">
      <div className="event-appearance-canvas__local-cover">
        <img
          className="responsive-cover__image"
          alt=""
          style={{
            objectPosition: `${Math.round(focus.x * 100)}% ${Math.round(focus.y * 100)}%`,
            transform: `scale(${focus.zoom})`,
            transformOrigin: `${Math.round(focus.x * 100)}% ${Math.round(focus.y * 100)}%`,
          }}
        />
      </div>
    </div>
  </figure>;
}

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

function answer(
  patch: Partial<CoverOperationAnswer> & { operation?: EventCoverPreparationView } = {},
): CoverOperationAnswer {
  return {
    status: 202,
    operation: preparing(),
    receiptPath: '/api/manage/events/event-a/cover/publications/operation-a',
    retryAfterMs: null,
    ...patch,
  };
}

function Harness({
  open = true,
  canvas,
  canvasForFocus,
  draft = null,
  canRemove = false,
  onPublish = vi.fn(),
  onDiscardDraft = vi.fn(),
  onClose = vi.fn(),
  onUpload = vi.fn(),
  onEnterCompose = vi.fn(),
  error = null as string | null,
  initialEffect = 'natural' as EventCoverEffectId,
  initialSource = null as CoverSourceChoice | { kind: 'none' } | null,
  composeState,
  focusMode = 'manual' as 'auto' | 'manual',
  styleThumbnail = readyThumbnail,
  onStyleStepVisible = vi.fn(),
  onEffectRetry = vi.fn(),
  accessFailure = null as CoverAccessFailure | null,
  settledOperation = null as EventCoverPreparationView | null,
}: {
  open?: boolean;
  canvas?: ReactNode;
  canvasForFocus?: (focus: CoverFocusValue) => ReactNode;
  draft?: CoverStudioDraft | null;
  canRemove?: boolean;
  onPublish?: (intent: unknown) => void;
  onDiscardDraft?: () => void | Promise<void>;
  onClose?: () => void;
  onUpload?: (file: File) => void;
  onEnterCompose?: () => void;
  error?: string | null;
  initialEffect?: EventCoverEffectId;
  initialSource?: CoverSourceChoice | { kind: 'none' } | null;
  composeState?: CoverDraftSessionState;
  focusMode?: 'auto' | 'manual';
  styleThumbnail?: (effect: EventCoverEffectId) => CoverStyleThumbnail;
  onStyleStepVisible?: () => void;
  onEffectRetry?: (effect: EventCoverEffectId) => void;
  accessFailure?: CoverAccessFailure | null;
  settledOperation?: EventCoverPreparationView | null;
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
  const [source, setSource] = useState<typeof initialSource>(initialSource);
  const [effect, setEffect] = useState(initialEffect);
  const [focus, setFocus] = useState(DRAFT.initialFocus);
  const [mode, setMode] = useState(focusMode);
  useEffect(() => {
    if (!settledOperation) return;
    controller.beginDispatch(settledOperation.operationId);
    controller.dispatchSettled(answer({ operation: settledOperation }));
  }, [controller, settledOperation]);

  return <CoverStudio
    open={open}
    canvas={canvasForFocus ? canvasForFocus(focus) : canvas}
    operation={live}
    operationState={state}
    draft={draft}
    source={source}
    focus={focus}
    focusMode={mode}
    effect={effect}
    composeState={composeState ?? (draft
      ? { status: 'ready', error: null }
      : { status: 'idle', error: null })}
    accessFailure={accessFailure}
    error={error}
    canRemove={canRemove}
    presetThumbnail={(presetId) => `/assets/event-covers/v1/${presetId}.webp`}
    styleThumbnail={styleThumbnail}
    onStyleStepVisible={onStyleStepVisible}
    onSourceChange={setSource}
    onUpload={onUpload}
    onEnterCompose={onEnterCompose}
    onFocusChange={(next) => { setMode('manual'); setFocus(next); }}
    onResetFocus={() => { setMode('auto'); setFocus(draft?.automaticFocus ?? DRAFT.automaticFocus); }}
    onEffectChange={setEffect}
    onEffectRetry={onEffectRetry}
    onPublish={onPublish}
    onDiscardDraft={onDiscardDraft}
    onClose={onClose}
  />;
}

function RetryingStyleHarness({
  onRetry,
  exposeFailure,
  exposeSuccess,
}: {
  onRetry(effect: EventCoverEffectId): void;
  exposeFailure(fail: () => void): void;
  exposeSuccess?(succeed: () => void): void;
}) {
  const [warmPreview, setWarmPreview] = useState<CoverStyleThumbnail>({
    status: 'error',
    url: 'blob:warm-retained',
    error: new Error('Preview unavailable'),
  });
  return <Harness
    initialEffect="natural"
    styleThumbnail={(effect) => effect === 'warm' ? warmPreview : readyThumbnail(effect)}
    onEffectRetry={(effect) => {
      onRetry(effect);
      setWarmPreview({ status: 'loading', url: 'blob:warm-retained', error: null });
      exposeFailure(() => setWarmPreview({
        status: 'error',
        url: 'blob:warm-retained',
        error: new Error('Preview unavailable again'),
      }));
      exposeSuccess?.(() => setWarmPreview({
        status: 'ready',
        url: 'blob:warm-replacement',
        error: null,
      }));
    }}
  />;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cover studio', () => {
  it('is a modal with a stable accessible name', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Cover Studio' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('orders the header as close action, title, then step counter', () => {
    render(<Harness />);
    const header = screen.getByRole('heading', { name: 'Choose a cover' }).parentElement!;
    expect(Array.from(header.children)).toEqual([
      screen.getByRole('button', { name: 'Cancel' }),
      screen.getByRole('heading', { name: 'Choose a cover' }),
      screen.getByText('Step 1 of 3'),
    ]);
  });

  it('keeps cover errors inside the modal and moves focus to them', () => {
    render(<Harness error="That photo could not be prepared." />);

    const dialog = screen.getByRole('dialog', { name: 'Cover Studio' });
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('That photo could not be prepared.');
    expect(alert).toHaveFocus();
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

  it('separates the upload source choice from the labelled native file control', () => {
    const onUpload = vi.fn();
    render(<Harness onUpload={onUpload} />);
    expect(screen.getByRole('radio', { name: 'Upload a photo' })).toBeVisible();
    const chooser = screen.getByLabelText<HTMLInputElement>('Choose photo');
    expect(chooser).toHaveAttribute('type', 'file');
    const proxy = chooser.nextElementSibling;
    expect(proxy).toMatchObject({ tagName: 'LABEL' });
    expect(proxy).toHaveClass('cover-source-picker__file-proxy');
    expect(proxy).toHaveAttribute('for', chooser.id);
    expect(document.querySelectorAll('.cover-source-picker__choice-heading')).toHaveLength(7);

    // Canceling the native picker emits no file and must not invent a draft or
    // advance the step.
    fireEvent.change(chooser, { target: { files: [] } });
    expect(onUpload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
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

  it('requests an existing-upload draft once and reuses it across Back', async () => {
    const user = userEvent.setup();
    const onEnterCompose = vi.fn();
    render(<Harness
      initialSource={{ kind: 'upload' }}
      draft={null}
      composeState={{ status: 'loading', error: null }}
      onEnterCompose={onEnterCompose}
    />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onEnterCompose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing your photo');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onEnterCompose).toHaveBeenCalledTimes(1);
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

  it('shows exact preset, upload, and removal receipts before dispatch', async () => {
    const user = userEvent.setup();
    render(<Harness initialEffect="film" />);
    await user.click(screen.getByRole('radio', { name: /Warm Linen/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Warm Linen · Film', { exact: true })).toBeVisible();
    expect(screen.getByText(
      'Guests see this at the top of RSVP and photo delivery.',
      { exact: true },
    )).toBeVisible();
    expect(screen.getByText(
      'Your current cover stays live until the new one is completely ready. If anything fails, nothing changes.',
      { exact: true },
    )).toBeVisible();

    cleanup();
    render(<Harness
      initialSource={{ kind: 'upload' }}
      initialEffect="soft"
      draft={DRAFT}
    />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Your photo · Soft', { exact: true })).toBeVisible();
    expect(screen.getByText(
      'Guests see this at the top of RSVP and photo delivery.',
      { exact: true },
    )).toBeVisible();
    expect(screen.getByText(
      'Your current cover stays live until the new one is completely ready. If anything fails, nothing changes.',
      { exact: true },
    )).toBeVisible();

    cleanup();
    render(<Harness canRemove />);
    await user.click(screen.getByRole('button', { name: 'Remove cover' }));
    expect(screen.getByText('Remove the current cover', { exact: true })).toBeVisible();
    expect(screen.getByText('Guests will see the event theme instead.', { exact: true })).toBeVisible();
    expect(screen.getByText(
      'The current cover stays live until this change is completely applied. If anything fails, nothing changes.',
      { exact: true },
    )).toBeVisible();
  });

  it('keeps Done disabled until an uploaded draft is ready', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness draft={null} />);
    await user.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    // Step state alone cannot skip a missing draft into Style.
    expect(screen.getByRole('heading', { name: 'Position the photo' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    rerender(<Harness draft={DRAFT} />);
    expect(screen.getByRole('dialog', { name: 'Cover Studio' })).toBeVisible();
  });

  it('keeps a compose error actionable and focuses its retry', async () => {
    const user = userEvent.setup();
    const onEnterCompose = vi.fn();
    render(<Harness
      initialSource={{ kind: 'upload' }}
      composeState={{ status: 'error', error: new Error('Inspection unavailable') }}
      onEnterCompose={onEnterCompose}
    />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const retry = screen.getByRole('button', { name: 'Try preparing again' });
    expect(screen.getByRole('alert')).toHaveTextContent('could not be prepared');
    expect(document.activeElement).toBe(retry);
    await user.click(retry);
    // The initial Choose → Compose request plus the explicit correction.
    expect(onEnterCompose).toHaveBeenCalledTimes(2);
  });

  it('allows the same file to be chosen again', async () => {
    const user = userEvent.setup();
    const onUpload = vi.fn();
    render(<Harness onUpload={onUpload} />);
    const input = screen.getByLabelText<HTMLInputElement>('Choose photo');
    const file = new File(['abc'], 'porch.jpg', { type: 'image/jpeg', lastModified: 10 });

    await user.upload(input, file);
    await user.upload(input, file);

    expect(onUpload).toHaveBeenCalledTimes(2);
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

    await user.click(within(confirm).getByRole('button', { name: 'Discard draft' }));
    expect(onDiscardDraft).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('waits for draft deletion before closing', async () => {
    const user = userEvent.setup();
    let finishDiscard!: () => void;
    const discardGate = new Promise<void>((resolve) => { finishDiscard = resolve; });
    const onDiscardDraft = vi.fn(() => discardGate);
    const onClose = vi.fn();
    render(<Harness onDiscardDraft={onDiscardDraft} onClose={onClose} />);
    await user.click(screen.getByRole('radio', { name: /Pressed Paper/u }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Discard cover changes' });

    await user.click(within(confirm).getByRole('button', { name: 'Discard draft' }));
    expect(onClose).not.toHaveBeenCalled();
    const discarding = within(confirm).getByRole('button', { name: 'Discarding draft' });
    expect(discarding).toHaveFocus();
    expect(discarding).toHaveAttribute('aria-disabled', 'true');
    expect(within(confirm).getByRole('status')).toHaveTextContent('Discarding draft');
    expect(screen.getByRole('dialog', { name: 'Cover Studio' })
      .querySelector('.cover-studio__controls')).toHaveAttribute('inert');

    finishDiscard();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps a failed discard open and makes it retryable', async () => {
    const user = userEvent.setup();
    const onDiscardDraft = vi.fn()
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(<Harness onDiscardDraft={onDiscardDraft} onClose={onClose} />);
    await user.click(screen.getByRole('radio', { name: /Pressed Paper/u }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Discard cover changes' });

    await user.click(within(confirm).getByRole('button', { name: 'Discard draft' }));

    const alert = await within(confirm).findByRole('alert');
    expect(alert).toHaveTextContent('could not be discarded');
    expect(alert).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    expect(within(confirm).getByRole('button', { name: 'Keep editing' }))
      .toHaveAttribute('aria-disabled', 'true');
    const retry = within(confirm).getByRole('button', { name: 'Discard draft' });
    expect(retry).toBeEnabled();

    await user.click(retry);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onDiscardDraft).toHaveBeenCalledTimes(2);
  });

  it('closes without confirmation when nothing has changed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows the automatic proposal before exposing manual ranges without a jump', async () => {
    const user = userEvent.setup();
    render(<Harness draft={DRAFT} focusMode="auto" />);
    await user.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Automatic framing')).toBeVisible();
    expect(screen.getByText(
      'Drag the preview to reposition it, or choose Adjust framing for precise controls.',
    )).toBeVisible();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(document.querySelector('.cover-composer__surface')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Adjust framing' }));
    expect(screen.getByText('Manual framing')).toBeVisible();
    expect(screen.getByText('Drag the preview or use the controls below.')).toBeVisible();
    expect(screen.getByRole('slider', { name: 'Left or right' }))
      .toHaveAttribute('aria-valuetext', '50 percent from left');
    expect(screen.getByRole('slider', { name: 'Up or down' }))
      .toHaveAttribute('aria-valuetext', '40 percent from top');
  });

  it('exposes the three crop ranges with bounds, step, and value text', async () => {
    const user = userEvent.setup();
    render(<Harness draft={DRAFT} />);
    await user.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const reset = screen.getByRole('button', { name: 'Reset to automatic' });
    const horizontal = screen.getByRole('slider', { name: 'Left or right' });
    const vertical = screen.getByRole('slider', { name: 'Up or down' });
    const zoom = screen.getByRole('slider', { name: 'Zoom' });

    expect(reset.compareDocumentPosition(horizontal) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(horizontal.compareDocumentPosition(vertical) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(vertical.compareDocumentPosition(zoom) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(horizontal).toHaveAttribute('min', '0');
    expect(horizontal).toHaveAttribute('max', '100');
    expect(horizontal).toHaveAttribute('step', '1');
    expect(horizontal).toHaveAttribute('aria-valuetext', '50 percent from left');
    expect(vertical).toHaveAttribute('aria-valuetext', '40 percent from top');
    // The draft's server-calculated ceiling, not the absolute 2.0.
    expect(zoom).toHaveAttribute('max', '160');
    expect(zoom).toHaveAttribute('step', '5');
    expect(zoom).toHaveAttribute('aria-valuetext', '100 percent zoom');
    expect(screen.getByText('50% from left')).toBeVisible();
    expect(screen.getByText('40% from top')).toBeVisible();
    expect(screen.getByText('100%')).toBeVisible();
  });

  it('adjusts the crop from the keyboard and announces only once settled', async () => {
    vi.useFakeTimers();
    render(<Harness draft={DRAFT} />);
    fireEvent.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const horizontal = screen.getByRole('slider', { name: 'Left or right' });
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

  it('implements one-step, ten-step, and bound range keys while retaining focus', () => {
    render(<Harness draft={DRAFT} />);
    fireEvent.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const horizontal = screen.getByRole('slider', { name: 'Left or right' });
    horizontal.focus();

    fireEvent.keyDown(horizontal, { key: 'ArrowRight' });
    expect(horizontal).toHaveAttribute('aria-valuetext', '51 percent from left');
    fireEvent.keyDown(horizontal, { key: 'PageUp' });
    expect(horizontal).toHaveAttribute('aria-valuetext', '61 percent from left');
    fireEvent.keyDown(horizontal, { key: 'End' });
    expect(horizontal).toHaveAttribute('aria-valuetext', '100 percent from left');
    fireEvent.keyDown(horizontal, { key: 'Home' });
    expect(horizontal).toHaveAttribute('aria-valuetext', '0 percent from left');
    expect(document.activeElement).toBe(horizontal);
  });

  it('says nothing until the host has actually adjusted something', async () => {
    vi.useFakeTimers();
    render(<Harness draft={DRAFT} />);
    fireEvent.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // §13: the polite summary fires after an interaction settles. Firing on
    // mount reads a crop summary at a host who has not touched anything.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByRole('status').textContent).toBe('');
    vi.useRealTimers();
  });

  it('uses controls without rendering a detached composer preview', () => {
    render(<Harness draft={DRAFT} />);
    fireEvent.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(document.querySelector('.cover-composer__surface')).not.toBeInTheDocument();
    expect(document.querySelector('.cover-composer img')).not.toBeInTheDocument();
  });

  it('keeps each framing label associated with only its range control', () => {
    render(<Harness draft={DRAFT} />);
    fireEvent.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    for (const name of ['Left or right', 'Up or down', 'Zoom']) {
      const slider = screen.getByRole('slider', { name });
      const label = slider.closest('label');
      expect(label).not.toBeNull();
      expect(label?.querySelectorAll('button, input, meter, output, progress, select, textarea'))
        .toHaveLength(1);
    }
  });

  it('promotes the live canvas drag only after 3px and announces the settled framing', async () => {
    vi.useFakeTimers();
    render(<Harness draft={DRAFT} focusMode="auto" canvasForFocus={canvasAtFocus} />);
    fireEvent.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const canvas = document.querySelector<HTMLDivElement>('.cover-studio__canvas')!;
    const guest = canvas.querySelector<HTMLElement>('.event-appearance-canvas__guest')!;
    vi.spyOn(guest, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 100,
      width: 200, height: 100, toJSON: () => ({}),
    });
    let captured: number | null = null;
    const setPointerCapture = vi.fn((pointerId: number) => { captured = pointerId; });
    const releasePointerCapture = vi.fn((pointerId: number) => {
      if (captured === pointerId) captured = null;
    });
    Object.assign(canvas, {
      setPointerCapture,
      releasePointerCapture,
      hasPointerCapture: (pointerId: number) => captured === pointerId,
    });
    const image = () => canvas.querySelector<HTMLImageElement>(
      '.event-appearance-canvas__local-cover .responsive-cover__image',
    )!;

    expect(canvas).toHaveAttribute('data-drag-enabled', 'true');
    fireEvent.pointerDown(canvas, { pointerId: 7, isPrimary: true, clientX: 180, clientY: 90 });
    fireEvent.pointerMove(canvas, { pointerId: 7, isPrimary: true, clientX: 178, clientY: 89 });
    expect(image()).toHaveStyle({ objectPosition: '50% 40%' });
    expect(screen.getByText('Automatic framing')).toBeVisible();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(setPointerCapture).not.toHaveBeenCalled();

    fireEvent.pointerMove(canvas, { pointerId: 7, isPrimary: true, clientX: 160, clientY: 90 });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(image()).toHaveStyle({ objectPosition: '60% 40%' });
    expect(screen.getByText('Manual framing')).toBeVisible();
    expect(screen.getByRole('slider', { name: 'Left or right' }))
      .toHaveAttribute('aria-valuetext', '60 percent from left');

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByRole('status')).toHaveTextContent('Cover positioned 60 percent from left');
    fireEvent.pointerUp(canvas, { pointerId: 7, isPrimary: true, clientX: 160, clientY: 90 });
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    vi.useRealTimers();
  });

  it('keeps taps and multi-pointer or cancelled gestures out of framing', () => {
    render(<Harness draft={DRAFT} focusMode="auto" canvasForFocus={canvasAtFocus} />);
    fireEvent.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const canvas = document.querySelector<HTMLDivElement>('.cover-studio__canvas')!;
    const guest = canvas.querySelector<HTMLElement>('.event-appearance-canvas__guest')!;
    vi.spyOn(guest, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 100,
      width: 200, height: 100, toJSON: () => ({}),
    });
    let captured: number | null = null;
    const setPointerCapture = vi.fn((pointerId: number) => { captured = pointerId; });
    const releasePointerCapture = vi.fn((pointerId: number) => {
      if (captured === pointerId) captured = null;
    });
    Object.assign(canvas, {
      setPointerCapture,
      releasePointerCapture,
      hasPointerCapture: (pointerId: number) => captured === pointerId,
    });

    fireEvent.pointerDown(canvas, { pointerId: 1, isPrimary: true, clientX: 100, clientY: 50 });
    fireEvent.pointerUp(canvas, { pointerId: 1, isPrimary: true, clientX: 100, clientY: 50 });
    expect(screen.getByText('Automatic framing')).toBeVisible();
    expect(setPointerCapture).not.toHaveBeenCalled();

    fireEvent.pointerDown(canvas, { pointerId: 2, isPrimary: true, clientX: 100, clientY: 50 });
    fireEvent.pointerDown(canvas, { pointerId: 3, isPrimary: false, clientX: 110, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 2, isPrimary: true, clientX: 80, clientY: 50 });
    expect(screen.getByText('Automatic framing')).toBeVisible();
    expect(setPointerCapture).not.toHaveBeenCalled();

    fireEvent.pointerDown(canvas, { pointerId: 4, isPrimary: true, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 4, isPrimary: true, clientX: 80, clientY: 50 });
    expect(setPointerCapture).toHaveBeenCalledWith(4);
    fireEvent.pointerDown(canvas, { pointerId: 5, isPrimary: false, clientX: 90, clientY: 50 });
    expect(releasePointerCapture).toHaveBeenCalledWith(4);
    const valueAfterCancel = screen.getByRole('slider', { name: 'Left or right' })
      .getAttribute('aria-valuetext');
    fireEvent.pointerMove(canvas, { pointerId: 4, isPrimary: true, clientX: 60, clientY: 50 });
    expect(screen.getByRole('slider', { name: 'Left or right' }))
      .toHaveAttribute('aria-valuetext', valueAfterCancel);

    fireEvent.pointerDown(canvas, { pointerId: 6, isPrimary: true, clientX: 100, clientY: 50 });
    fireEvent.pointerCancel(canvas, { pointerId: 6, isPrimary: true });
    fireEvent.pointerMove(canvas, { pointerId: 6, isPrimary: true, clientX: 60, clientY: 50 });
    expect(screen.getByRole('slider', { name: 'Left or right' }))
      .toHaveAttribute('aria-valuetext', valueAfterCancel);
  });

  it('does not expose canvas dragging while upload preparation is not ready', () => {
    render(<Harness
      draft={DRAFT}
      focusMode="auto"
      canvasForFocus={canvasAtFocus}
      composeState={{ status: 'loading', error: null }}
    />);
    fireEvent.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const canvas = document.querySelector<HTMLDivElement>('.cover-studio__canvas')!;
    expect(canvas).toHaveAttribute('data-drag-enabled', 'false');
    fireEvent.pointerDown(canvas, { pointerId: 1, isPrimary: true, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 1, isPrimary: true, clientX: 50, clientY: 50 });
    expect(screen.queryByText('Manual framing')).not.toBeInTheDocument();
  });

  it('resets to the automatic composition', async () => {
    const user = userEvent.setup();
    render(<Harness draft={DRAFT} />);
    await user.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    fireEvent.change(screen.getByRole('slider', { name: 'Up or down' }), { target: { value: '90' } });
    expect(screen.getByRole('slider', { name: 'Up or down' }))
      .toHaveAttribute('aria-valuetext', '90 percent from top');

    await user.click(screen.getByRole('button', { name: 'Reset to automatic' }));
    expect(screen.queryByRole('slider', { name: 'Up or down' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adjust framing' })).toBeVisible();
    expect(screen.getByText('Automatic framing')).toBeVisible();
  });

  it('shows the softness note only when no 2x profile qualifies', async () => {
    const user = userEvent.setup();
    render(<Harness draft={{
      ...DRAFT,
      master: { width: 620, height: 420, safeZoomMaximum: 1 },
      available2xProfiles: [],
    }} />);
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
    expect(document.querySelectorAll('.cover-style-picker__choice-heading')).toHaveLength(5);
    // No intensity slider anywhere in this step.
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('announces Style visibility only after the fixed five choices are on screen', async () => {
    const user = userEvent.setup();
    const onStyleStepVisible = vi.fn();
    render(<Harness onStyleStepVisible={onStyleStepVisible} />);

    expect(onStyleStepVisible).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: /Warm Linen/u }));
    expect(onStyleStepVisible).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getAllByRole('radio')).toHaveLength(5);
    await waitFor(() => expect(onStyleStepVisible).toHaveBeenCalledTimes(1));
  });

  it('keeps style radios usable while real thumbnails load or fail', async () => {
    const user = userEvent.setup();
    render(<Harness styleThumbnail={(effect) => effect === 'natural'
      ? { status: 'idle', url: null, error: null }
      : effect === 'warm'
        ? { status: 'error', url: 'blob:warm-retained', error: new Error('Preview unavailable') }
        : effect === 'film'
          ? { status: 'loading', url: 'blob:film-retained', error: null }
          : readyThumbnail(effect)} />);
    await user.click(screen.getByRole('radio', { name: /Warm Linen/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('radio', { name: /^Natural/u })).toBeEnabled();
    expect(screen.getByText('Preview not ready')).toBeVisible();
    expect(screen.getByRole('radio', { name: /^Warm/u })).toBeEnabled();
    expect(screen.getByText('Preview unavailable. Try this preview again.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry Warm preview' })).toBeVisible();
    expect(screen.getByText('Loading Film preview')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retrying Film preview' }))
      .not.toBeInTheDocument();
    const warm = screen.getByRole('radio', { name: /^Warm/u }).closest('li');
    const film = screen.getByRole('radio', { name: /^Film/u }).closest('li');
    expect(warm?.querySelector('img')).toHaveAttribute('src', 'blob:warm-retained');
    expect(film?.querySelector('img')).toHaveAttribute('src', 'blob:film-retained');
  });

  it('retries a failed thumbnail without changing the selected style', async () => {
    const user = userEvent.setup();
    const onEffectRetry = vi.fn();
    render(<Harness
      initialEffect="natural"
      onEffectRetry={onEffectRetry}
      styleThumbnail={(effect) => effect === 'warm'
        ? { status: 'error', url: null, error: new Error('Preview unavailable') }
        : readyThumbnail(effect)}
    />);
    await user.click(screen.getByRole('radio', { name: /Warm Linen/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await user.click(screen.getByRole('button', { name: 'Retry Warm preview' }));

    expect(onEffectRetry).toHaveBeenCalledWith('warm');
    expect(screen.getByRole('radio', { name: /^Natural/u })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Warm/u })).not.toBeChecked();
  });

  it('keeps a failed preview Retry focused, announced, and deduplicated through another failure', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    let failRetry: (() => void) | null = null;
    render(<RetryingStyleHarness
      onRetry={onRetry}
      exposeFailure={(fail) => { failRetry = fail; }}
    />);
    await user.click(screen.getByRole('radio', { name: /Warm Linen/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const retry = screen.getByRole('button', { name: 'Retry Warm preview' });
    retry.focus();
    await user.click(retry);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(retry).toHaveAccessibleName('Retrying Warm preview');
    expect(retry.closest('[role="status"]')).toHaveAttribute('aria-live', 'polite');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio', { name: /^Natural/u })).toBeChecked();

    act(() => { failRetry?.(); });
    expect(retry).toHaveFocus();
    expect(retry).not.toHaveAttribute('aria-disabled');
    expect(retry).not.toHaveAttribute('aria-busy');
    expect(retry).toHaveAccessibleName('Retry Warm preview');
    expect(screen.getByText('Preview unavailable. Try this preview again.')).toBeVisible();
    expect(screen.getByRole('radio', { name: /^Natural/u })).toBeChecked();
  });

  it('announces a successful preview Retry and moves focus to its connected style radio', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    let succeedRetry: (() => void) | null = null;
    render(<RetryingStyleHarness
      onRetry={onRetry}
      exposeFailure={() => undefined}
      exposeSuccess={(succeed) => { succeedRetry = succeed; }}
    />);
    await user.click(screen.getByRole('radio', { name: /Warm Linen/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const retry = screen.getByRole('button', { name: 'Retry Warm preview' });
    retry.focus();
    await user.click(retry);
    expect(retry).toHaveFocus();
    expect(onRetry).toHaveBeenCalledTimes(1);

    act(() => { succeedRetry?.(); });

    const warm = screen.getByRole('radio', { name: /^Warm/u });
    await waitFor(() => expect(warm).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByText('Warm preview ready.')).toHaveAttribute('role', 'status');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio', { name: /^Natural/u })).toBeChecked();
    expect(warm).not.toBeChecked();
  });

  it('renders a before-dispatch access failure without sending Done', async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn();
    render(<Harness
      onPublish={onPublish}
      accessFailure={{ phase: 'before_dispatch', error: new Error('Session expired') }}
    />);
    await user.click(screen.getByRole('radio', { name: /Warm Linen/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const receipt = document.querySelector('.cover-studio__receipt')!;
    const alert = screen.getByRole('alert');
    expect(receipt).toHaveTextContent('Warm Linen · Natural');
    expect(receipt.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert).toHaveTextContent('access');
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(onPublish).not.toHaveBeenCalled();
  });
});

describe('cover studio environment', () => {
  function setVisualViewport(height: number, offsetTop = 0, width = 390) {
    vi.stubGlobal('visualViewport', {
      width,
      height,
      offsetTop,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  }

  it('inerts and scroll-locks the page behind it, and restores both on close', () => {
    // A sibling standing in for the Manager page. The studio portals to the
    // body, so its own subtree is not among the siblings being inerted.
    const behind = document.createElement('main');
    document.body.append(behind);
    const { unmount } = render(<Harness />);

    expect(behind.hasAttribute('inert')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(behind.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).not.toBe('hidden');
    behind.remove();
  });

  it('dismisses from the backdrop through the same confirmation as Close', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('radio', { name: /Warm Linen/u }));

    await user.click(screen.getByTestId('cover-studio-backdrop'));
    expect(screen.getByRole('alertdialog', { name: 'Discard cover changes' })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('takes browser Back through the dirty-draft path', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('radio', { name: /Pressed Paper/u }));

    // Back is a dismissal like any other; it must not leave the sheet behind on
    // the previous route.
    fireEvent.popState(window);
    expect(screen.getByRole('alertdialog', { name: 'Discard cover changes' })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('rearms the owned history sentinel before leaving discard confirmation', async () => {
    const user = userEvent.setup();
    const push = vi.spyOn(history, 'pushState');
    const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
    const onClose = vi.fn();
    const onDiscardDraft = vi.fn();
    render(<Harness onClose={onClose} onDiscardDraft={onDiscardDraft} />);
    const choice = screen.getByRole('radio', { name: /Pressed Paper/u });
    await user.click(choice);
    expect(push).toHaveBeenCalledTimes(1);

    fireEvent.popState(window);
    const firstConfirm = screen.getByRole('alertdialog', { name: 'Discard cover changes' });
    const keep = within(firstConfirm).getByRole('button', { name: 'Keep editing' });
    expect(document.activeElement).toBe(keep);
    await user.click(keep);
    // Rearmed synchronously, with focus restored inside Studio.
    expect(push).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(choice);

    fireEvent.popState(window);
    const secondConfirm = screen.getByRole('alertdialog', { name: 'Discard cover changes' });
    await user.click(within(secondConfirm).getByRole('button', { name: 'Discard draft' }));
    expect(onDiscardDraft).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Browser Back already consumed the sentinel; discard performs no extra
    // navigation.
    expect(back).not.toHaveBeenCalled();
  });

  it('traps alertdialog focus and returns it to the initiating Studio control', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const choice = screen.getByRole('radio', { name: /Warm Linen/u });
    await user.click(choice);
    fireEvent.keyDown(document, { key: 'Escape' });
    const confirm = screen.getByRole('alertdialog', { name: 'Discard cover changes' });
    const keep = within(confirm).getByRole('button', { name: 'Keep editing' });
    const discard = within(confirm).getByRole('button', { name: 'Discard draft' });
    expect(document.activeElement).toBe(keep);

    discard.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(discard);

    await user.click(keep);
    expect(document.activeElement).toBe(choice);
  });

  it('consumes exactly its own history entry on ordinary Close', async () => {
    const user = userEvent.setup();
    const back = vi.spyOn(history, 'back').mockImplementation(() => undefined);
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('auto-closes once after an applied receipt', async () => {
    const onClose = vi.fn();
    render(<Harness
      onClose={onClose}
      settledOperation={preparing({ status: 'applied', completedSteps: 6 })}
    />);
    await act(async () => undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the exact control that opened Studio', async () => {
    const user = userEvent.setup();
    function FocusHarness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Change cover</button>
        <Harness open={open} onClose={() => setOpen(false)} />
      </>;
    }
    render(<FocusHarness />);
    const trigger = screen.getByRole('button', { name: 'Change cover' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(trigger);
  });

  it('binds its box to the visible rectangle rather than the layout viewport', () => {
    setVisualViewport(520, 40);
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Cover Studio' });
    // With a keyboard open these differ, and a footer pinned to the layout
    // viewport sits underneath it where nothing can reach it.
    expect(dialog.style.top).toBe('40px');
    expect(dialog.style.height).toBe('520px');
  });

  it.each([
    [844, 'default'],
    [500, 'default'],
    [499, 'compact'],
    [421, 'compact'],
    [420, 'short'],
    [180, 'short'],
  ])('resolves a %ipx visible height to %s geometry', (height, mode) => {
    setVisualViewport(height);
    render(<Harness />);
    expect(screen.getByRole('dialog', { name: 'Cover Studio' }).dataset.viewport).toBe(mode);
  });

  it('keeps the canvas above the controls without a second scroller', () => {
    setVisualViewport(844);
    render(<Harness canvas={<div data-testid="studio-canvas">canvas</div>} />);
    const dialog = screen.getByRole('dialog', { name: 'Cover Studio' });
    const canvas = screen.getByTestId('studio-canvas').parentElement!;
    const controls = dialog.querySelector('.cover-studio__controls')!;
    // The canvas precedes the control pane, and only the control pane scrolls.
    expect(canvas.className).toContain('cover-studio__canvas');
    expect(canvas.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    controller.dispatchSettled(answer());
    expect(controller.canDiscardDraft()).toBe(false);

    controller.dispatchSettled(answer({
      status: 503,
      operation: preparing({ status: 'retryable-failed', retryable: true }),
    }));
    // A retryable failure keeps the draft: the same operation may restart.
    expect(controller.canDiscardDraft()).toBe(false);

    controller.dispatchSettled(answer({ status: 409, operation: preparing({ status: 'conflict' }) }));
    expect(controller.canDiscardDraft()).toBe(true);
  });

  it('reports a terminal outcome once', () => {
    const onSettled = vi.fn();
    const { controller } = controllerHarness({ eventId: 'event-a', onSettled });
    controller.beginDispatch('operation-a');
    controller.dispatchSettled(answer({ operation: preparing({ status: 'applied' }) }));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe('applied');
  });

  it('detaching stops polling without cancelling the operation', () => {
    const { controller, run } = controllerHarness();
    controller.attach();
    controller.beginDispatch('operation-a');
    controller.dispatchSettled(answer());
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
    controller.dispatchSettled(answer());
    expect(controller.getState().slow).toBe(false);

    clock = 60_000;
    controller.dispatchSettled(answer());
    expect(controller.getState().slow).toBe(true);
    // Elapsed time never becomes a failure.
    expect(controller.getState().phase).toBe('preparing');
  });

  it('honors a longer server retry interval without shortening the local cadence', () => {
    const scheduled: number[] = [];
    const controller = createCoverOperationController({
      eventId: 'event-a',
      schedule: (_callback, delay) => {
        scheduled.push(delay);
        return () => undefined;
      },
    });
    controller.attach();
    controller.beginDispatch('operation-a');
    controller.dispatchSettled(answer({ retryAfterMs: 11_000 }));
    expect(scheduled.at(-1)).toBe(11_000);
  });

  it('returns to a discardable draft only when dispatch was refused before sending', () => {
    const { controller } = controllerHarness();
    controller.beginDispatch('operation-a');
    controller.dispatchRejectedBeforeAcceptance();
    expect(controller.getState()).toMatchObject({
      phase: 'idle',
      operationId: null,
      dispatched: false,
    });
    expect(controller.canDiscardDraft()).toBe(true);
  });
});

describe('cover studio dispatch and recovery', () => {
  function dispatchHarness() {
    const pending: Array<() => void> = [];
    const controller = createCoverOperationController({
      eventId: 'event-a',
      schedule: (callback) => {
        pending.push(callback);
        return () => undefined;
      },
    });
    return { controller, run: () => pending.splice(0).forEach((callback) => callback()) };
  }

  function LiveHarness({ controller }: { controller: ReturnType<typeof dispatchHarness>['controller'] }) {
    const [state, setState] = useState(controller.getState());
    const [source, setSource] = useState<CoverSourceChoice | { kind: 'none' } | null>(null);
    const [effect, setEffect] = useState<EventCoverEffectId>('natural');
    const [focus, setFocus] = useState(DRAFT.initialFocus);
    useEffect(() => controller.subscribe(setState), [controller]);
    return <CoverStudio
      open
      operation={controller}
      operationState={state}
      draft={DRAFT}
      composeState={{ status: 'ready', error: null }}
      source={source}
      focus={focus}
      focusMode="manual"
      effect={effect}
      accessFailure={null}
      canRemove={false}
      presetThumbnail={(presetId) => `/assets/${presetId}.webp`}
      styleThumbnail={readyThumbnail}
      onSourceChange={setSource}
      onUpload={vi.fn()}
      onEnterCompose={vi.fn()}
      onFocusChange={setFocus}
      onResetFocus={() => setFocus(DRAFT.automaticFocus)}
      onEffectChange={setEffect}
      onPublish={vi.fn()}
      onDiscardDraft={vi.fn()}
      onClose={vi.fn()}
    />;
  }

  function ControlledDoneHarness({
    controller,
    source,
    effect,
    focus,
    onPublish,
  }: {
    controller: ReturnType<typeof dispatchHarness>['controller'];
    source: CoverSourceChoice | { kind: 'none' };
    effect: EventCoverEffectId;
    focus: CoverFocusValue | null;
    onPublish: (intent: CoverPublishIntent) => void;
  }) {
    const [state, setState] = useState(controller.getState());
    useEffect(() => controller.subscribe(setState), [controller]);
    return <CoverStudio
      open
      canvas={canvasAtFocus(focus ?? DRAFT.initialFocus)}
      operation={controller}
      operationState={state}
      draft={DRAFT}
      composeState={{ status: 'ready', error: null }}
      source={source}
      focus={focus}
      focusMode="manual"
      effect={effect}
      accessFailure={null}
      canRemove
      presetThumbnail={(presetId) => `/assets/${presetId}.webp`}
      styleThumbnail={readyThumbnail}
      onSourceChange={vi.fn()}
      onUpload={vi.fn()}
      onEnterCompose={vi.fn()}
      onFocusChange={vi.fn()}
      onResetFocus={vi.fn()}
      onEffectChange={vi.fn()}
      onPublish={onPublish}
      onDiscardDraft={vi.fn()}
      onClose={vi.fn()}
    />;
  }

  it('freezes the submitted receipt while preparing, prop churn, and retryable failure', async () => {
    const { controller } = dispatchHarness();
    const onPublish = vi.fn();
    const { rerender } = render(<ControlledDoneHarness
      controller={controller}
      source={{ kind: 'preset', presetId: 'warm-linen' }}
      effect="film"
      focus={null}
      onPublish={onPublish}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const receipt = document.querySelector('.cover-studio__receipt')!;
    const submittedCopy = receipt.textContent;
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onPublish).toHaveBeenCalledTimes(1);

    await act(async () => {
      controller.beginDispatch('operation-a');
      controller.dispatchSettled(answer({ operation: preparing() }));
    });
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(document.querySelector('.cover-studio__receipt')?.textContent).toBe(submittedCopy);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();

    rerender(<ControlledDoneHarness
      controller={controller}
      source={{ kind: 'upload' }}
      effect="soft"
      focus={{ x: 0.9, y: 0.1, zoom: 1.5 }}
      onPublish={onPublish}
    />);
    expect(document.querySelector('.cover-studio__receipt')?.textContent).toBe(submittedCopy);
    expect(onPublish).toHaveBeenCalledTimes(1);

    await act(async () => {
      controller.dispatchSettled(answer({
        status: 503,
        operation: preparing({ status: 'retryable-failed', retryable: true }),
      }));
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(document.querySelector('.cover-studio__receipt')?.textContent).toBe(submittedCopy);
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it('disables every mounted editing path when dispatch starts on Choose, Compose, or Style', async () => {
    const choose = dispatchHarness();
    render(<ControlledDoneHarness
      controller={choose.controller}
      source={{ kind: 'preset', presetId: 'warm-linen' }}
      effect="natural"
      focus={null}
      onPublish={vi.fn()}
    />);
    await act(async () => { choose.controller.beginDispatch('operation-choose'); });
    expect(screen.getAllByRole('radio').every((radio) => (radio as HTMLInputElement).disabled)).toBe(true);
    expect(screen.getByLabelText('Choose photo')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove cover' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    cleanup();
    const compose = dispatchHarness();
    render(<ControlledDoneHarness
      controller={compose.controller}
      source={{ kind: 'upload' }}
      effect="natural"
      focus={DRAFT.initialFocus}
      onPublish={vi.fn()}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await act(async () => { compose.controller.beginDispatch('operation-compose'); });
    expect(screen.getAllByRole('slider').every((slider) => (slider as HTMLInputElement).disabled)).toBe(true);
    expect(screen.getByRole('button', { name: 'Reset to automatic' })).toBeDisabled();
    expect(document.querySelector('.cover-studio__canvas')).toHaveAttribute('data-drag-enabled', 'false');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    cleanup();
    const style = dispatchHarness();
    render(<ControlledDoneHarness
      controller={style.controller}
      source={{ kind: 'preset', presetId: 'warm-linen' }}
      effect="natural"
      focus={null}
      onPublish={vi.fn()}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await act(async () => { style.controller.beginDispatch('operation-style'); });
    expect(screen.getAllByRole('radio').every((radio) => (radio as HTMLInputElement).disabled)).toBe(true);
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('turns Cancel into Close the moment dispatch begins', async () => {
    const { controller } = dispatchHarness();
    render(<LiveHarness controller={controller} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();

    // No response yet — not a 202, not a 503, nothing at all.
    await act(async () => { controller.beginDispatch('operation-a'); });
    expect(screen.getByRole('button', { name: 'Close' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('keeps Close after a 503, because the receipt may still have been accepted', async () => {
    const { controller } = dispatchHarness();
    render(<LiveHarness controller={controller} />);
    await act(async () => {
      controller.beginDispatch('operation-a');
      // The dispatch answered 503: the client saw a failure, but receipt commit
      // is durable acceptance and the draft is not discardable on that alone.
      controller.dispatchSettled(null);
    });
    expect(screen.getByRole('button', { name: 'Close' })).toBeVisible();
    expect(controller.canDiscardDraft()).toBe(false);
  });

  it('shows durable progress and the sixty-second copy from the receipt', async () => {
    const { controller } = dispatchHarness();
    render(<LiveHarness controller={controller} />);
    fireEvent.click(screen.getByRole('radio', { name: /Warm Linen/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await act(async () => {
      controller.beginDispatch('operation-a');
      controller.dispatchSettled(answer({ operation: preparing({ completedSteps: 3 }) }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Preparing cover 4 of 6');
    expect(screen.getByRole('status').textContent).not.toMatch(/profile/iu);
  });

  it('detaches polling on close and resumes it on reopen', async () => {
    const { controller, run } = dispatchHarness();
    const { unmount } = render(<LiveHarness controller={controller} />);
    await act(async () => {
      controller.beginDispatch('operation-a');
      controller.dispatchSettled(answer());
    });

    unmount();
    // Closed: polling is detached, and nothing about the operation changed.
    expect(controller.getState().dispatched).toBe(true);
    expect(controller.canDiscardDraft()).toBe(false);
    run();

    render(<LiveHarness controller={controller} />);
    // Reopened: the same operation is still the one being watched.
    expect(controller.getState().operationId).toBe('operation-a');
  });

  it('offers Try again only for a retryable receipt', async () => {
    const { controller } = dispatchHarness();
    render(<LiveHarness controller={controller} />);
    fireEvent.click(screen.getByRole('radio', { name: /Warm Linen/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await act(async () => {
      controller.beginDispatch('operation-a');
      controller.dispatchSettled(answer({
        status: 503,
        operation: preparing({ status: 'retryable-failed', retryable: true }),
      }));
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();

    await act(async () => {
      controller.dispatchSettled(answer({
        operation: preparing({ status: 'permanent-failed', retryable: false }),
      }));
    });
    // A permanent failure needs a corrected draft, not a retry.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('cover studio accessibility', () => {
  it('has no axe violations in any step', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness draft={DRAFT} canRemove />);

    for (const step of ['choose', 'compose', 'style'] as const) {
      if (step === 'compose') {
        await user.click(screen.getByRole('radio', { name: /Upload a photo/u }));
        await user.click(screen.getByRole('button', { name: 'Continue' }));
      }
      if (step === 'style') await user.click(screen.getByRole('button', { name: 'Continue' }));

      // Semantics only. jsdom has no layout, so color-contrast cannot run here —
      // §15.3 puts text-over-image contrast in the deterministic compositor, and
      // axe covers what it can actually see: names, roles, labels, and ARIA.
      const results = await axe.run(container.ownerDocument.body, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect([step, results.violations.map((violation) => violation.id)]).toEqual([step, []]);
    }
  }, 30_000);

  it('names every control and never carries state by image alone', async () => {
    const user = userEvent.setup();
    render(<Harness draft={DRAFT} />);
    // Every preset radio has a text name beside its thumbnail, and every
    // thumbnail is decorative.
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAccessibleName();
    }
    for (const image of document.querySelectorAll('img')) {
      expect(image.getAttribute('alt')).toBe('');
    }

    await user.click(screen.getByRole('radio', { name: /Upload a photo/u }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    for (const slider of screen.getAllByRole('slider')) {
      expect(slider).toHaveAccessibleName();
      expect(slider).toHaveAttribute('aria-valuetext');
    }
  });

  it('restores focus to what opened it', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<Harness />);
    expect(document.activeElement).not.toBe(opener);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('keeps focus inside the sheet', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Cover Studio' });
    const focusable = dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])');
    focusable[focusable.length - 1]!.focus();

    await user.tab();
    // Wrapped back into the sheet rather than out into the inert page behind it.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe('cover upload progress', () => {
  function transferring(sentBytes: number, totalBytes: number): CoverDraftSessionState {
    return {
      status: 'transferring',
      error: null,
      sentBytes,
      totalBytes,
    } as unknown as CoverDraftSessionState;
  }

  it('renders a monotonic determinate 19 MB transfer and throttles polite announcements', async () => {
    const user = userEvent.setup();
    const totalBytes = 19_000_000;
    const { rerender } = render(<Harness
      initialSource={{ kind: 'upload' }}
      composeState={transferring(1_900_000, totalBytes)}
    />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const progress = screen.getByRole('progressbar', { name: 'Uploading cover photo' });
    const announcement = screen.getByRole('status');
    expect(progress).toHaveAttribute('max', String(totalBytes));
    expect(progress).toHaveAttribute('value', '1900000');
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    expect(announcement).toHaveTextContent('Uploading photo, 10%');

    rerender(<Harness
      initialSource={{ kind: 'upload' }}
      composeState={transferring(1_910_000, totalBytes)}
    />);
    expect(screen.getByRole('status')).toBe(announcement);
    expect(announcement).toHaveTextContent('Uploading photo, 10%');

    rerender(<Harness
      initialSource={{ kind: 'upload' }}
      composeState={transferring(1_000_000, totalBytes)}
    />);
    expect(progress).toHaveAttribute('value', '1910000');

    rerender(<Harness
      initialSource={{ kind: 'upload' }}
      composeState={transferring(totalBytes, totalBytes)}
    />);
    expect(progress).toHaveAttribute('value', String(totalBytes));
    expect(announcement).toHaveTextContent('Upload complete');
  });

  it('cancels an active transfer back to the picker and restores its file-control focus', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    function CancelTransferHarness() {
      const [controller] = useState(() => createCoverOperationController({
        eventId: 'event-a',
        schedule: () => () => undefined,
      }));
      const [source, setSource] = useState<CoverSourceChoice | { kind: 'none' } | null>(null);
      const [composeState, setComposeState] = useState<CoverDraftSessionState>({
        status: 'idle',
        error: null,
      });
      return <CoverStudio
        open
        operation={controller}
        operationState={controller.getState()}
        draft={null}
        composeState={composeState}
        source={source}
        focus={null}
        focusMode="auto"
        effect="natural"
        accessFailure={null}
        canRemove={false}
        presetThumbnail={(presetId) => `/assets/event-covers/v1/${presetId}.webp`}
        styleThumbnail={readyThumbnail}
        onSourceChange={setSource}
        onUpload={(file) => setComposeState(transferring(0, file.size))}
        onEnterCompose={vi.fn()}
        onFocusChange={vi.fn()}
        onResetFocus={vi.fn()}
        onEffectChange={vi.fn()}
        onPublish={vi.fn()}
        onDiscardDraft={async () => {
          setSource(null);
          setComposeState({ status: 'idle', error: null });
        }}
        onClose={onClose}
      />;
    }

    render(<CancelTransferHarness />);
    const chooser = screen.getByLabelText<HTMLInputElement>('Choose photo');
    await user.upload(chooser, new File(['photo'], 'porch.jpg', { type: 'image/jpeg' }));
    expect(screen.getByRole('progressbar', { name: 'Uploading cover photo' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Discard cover changes' });
    await user.click(within(confirm).getByRole('button', { name: 'Discard draft' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Choose a cover' })).toBeVisible());
    expect(screen.getByLabelText('Choose photo')).toHaveFocus();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
