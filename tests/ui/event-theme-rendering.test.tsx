import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EVENT_THEME_PRESETS, resolveEventTheme } from '../../shared/event-theme';
import { guestEventCoverPath, managerEventCoverPath } from '../../src/app/api';
import { useEventCover } from '../../src/app/use-event-cover';
import { EventAppearancePreview } from '../../src/components/EventAppearancePreview';
import { EventThemePresetSelector } from '../../src/components/EventThemePresetSelector';

const coastalTheme = resolveEventTheme({ version: 1, presetId: 'coastal-light', overrides: {} });
const previewEvent = {
  id: 'event-a',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'Come share the moments you caught.',
  coverObjectKey: 'events/event-a/cover/private-photo.jpg',
};

function CoverRenderProbe({ path, onRender }: { path: string | null; onRender: (state: { path: string | null; cover: string | null; hasCoverModifier: boolean }) => void }) {
  const cover = useEventCover(path);
  onRender({ path, cover, hasCoverModifier: Boolean(cover) });
  return <output className={cover ? 'cover-modifier' : ''} data-testid="cover-render-probe">{cover}</output>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('event theme primitives', () => {
  it('renders four labelled native preset radios with text and palette samples', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<EventThemePresetSelector
      name="theme"
      value="garden-party"
      onChange={onChange}
    />);

    expect(screen.getAllByRole('radio')).toHaveLength(4);
    for (const preset of EVENT_THEME_PRESETS) {
      expect(screen.getByRole('radio', { name: preset.name })).toBeInTheDocument();
      expect(screen.getByText(preset.description)).toBeVisible();
    }
    expect(screen.getByRole('radio', { name: 'Garden Party' })).toBeChecked();
    expect(container.querySelectorAll('[data-event-theme-swatch]')).toHaveLength(4);
    expect(container.querySelector('[style*="--event-"]')).toBeNull();

    await user.click(screen.getByRole('radio', { name: 'Coastal Light' }));
    expect(onChange).toHaveBeenCalledWith('coastal-light');
  });

  it('scopes an inert Coastal Light preview to its own wrapper', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const { container } = render(<>
      <aside data-testid="manager-chrome">Manager chrome</aside>
      <EventAppearancePreview event={previewEvent} theme={coastalTheme} />
    </>);

    const preview = screen.getByTestId('event-appearance-preview');
    expect(preview.style.getPropertyValue('--event-page')).toBe('#edf7f5');
    expect(preview.style.getPropertyValue('--event-primary')).toBe('#0c6370');
    expect(document.documentElement.style.getPropertyValue('--event-page')).toBe('');
    expect(screen.getByTestId('manager-chrome').style.getPropertyValue('--event-page')).toBe('');
    expect(preview).toHaveTextContent('Maya & Theo');
    expect(preview).toHaveTextContent('September 19, 2026');
    expect(preview).toHaveTextContent('Come share the moments you caught.');
    expect(preview).toHaveTextContent('Add your photos');
    expect(preview).toHaveTextContent('View the gallery');
    expect(preview.querySelector('.event-appearance-preview__surface')).not.toBeNull();
    expect(preview.querySelectorAll('button, a, input, textarea, select, [role="button"], h1, h2, h3, h4, h5, h6')).toHaveLength(0);
    expect(container.querySelector('figcaption')).toHaveTextContent('Preview only');
    expect(preview.querySelector('[aria-hidden="true"]')).not.toBeNull();
    await waitFor(() => expect(preview.querySelector('.event-appearance-preview__hero--covered')).toBeNull());
  });

  it('loads a private cover only after a same-origin successful read, replaces it, and revokes every blob URL once', async () => {
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:cover-a')
      .mockReturnValueOnce('blob:cover-b');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_path: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return Promise.resolve(new Response(new Blob([signals.length === 1 ? 'a' : 'b']), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<EventAppearancePreview event={previewEvent} theme={coastalTheme} />);
    const preview = screen.getByTestId('event-appearance-preview');
    await waitFor(() => expect(preview.querySelector('.event-appearance-preview__hero--covered')).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(managerEventCoverPath('event-a'), expect.objectContaining({
      credentials: 'same-origin', signal: expect.any(AbortSignal),
    }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(preview.style.getPropertyValue('--event-cover')).toContain('blob:cover-a');

    view.rerender(<EventAppearancePreview event={{ ...previewEvent, id: 'event-b', coverObjectKey: 'events/event-b/cover/private-photo.jpg' }} theme={coastalTheme} />);
    await waitFor(() => expect(preview.style.getPropertyValue('--event-cover')).toContain('blob:cover-b'));
    expect(signals[0]?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith(managerEventCoverPath('event-b'), expect.objectContaining({
      credentials: 'same-origin', signal: expect.any(AbortSignal),
    }));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenLastCalledWith('blob:cover-a');

    view.unmount();
    expect(signals[1]?.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenLastCalledWith('blob:cover-b');
  });

  it('keeps the no-cover hero when a private cover read is not OK', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    render(<EventAppearancePreview event={previewEvent} theme={coastalTheme} />);

    const preview = screen.getByTestId('event-appearance-preview');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => { resolveResponse!(new Response(null, { status: 404 })); });
    expect(preview.querySelector('.event-appearance-preview__hero--covered')).toBeNull();
    expect(preview.style.getPropertyValue('--event-cover')).toBe('');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('discards a stale private cover completion after its path is replaced', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const createObjectURL = vi.fn().mockReturnValueOnce('blob:cover-b').mockReturnValueOnce('blob:stale-a');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(new Response(new Blob(['b']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<EventAppearancePreview event={previewEvent} theme={coastalTheme} />);
    view.rerender(<EventAppearancePreview event={{ ...previewEvent, id: 'event-b', coverObjectKey: 'events/event-b/cover/private-photo.jpg' }} theme={coastalTheme} />);
    const preview = screen.getByTestId('event-appearance-preview');
    await waitFor(() => expect(preview.style.getPropertyValue('--event-cover')).toContain('blob:cover-b'));
    await act(async () => { resolveFirst!(new Response(new Blob(['a']), { status: 200 })); });

    expect(preview.style.getPropertyValue('--event-cover')).toContain('blob:cover-b');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:stale-a');
  });

  it('does not render a previous private cover while a replacement path is still loading', async () => {
    const renders: Array<{ path: string | null; cover: string | null; hasCoverModifier: boolean }> = [];
    let resolveSecond: ((response: Response) => void) | undefined;
    vi.stubGlobal('URL', { createObjectURL: vi.fn().mockReturnValue('blob:cover-a'), revokeObjectURL: vi.fn() });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(new Blob(['a']), { status: 200 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSecond = resolve; })));

    const view = render(<CoverRenderProbe path="/api/manage/events/event-a/cover" onRender={(state) => renders.push(state)} />);
    await waitFor(() => expect(screen.getByTestId('cover-render-probe')).toHaveTextContent('blob:cover-a'));
    renders.length = 0;

    view.rerender(<CoverRenderProbe path="/api/manage/events/event-b/cover" onRender={(state) => renders.push(state)} />);

    expect(renders[0]).toEqual({
      path: '/api/manage/events/event-b/cover', cover: null, hasCoverModifier: false,
    });
    expect(screen.getByTestId('cover-render-probe')).not.toHaveClass('cover-modifier');
    expect(screen.getByTestId('cover-render-probe')).toHaveTextContent('');
    await act(async () => { resolveSecond!(new Response(null, { status: 404 })); });
  });

  it('encodes guest and manager cover identifiers into only their authorized paths', () => {
    expect(guestEventCoverPath('maya/theo?')).toBe('/api/event/maya%2Ftheo%3F/cover');
    expect(managerEventCoverPath('event/a?')).toBe('/api/manage/events/event%2Fa%3F/cover');
  });
});
