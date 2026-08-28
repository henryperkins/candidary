import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import type { ManagerGalleryMediaView } from '../../shared/contracts';
import { GalleryViewer, type ViewerContinuationOutcome } from '../../src/features/gallery/GalleryViewer';

function photo(id: string, caption: string): ManagerGalleryMediaView {
  return {
    id,
    originalFilename: `${id}.jpg`,
    guestName: 'Jose',
    caption,
    publicationStatus: 'unpublished',
    previewAvailable: true,
    width: null,
    height: null,
    receivedAt: '2026-08-15T22:42:00.000Z',
    timelineAt: '2026-08-15T22:42:00.000Z',
    timelineSource: 'received',
    isFavorite: false,
  };
}

const firstDance = photo('first-dance', 'First dance');
const cakeCutting = photo('cake-cutting', 'Cake cutting');

type LoadNextAfter = (photoId: string) => Promise<ViewerContinuationOutcome>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

interface ViewerHarnessProps {
  photos?: ManagerGalleryMediaView[];
  initialPhotoId?: string;
  hasMore?: boolean;
  loadNextAfter: LoadNextAfter;
  onClose?: () => void;
  onPhotoChange?: (photoId: string) => void;
}

function ViewerHarness({
  photos = [firstDance],
  initialPhotoId = photos.at(-1)?.id ?? firstDance.id,
  hasMore = true,
  loadNextAfter,
  onClose = vi.fn(),
  onPhotoChange,
}: ViewerHarnessProps) {
  const [photoId, setPhotoId] = useState(initialPhotoId);
  return <GalleryViewer
    photos={photos}
    photoId={photoId}
    timeZone="America/Chicago"
    hasMore={hasMore}
    favoritePendingIds={new Set()}
    onPhotoChange={(nextPhotoId) => {
      setPhotoId(nextPhotoId);
      onPhotoChange?.(nextPhotoId);
    }}
    loadNextAfter={loadNextAfter}
    onClose={onClose}
    onFavorite={vi.fn()}
  />;
}

function UnmountingViewerHarness({
  loadNextAfter,
  onClose,
  onPhotoChange,
}: Pick<ViewerHarnessProps, 'loadNextAfter' | 'onClose' | 'onPhotoChange'>) {
  const [open, setOpen] = useState(true);
  return open
    ? <ViewerHarness
        loadNextAfter={loadNextAfter}
        onPhotoChange={onPhotoChange}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
      />
    : null;
}

afterEach(() => cleanup());

describe('GalleryViewer continuation', () => {
  it('retains its modal label, focus, containment boundary, scroll lock, Escape, and return focus', async () => {
    // Mutations caught: losing Gallery-only behavior while adopting the shared modal mechanics.
    const origin = document.createElement('button');
    origin.textContent = 'Open first dance';
    document.body.append(origin);
    origin.focus();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<UnmountingViewerHarness
      loadNextAfter={vi.fn(async () => ({ status: 'exhausted' }))}
      onClose={onClose}
      onPhotoChange={vi.fn()}
    />);

    const dialog = screen.getByRole('dialog', { name: 'First dance' });
    expect(within(dialog).getByRole('button', { name: 'Close viewer' })).toHaveFocus();
    expect(origin).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onClose).toHaveBeenCalledOnce();
    expect(origin).not.toHaveAttribute('inert');
    expect(origin).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
    origin.remove();
  });

  it('requests the next page from the last loaded photo while keeping that photo visible', async () => {
    // Mutation caught: disabling the last-row Next control when hasMore is true.
    const continuation = deferred<ViewerContinuationOutcome>();
    const loadNextAfter = vi.fn(() => continuation.promise);
    const user = userEvent.setup();

    render(<ViewerHarness loadNextAfter={loadNextAfter} />);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Load next photo' })).toBeEnabled();
    await user.keyboard('{ArrowRight}');
    expect(within(dialog).getByText('First dance')).toBeVisible();
    expect(loadNextAfter).toHaveBeenCalledOnce();
    expect(loadNextAfter).toHaveBeenCalledWith('first-dance');
  });

  it('keeps one continuation in flight across repeated next activation', async () => {
    // Mutation caught: removing the in-flight promise guard starts duplicate owner requests.
    const continuation = deferred<ViewerContinuationOutcome>();
    const loadNextAfter = vi.fn(() => continuation.promise);
    const user = userEvent.setup();

    render(<ViewerHarness loadNextAfter={loadNextAfter} />);

    await user.click(screen.getByRole('button', { name: 'Load next photo' }));
    await user.keyboard('{ArrowRight}');

    expect(loadNextAfter).toHaveBeenCalledOnce();
    expect(screen.getByText('First dance')).toBeVisible();
  });

  it('changes to the owner-provided next photo ID after continuation advances', async () => {
    // Mutation caught: using a loaded-array index instead of the continuation ID.
    const loadNextAfter = vi.fn(async (): Promise<ViewerContinuationOutcome> => ({
      status: 'advanced',
      nextPhotoId: 'first-dance',
    }));
    const onPhotoChange = vi.fn();
    const user = userEvent.setup();

    render(<ViewerHarness
      photos={[firstDance, cakeCutting]}
      loadNextAfter={loadNextAfter}
      onPhotoChange={onPhotoChange}
    />);

    await user.keyboard('{ArrowRight}');

    await waitFor(() => expect(onPhotoChange).toHaveBeenCalledWith('first-dance'));
    expect(screen.getByText('First dance')).toBeVisible();
  });

  it('renders an unavailable Next photo control when continuation is exhausted', async () => {
    // Mutation caught: treating exhaustion as a retryable or successful continuation.
    const loadNextAfter = vi.fn(async (): Promise<ViewerContinuationOutcome> => ({ status: 'exhausted' }));
    const user = userEvent.setup();

    render(<ViewerHarness loadNextAfter={loadNextAfter} />);

    await user.keyboard('{ArrowRight}');

    expect(loadNextAfter).toHaveBeenCalledWith('first-dance');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next photo' })).toBeDisabled());
    expect(screen.getByText('First dance')).toBeVisible();
  });

  it('offers a focused retry after continuation fails without changing the current photo', async () => {
    // Mutation caught: dropping continuation failures or moving away from the current photo.
    const loadNextAfter = vi.fn(async (): Promise<ViewerContinuationOutcome> => ({ status: 'failed' }));
    const user = userEvent.setup();

    render(<ViewerHarness loadNextAfter={loadNextAfter} />);

    await user.keyboard('{ArrowRight}');

    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the next photo. Try again.');
    expect(retry).toHaveFocus();
    expect(screen.getByText('First dance')).toBeVisible();
  });

  it.each([
    ['advanced', { status: 'advanced', nextPhotoId: firstDance.id } satisfies ViewerContinuationOutcome],
    ['exhausted', { status: 'exhausted' } satisfies ViewerContinuationOutcome],
  ])('keeps focus contained during retry and transfers it before %s settlement', async (_status, outcome) => {
    // Mutation caught: clearing the failure at retry start removes the focused control and
    // leaves the modal without a focus owner while the second request is pending.
    const retryContinuation = deferred<ViewerContinuationOutcome>();
    const loadNextAfter = vi.fn<LoadNextAfter>()
      .mockResolvedValueOnce({ status: 'failed' })
      .mockImplementationOnce(() => retryContinuation.promise);
    const user = userEvent.setup();

    render(<ViewerHarness loadNextAfter={loadNextAfter} />);

    await user.keyboard('{ArrowRight}');
    const dialog = screen.getByRole('dialog');
    const retry = await within(dialog).findByRole('button', { name: 'Try again' });
    expect(retry).toHaveFocus();

    await user.click(retry);

    expect(retry).toBeInTheDocument();
    expect(retry).toHaveFocus();
    expect(document.activeElement?.closest('[role="dialog"]')).toBe(dialog);

    await act(async () => retryContinuation.resolve(outcome));

    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Try again' }))
      .not.toBeInTheDocument());
    expect(within(dialog).getByRole('button', { name: 'Close viewer' })).toHaveFocus();
    expect(document.activeElement?.closest('[role="dialog"]')).toBe(dialog);
  });

  it('returns focus to Retry when a deferred retry fails again', async () => {
    // Mutation caught: retaining an already-true failure state without an explicit settlement
    // focus leaves Retry autofocus dependent on whether the state value happened to change.
    const retryContinuation = deferred<ViewerContinuationOutcome>();
    const loadNextAfter = vi.fn<LoadNextAfter>()
      .mockResolvedValueOnce({ status: 'failed' })
      .mockImplementationOnce(() => retryContinuation.promise);
    const user = userEvent.setup();

    render(<ViewerHarness loadNextAfter={loadNextAfter} />);

    await user.keyboard('{ArrowRight}');
    const dialog = screen.getByRole('dialog');
    const retry = await within(dialog).findByRole('button', { name: 'Try again' });
    await user.click(retry);
    within(dialog).getByRole('button', { name: 'Close viewer' }).focus();

    await act(async () => retryContinuation.resolve({ status: 'failed' }));

    expect(retry).toHaveFocus();
    expect(document.activeElement?.closest('[role="dialog"]')).toBe(dialog);
  });

  it('ignores a stale continuation after Previous changes the current photo', async () => {
    // Mutation caught: applying a settled request after the viewer identity changed.
    const continuation = deferred<ViewerContinuationOutcome>();
    const loadNextAfter = vi.fn(() => continuation.promise);
    const onPhotoChange = vi.fn();
    const user = userEvent.setup();

    render(<ViewerHarness
      photos={[firstDance, cakeCutting]}
      loadNextAfter={loadNextAfter}
      onPhotoChange={onPhotoChange}
    />);

    await user.keyboard('{ArrowRight}{ArrowLeft}');
    expect(screen.getByText('First dance')).toBeVisible();
    onPhotoChange.mockClear();

    await act(async () => continuation.resolve({ status: 'advanced', nextPhotoId: 'cake-cutting' }));

    expect(onPhotoChange).not.toHaveBeenCalled();
    expect(screen.getByText('First dance')).toBeVisible();
  });

  it('does not render a stale continuation failure after Previous changes the current photo', async () => {
    // Mutation caught: allowing a stale failed request to set dialog-local retry state.
    const continuation = deferred<ViewerContinuationOutcome>();
    const loadNextAfter = vi.fn(() => continuation.promise);
    const onPhotoChange = vi.fn();
    const user = userEvent.setup();

    render(<ViewerHarness
      photos={[firstDance, cakeCutting]}
      loadNextAfter={loadNextAfter}
      onPhotoChange={onPhotoChange}
    />);

    await user.keyboard('{ArrowRight}{ArrowLeft}');
    onPhotoChange.mockClear();
    await act(async () => continuation.resolve({ status: 'failed' }));

    expect(onPhotoChange).not.toHaveBeenCalled();
    expect(screen.getByText('First dance')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('ignores a stale continuation after Close', async () => {
    // Mutation caught: letting a settled request update dialog-local state after close.
    const continuation = deferred<ViewerContinuationOutcome>();
    const loadNextAfter = vi.fn(() => continuation.promise);
    const onClose = vi.fn();
    const onPhotoChange = vi.fn();
    const user = userEvent.setup();

    render(<ViewerHarness
      loadNextAfter={loadNextAfter}
      onClose={onClose}
      onPhotoChange={onPhotoChange}
    />);

    await user.keyboard('{ArrowRight}');
    expect(loadNextAfter).toHaveBeenCalledWith('first-dance');
    await user.click(screen.getByRole('button', { name: 'Close viewer' }));
    await act(async () => continuation.resolve({ status: 'advanced', nextPhotoId: 'cake-cutting' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onPhotoChange).not.toHaveBeenCalled();
  });

  it('unmounts after Close without a late failed continuation reopening dialog-local error UI', async () => {
    // Mutation caught by the previous-photo failure test: bypassing the shared stale-result guard.
    const continuation = deferred<ViewerContinuationOutcome>();
    const loadNextAfter = vi.fn(() => continuation.promise);
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<UnmountingViewerHarness
      loadNextAfter={loadNextAfter}
      onClose={onClose}
      onPhotoChange={vi.fn()}
    />);

    await user.keyboard('{ArrowRight}');
    await user.click(screen.getByRole('button', { name: 'Close viewer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await act(async () => continuation.resolve({ status: 'failed' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
