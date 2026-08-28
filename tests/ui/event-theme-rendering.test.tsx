import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventView, GuestEventView, ResolvedEventTheme } from '../../shared/contracts';
import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import { presetCoverAssetPath } from '../../shared/event-cover-assets';
import {
  DEFAULT_EVENT_THEME_CONFIG,
  EVENT_THEME_PRESETS,
  resolveEventTheme,
} from '../../shared/event-theme';
import {
  guestEventCoverSlotPath,
  managerEventCoverSlotPath,
} from '../../src/app/api';
import { EVENT_THEME_CSS_PROPERTIES } from '../../src/app/event-theme-style';
import { emitCoverUnavailable } from '../../src/app/cover-observability';
import { EventAppearanceCanvas } from '../../src/components/EventAppearanceCanvas';
import { EventThemePresetSelector } from '../../src/components/EventThemePresetSelector';
import { EventPage } from '../../src/pages/EventPage';

const guestStyles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

const coastalTheme = resolveEventTheme({ version: 1, presetId: 'coastal-light', overrides: {} });
const previewEvent = {
  id: 'event-a',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'Come share the moments you caught.',
  cover: {
    config: {
      version: 1,
      source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 },
      effect: 'natural',
    },
    revision: 1,
    hasCover: true,
    available2xProfiles: [],
    surfaceTreatment: 'none',
    preparation: null,
  },
} satisfies Pick<EventView, 'id' | 'name' | 'eventDate' | 'welcomeMessage' | 'cover'>;
const baseGuestEvent: Omit<GuestEventView, 'theme'> = {
  id: 'event-a',
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'Come share the moments you caught.',
  guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
  cover: { revision: 0, hasCover: false, available2xProfiles: [], surfaceTreatment: 'none' },
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
  guestReadSurfaces: { available: true, reason: null } as const,
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

function installMeasuredCover(width = 620) {
  class TestResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{
        target,
        contentRect: { width } as DOMRectReadOnly,
      } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
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

  it('scopes every Coastal Light token to one inert live canvas', () => {
    const { container } = render(<>
      <aside data-testid="manager-chrome">Manager chrome</aside>
      <EventAppearanceCanvas
        event={previewEvent}
        theme={coastalTheme}
        sourceFor={(slot) => managerEventCoverSlotPath(previewEvent.id, slot)}
        summary={<p data-testid="cover-summary">Cover summary</p>}
        controls={<button type="button">Canvas control</button>}
      />
    </>);

    const preview = screen.getByTestId('event-appearance-canvas');
    const figure = container.querySelector('figure.event-appearance-canvas');
    expect(figure).not.toBeNull();
    expect(figure?.firstElementChild).toMatchObject({
      tagName: 'FIGCAPTION',
      textContent: 'What guests see',
    });
    expect(preview).not.toHaveAttribute('role', 'img');
    expect(preview).not.toContainElement(screen.getByTestId('cover-summary'));
    expect(preview).not.toContainElement(screen.getByRole('button', { name: 'Canvas control' }));
    expect(preview.compareDocumentPosition(screen.getByTestId('cover-summary')))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByTestId('cover-summary').compareDocumentPosition(
      screen.getByRole('button', { name: 'Canvas control' }),
    )).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(preview.style.getPropertyValue('--event-page')).toBe('#edf7f5');
    expect(preview.style.getPropertyValue('--event-primary')).toBe('#0c6370');
    expect(inlineEventProperties(preview)).toEqual(Object.values(EVENT_THEME_CSS_PROPERTIES).sort());
    expect(document.documentElement.style.getPropertyValue('--event-page')).toBe('');
    expect(screen.getByTestId('manager-chrome').style.getPropertyValue('--event-page')).toBe('');
    expect(preview).toHaveTextContent('Maya & Theo');
    expect(preview).toHaveTextContent('Sep 19');
    expect(preview).toHaveTextContent('Come share the moments you caught.');
    expect(preview).toHaveTextContent('Add photos');
    expect(preview).toHaveTextContent('View gallery');
    expect(preview.querySelectorAll('button, a, input, textarea, select, [role="button"], h1, h2, h3, h4, h5, h6')).toHaveLength(0);
    expect(container.querySelector('figcaption')).toHaveTextContent('What guests see');
    expect(preview.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('uses the authoritative revisioned manager slots and reports final fallback once', async () => {
    installMeasuredCover();
    const sourceFor = vi.fn((slot) => managerEventCoverSlotPath(previewEvent.id, slot));
    const unavailable = vi.fn();
    const refresh = vi.fn();
    const { container } = render(<EventAppearanceCanvas
      event={previewEvent}
      theme={coastalTheme}
      sourceFor={sourceFor}
      onCoverUnavailable={unavailable}
      onRefreshCoverEvent={refresh}
    />);

    const image = await waitFor(() => container.querySelector<HTMLImageElement>('.responsive-cover__image')!);
    expect(image.src).toContain('/api/manage/events/event-a/cover/1/framed-default/1x.jpeg');
    expect(sourceFor).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }));

    fireEvent.error(image);
    expect(container.querySelector('source[type="image/webp"]')).toBeNull();
    fireEvent.error(container.querySelector<HTMLImageElement>('.responsive-cover__image')!);
    expect(unavailable).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(container.querySelector('.responsive-cover__image')).toBeNull();
  });

  it('renders local draft and preset intent without authoritative recovery callbacks', async () => {
    const unavailable = vi.fn();
    const refresh = vi.fn();
    const sourceFor = vi.fn((slot) => managerEventCoverSlotPath(previewEvent.id, slot));
    const view = render(<EventAppearanceCanvas
      event={previewEvent}
      theme={coastalTheme}
      sourceFor={sourceFor}
      preview={{ kind: 'draft', url: 'blob:draft', focus: { x: 0.2, y: 0.7, zoom: 1.25 } }}
      onCoverUnavailable={unavailable}
      onRefreshCoverEvent={refresh}
    />);
    const draftImage = view.container.querySelector<HTMLImageElement>('.responsive-cover__image')!;
    expect(draftImage).toHaveAttribute('src', 'blob:draft');
    expect(draftImage).toHaveStyle({ objectPosition: '20% 70%', transform: 'scale(1.25)' });
    fireEvent.error(draftImage);
    expect(sourceFor).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    installMeasuredCover();
    view.rerender(<EventAppearanceCanvas
      event={previewEvent}
      theme={coastalTheme}
      sourceFor={sourceFor}
      preview={{ kind: 'preset', presetId: 'coastal-haze', effect: 'film', assetVersion: 1 }}
      onCoverUnavailable={unavailable}
      onRefreshCoverEvent={refresh}
    />);
    await waitFor(() => expect(view.container.querySelector<HTMLImageElement>('.responsive-cover__image')?.getAttribute('src'))
      .toContain(presetCoverAssetPath(1, 'coastal-haze', 'film', 'framed-default', '1x', 'jpeg')));
    expect(sourceFor).not.toHaveBeenCalled();
  });

  it('emits one sanitized observation per audience tuple', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(emitCoverUnavailable({ audience: 'manager', profile: 'framed-default', revision: 991 })).toBe(true);
    expect(emitCoverUnavailable({ audience: 'manager', profile: 'framed-default', revision: 991 })).toBe(false);
    expect(emitCoverUnavailable({ audience: 'guest', profile: 'framed-default', revision: 991 })).toBe(true);
    expect(emitCoverUnavailable({ audience: 'guest', profile: 'framed-default', revision: 991 })).toBe(false);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenNthCalledWith(1, 'cover_unavailable', {
      audience: 'manager',
      profile: 'framed-default',
      revision: 991,
    });
    expect(warning).toHaveBeenNthCalledWith(2, 'cover_unavailable', {
      audience: 'guest',
      profile: 'framed-default',
      revision: 991,
    });
  });

  it('encodes guest and manager cover identifiers into only their authorized paths', () => {
    const slot = {
      revision: 7,
      profile: 'compact-expanded' as const,
      density: '2x' as const,
      format: 'webp' as const,
    };
    expect(guestEventCoverSlotPath('maya/theo?', slot))
      .toBe('/api/event/maya%2Ftheo%3F/cover/7/compact-expanded/2x.webp');
    expect(managerEventCoverSlotPath('event/a?', slot))
      .toBe('/api/manage/events/event%2Fa%3F/cover/7/compact-expanded/2x.webp');
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
    expect(declaration('.responsive-cover__scrim', 'background'))
      .toContain('var(--event-cover-overlay-top)');
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
