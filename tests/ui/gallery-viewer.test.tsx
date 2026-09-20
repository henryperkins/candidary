import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import type { ManagerGalleryMediaView } from '../../shared/contracts';
import { GalleryViewer, type ViewerContinuationOutcome } from '../../src/features/gallery/GalleryViewer';
import type { LibraryFileActions, TrashOutcome } from '../../src/features/gallery/library-file-actions';

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
  fileActions?: LibraryFileActions;
  onTrashConfirmed?: (photoId: string) => Promise<ViewerContinuationOutcome>;
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
  fileActions,
  onTrashConfirmed,
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
    fileActions={fileActions}
    onTrashConfirmed={onTrashConfirmed}
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

describe('GalleryViewer file actions', () => {
  it('does not let an earlier next-page request change the confirmation target', async () => {
    const user = userEvent.setup();
    const pending = deferred<ViewerContinuationOutcome>();
    render(<ViewerHarness photos={[firstDance, cakeCutting]} initialPhotoId={cakeCutting.id}
      loadNextAfter={() => pending.promise} fileActions={{ canTrash: true, trash: vi.fn() }} />);
    await user.click(screen.getByRole('button', { name: 'Load next photo' }));
    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await act(async () => pending.resolve({ status: 'advanced', nextPhotoId: firstDance.id }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Cake cutting');
    expect(screen.getByRole('button', { name: 'Keep photo' })).toHaveFocus();
  });
  it('downloads the original and confirms inside one modal with safe focus and complete consequences', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ViewerHarness photos={[firstDance, cakeCutting]} initialPhotoId={firstDance.id}
      loadNextAfter={async () => ({ status: 'exhausted' })} onClose={onClose}
      fileActions={{ canTrash: true, trash: vi.fn() }} />);
    expect(screen.getByRole('link', { name: 'Download original' })).toHaveAttribute('href', '/api/media/first-dance/original');
    expect(screen.getByText('first-dance.jpg')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));
    const dialog = screen.getByRole('dialog', { name: 'Move this photo to Trash?' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Keep photo' })).toHaveFocus();
    expect(dialog).toHaveTextContent('up to 30 days');
    expect(dialog).toHaveTextContent('cannot be recalled');
    expect(dialog).toHaveTextContent('keeps its own copy');
    await user.keyboard('{ArrowRight}{Escape}');
    expect(screen.getByRole('dialog', { name: 'First dance' })).toBe(dialog);
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.getByRole('button', { name: 'Move to Trash' })).toHaveFocus();
  });

  it.each(['retired', 'failed'] as const)('unlocks the original photo after a %s write', async (result) => {
    const user = userEvent.setup();
    const pending = deferred<TrashOutcome>();
    const trash = vi.fn(() => result === 'failed' ? Promise.reject(new Error('Write refused')) : pending.promise);
    const onClose = vi.fn();
    const onTrashConfirmed = vi.fn();
    render(<ViewerHarness loadNextAfter={async () => ({ status: 'exhausted' })} onClose={onClose}
      fileActions={{ canTrash: true, trash }} onTrashConfirmed={onTrashConfirmed} />);
    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));
    if (result === 'retired') {
      expect(screen.getByRole('button', { name: 'Keep photo' })).toBeDisabled();
      await user.keyboard('{Escape}{ArrowRight}');
      fireEvent.mouseDown(screen.getByRole('dialog'));
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => pending.resolve({ status: 'retired' }));
    }
    expect(await screen.findByRole('button', { name: 'Move to Trash' })).toBeEnabled();
    expect(screen.getByRole('dialog', { name: 'First dance' })).toBeVisible();
    expect(onTrashConfirmed).not.toHaveBeenCalled();
    expect(trash).toHaveBeenCalledOnce();
    if (result === 'failed') expect(screen.getByRole('alert')).toHaveTextContent('Write refused');
  });

  it('keeps a failed Trash write with its photo when the controlled viewer changes', async () => {
    const user = userEvent.setup();
    render(<ViewerHarness photos={[firstDance, cakeCutting]} initialPhotoId={firstDance.id}
      hasMore={false} loadNextAfter={async () => ({ status: 'exhausted' })}
      fileActions={{ canTrash: true, trash: vi.fn(async () => { throw new Error('Write refused'); }) }} />);

    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Write refused');

    await user.click(screen.getByRole('button', { name: 'Next photo' }));

    expect(screen.getByRole('dialog', { name: 'Cake cutting' })).toBeVisible();
    expect(screen.queryByText('Write refused')).not.toBeInTheDocument();
  });

  it('keeps a successful deletion distinct from failed continuation and retries only the read', async () => {
    const user = userEvent.setup();
    const trash = vi.fn(async (): Promise<TrashOutcome> => ({ status: 'trashed', media: {
      id: firstDance.id, originalFilename: firstDance.originalFilename, caption: firstDance.caption,
      guestName: firstDance.guestName, trashedAt: '2026-09-15T00:00:00Z', restoreUntil: '2026-10-15T00:00:00Z',
    } }));
    const loadNextAfter = vi.fn(async (): Promise<ViewerContinuationOutcome> => ({ status: 'advanced', nextPhotoId: cakeCutting.id }));
    render(<ViewerHarness photos={[firstDance, cakeCutting]} initialPhotoId={firstDance.id} loadNextAfter={loadNextAfter}
      fileActions={{ canTrash: true, trash }} onTrashConfirmed={async () => ({ status: 'failed' })} />);
    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));
    expect(await screen.findByText('Photo moved to Trash. Could not load the next photo.')).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Library' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('dialog', { name: 'Cake cutting' })).toBeVisible();
    expect(trash).toHaveBeenCalledOnce();
    expect(loadNextAfter).toHaveBeenCalledOnce();
  });
});

describe('GalleryViewer continuation', () => {
  it('retains ordinary modal Tab wrapping when the allowed live host has no controls', async () => {
    const user = userEvent.setup();
    const liveHost = document.createElement('div');
    liveHost.dataset.galleryLiveHost = 'true';
    liveHost.textContent = 'Photo status';
    document.body.append(liveHost);
    const view = render(<ViewerHarness loadNextAfter={async () => ({ status: 'exhausted' })} />);
    const close = screen.getByRole('button', { name: 'Close viewer' });
    const favorite = screen.getByRole('button', { name: 'Pick First dance for the Album' });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(favorite).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    expect(liveHost).not.toHaveAttribute('inert');
    view.unmount();
    liveHost.remove();
  });
  it('retains its modal label, focus, containment boundary, scroll lock, Escape, and return focus', async () => {
    // Mutations caught: losing Gallery-only behavior while adopting the shared modal mechanics.
    const origin = document.createElement('button');
    origin.textContent = 'Open first dance';
    document.body.append(origin);
    origin.focus();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<UnmountingViewerHarness
      loadNextAfter={vi.fn(async (): Promise<ViewerContinuationOutcome> => ({ status: 'exhausted' }))}
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
