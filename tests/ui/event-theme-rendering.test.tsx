import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GuestEventView, ResolvedEventTheme } from '../../shared/contracts';
import {
  DEFAULT_EVENT_THEME_CONFIG,
  EVENT_THEME_PRESETS,
  resolveEventTheme,
} from '../../shared/event-theme';
import { guestEventCoverPath, managerEventCoverPath } from '../../src/app/api';
import { EVENT_THEME_CSS_PROPERTIES } from '../../src/app/event-theme-style';
import { useEventCover } from '../../src/app/use-event-cover';
import { EventAppearancePreview } from '../../src/components/EventAppearancePreview';
import { EventThemePresetSelector } from '../../src/components/EventThemePresetSelector';
import { EventPage } from '../../src/pages/EventPage';

const guestStyles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

const coastalTheme = resolveEventTheme({ version: 1, presetId: 'coastal-light', overrides: {} });
const previewEvent = {
  id: 'event-a',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'Come share the moments you caught.',
  coverObjectKey: 'cover-present',
};
const baseGuestEvent: Omit<GuestEventView, 'theme'> = {
  id: 'event-a',
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'Come share the moments you caught.',
  coverObjectKey: null,
  uploadsEnabled: true,
  galleryVisible: true,
  moderationRequired: true,
  eventTimezone: 'America/Chicago',
  eventStartAt: '2026-09-19T22:00:00.000Z',
  rsvpDeadlineAt: null,
  rsvpDeadlineDate: null,
  phase: 'photos-primary' as const,
  rsvpState: 'disabled' as const,
  rsvpAccess: 'unavailable' as const,
  lifecycleRecheckAfterMs: null,
};

function json(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

function guestRoute(event: GuestEventView | (Omit<GuestEventView, 'theme'> & { theme?: never }), fullscreen = false) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/api/event/maya-theo')) return json({ event, role: 'guest' });
    if (path.endsWith('/gallery')) return json({ media: [] });
    throw new Error(`Unexpected request ${path}`);
  }));
  return render(<MemoryRouter initialEntries={[fullscreen ? '/event/maya-theo/fullscreen' : '/event/maya-theo']}>
    <aside data-testid="outside-guest-scope">Host chrome</aside>
    <Routes>
      <Route path="/event/:slug" element={<EventPage />} />
      <Route path="/event/:slug/fullscreen" element={<EventPage fullscreen />} />
    </Routes>
  </MemoryRouter>);
}

function inlineEventProperties(element: HTMLElement): string[] {
  return Array.from({ length: element.style.length }, (_, index) => element.style.item(index))
    .filter((property) => property.startsWith('--event-'))
    .sort();
}

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

    view.rerender(<EventAppearancePreview event={{ ...previewEvent, id: 'event-b', coverObjectKey: 'cover-present' }} theme={coastalTheme} />);
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
    view.rerender(<EventAppearancePreview event={{ ...previewEvent, id: 'event-b', coverObjectKey: 'cover-present' }} theme={coastalTheme} />);
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

describe('guest event theme rendering', () => {
  const customTheme = resolveEventTheme({
    version: 1,
    presetId: 'candidary-default',
    overrides: { primaryColor: '#005f73', accentColor: '#c94b3c' },
  });

  it.each([...EVENT_THEME_PRESETS.map(({ id }) => resolveEventTheme({
    version: 1,
    presetId: id,
    overrides: {},
  })), customTheme])('installs only the 45 resolved variables on the loaded guest scope for $config.presetId', async (theme) => {
    guestRoute({ ...baseGuestEvent, theme });
    const heading = await screen.findByRole('heading', { name: baseGuestEvent.welcomeMessage });
    const scope = heading.closest('.guest-shell--drop') as HTMLElement;
    const expectedProperties = Object.values(EVENT_THEME_CSS_PROPERTIES).sort();

    expect(inlineEventProperties(scope)).toEqual(expectedProperties);
    expect(inlineEventProperties(scope)).toHaveLength(45);
    for (const [token, property] of Object.entries(EVENT_THEME_CSS_PROPERTIES) as Array<
      [keyof ResolvedEventTheme['tokens'], string]
    >) {
      expect(scope.style.getPropertyValue(property), token).toBe(theme.tokens[token]);
    }
    expect(document.documentElement.style.cssText).not.toContain('--event-');
    expect(screen.getByTestId('outside-guest-scope').style.cssText).not.toContain('--event-');
  });

  it('uses the canonical default defensively when a legacy runtime response lacks theme', async () => {
    const defaultTheme = resolveEventTheme(DEFAULT_EVENT_THEME_CONFIG);
    guestRoute(baseGuestEvent);

    const scope = (await screen.findByRole('heading', { name: baseGuestEvent.welcomeMessage }))
      .closest('.guest-shell--drop') as HTMLElement;
    expect(scope.style.getPropertyValue('--event-page')).toBe(defaultTheme.tokens.page);
    expect(scope.style.getPropertyValue('--event-primary')).toBe(defaultTheme.tokens.primary);
    expect(inlineEventProperties(scope)).toHaveLength(45);
  });

  it('leaves loading and authorization errors on global Candidary chrome', async () => {
    let rejectLoad!: (reason: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_resolve, reject) => {
      rejectLoad = reject;
    })));
    render(<MemoryRouter initialEntries={['/event/maya-theo']}>
      <Routes><Route path="/event/:slug" element={<EventPage />} /></Routes>
    </MemoryRouter>);

    const loading = screen.getByText('Gathering the details…').closest('.centered-state') as HTMLElement;
    expect(inlineEventProperties(loading)).toEqual([]);

    await act(async () => rejectLoad(new Error('forbidden')));
    const error = await screen.findByRole('alert');
    expect(inlineEventProperties(error.closest('.centered-state') as HTMLElement)).toEqual([]);
    expect(document.querySelector('.guest-shell--drop')).toBeNull();
  });

  it('installs one independent resolved scope on the loaded full-screen gallery', async () => {
    const theme = resolveEventTheme({ version: 1, presetId: 'midnight-film', overrides: {} });
    guestRoute({ ...baseGuestEvent, theme }, true);

    const scope = (await screen.findByRole('heading', { name: 'Shared gallery · Maya & Theo' }))
      .closest('.fullscreen') as HTMLElement;
    expect(inlineEventProperties(scope)).toEqual(Object.values(EVENT_THEME_CSS_PROPERTIES).sort());
    expect(scope.style.getPropertyValue('--event-fullscreen-backdrop')).toBe('#0b1020');
    expect(scope.style.getPropertyValue('--event-fullscreen-foreground')).toBe('#ffffff');
    expect(screen.getByTestId('outside-guest-scope').style.cssText).not.toContain('--event-');
  });

  it('maps guest selectors to distinct semantic roles while fixed state colors stay fixed', () => {
    const brightPrimaryTheme = resolveEventTheme({
      version: 1,
      presetId: 'candidary-default',
      overrides: { primaryColor: '#f2c94c' },
    });
    const declaration = (selector: string, property: string) => {
      const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const ruleMatch = guestStyles.match(new RegExp(`(?:^|\\})\\s*${escapedSelector}\\s*\\{`, 'mu'));
      expect(ruleMatch, selector).not.toBeNull();
      const bodyStart = (ruleMatch!.index ?? 0) + ruleMatch![0].length;
      const body = guestStyles.slice(bodyStart, guestStyles.indexOf('}', bodyStart));
      const declarationMatch = body.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, 'u'));
      expect(declarationMatch, `${selector} ${property}`).not.toBeNull();
      return declarationMatch![1]!.trim();
    };

    expect(declaration('.photo-drop__name strong', 'color')).toBe('var(--event-required-text)');
    expect(declaration('.sending-as', 'border')).toContain('var(--event-remembered-name-border)');
    expect(declaration('.review-heading', 'border-bottom')).toContain('var(--event-review-divider)');
    expect(declaration('.selection-card__image', 'background')).toContain('var(--event-media-placeholder-start)');
    expect(declaration('.selection-card__image', 'color')).toBe('var(--event-media-placeholder-foreground)');
    expect(declaration('.selection-summary', 'color')).toBe('var(--event-selection-summary-text)');
    expect(declaration('.guest-shell--drop .text-button', 'color')).toBe('var(--event-primary-on-surface)');
    expect(declaration('.new-badge', 'color')).toBe('var(--event-primary-on-surface)');
    expect(brightPrimaryTheme.tokens.primary).toBe('#f2c94c');
    expect(brightPrimaryTheme.tokens.primaryOnSurface).not.toBe(brightPrimaryTheme.tokens.primary);
    expect(declaration('.selection-card__spinner, .selection-card__delivered', 'color')).toBe('var(--event-primary-on-surface)');
    expect(declaration('.selection-card__status progress', 'accent-color')).toBe('var(--event-primary)');
    expect(declaration('.photo-drop__hero::after', 'background'))
      .toContain('var(--event-hero-overlay-top)');
    expect(declaration('.selection-card--failed', 'border-color')).toBe('#d99b93');
    expect(declaration('.selection-card--delivered', 'border-color')).toBe('#b8c9ae');
    expect(declaration('.selection-card__delivered', 'color')).toBe('#31552d');
    expect(declaration('.field-error', 'color')).toBe('var(--danger)');
    expect(declaration('.fullscreen figcaption', 'background')).toContain('rgb(0 0 0 / 65%)');
  });

  /* The stylesheet used to carry a second copy of the Candidary Default preset: a 45-declaration
     block plus a literal inside every `var()`. Nothing ever reached it — the three roots that scope
     these variables each inject the resolved set inline — so it was a silent duplicate that had to be
     re-derived by hand on every palette change, and the chestnut/denim migration shows what that
     costs. Removing it only holds if it cannot grow back one declaration at a time. */
  it('reads event tokens without restating the default preset as a fallback', () => {
    expect(guestStyles.match(/var\(--event-[a-z0-9-]+,[^)]*/gu) ?? []).toEqual([]);
  });

  it('keeps RSVP controls narrow-first and mapped to event semantic variables', () => {
    expect(guestStyles).toContain('.rsvp-flow');
    expect(guestStyles).toContain('.rsvp-attendance');
    expect(guestStyles).toContain('var(--event-surface)');
    expect(guestStyles).toContain('var(--event-primary)');
    expect(guestStyles).toContain('var(--event-focus)');
    expect(guestStyles).toMatch(/\.rsvp-[^{]+\{[^}]*min-height:\s*44px/u);
  });
});
