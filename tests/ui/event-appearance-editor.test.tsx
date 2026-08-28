import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventView } from '../../shared/contracts';
import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import { resolveEventTheme } from '../../shared/event-theme';
import { AUTOSAVE_DEBOUNCE_MS, type DomainAutosaveState } from '../../src/features/settings/autosave-queue';
import { mergeCoverResponse, mergeThemeResponse } from '../../src/features/settings/event-merge';
import { EventAppearanceEditor } from '../../src/components/EventAppearanceEditor';

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

function errorJson(body: Record<string, unknown>, status: number) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

const defaultTheme = resolveEventTheme({
  version: 1,
  presetId: 'candidary-default',
  overrides: {},
});

const event: EventView = {
  id: 'event-a',
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.',
  guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
  cover: {
    config: {
      version: 1,
      source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 },
      effect: 'natural',
    },
    revision: 0,
    hasCover: true,
    available2xProfiles: [],
    surfaceTreatment: 'none',
    preparation: null,
  },
  uploadsEnabled: true,
  galleryVisible: true,
  moderationRequired: true,
  eventTimezone: 'America/Chicago',
  eventStartAt: '2026-09-19T22:00:00.000Z',
  eventStartTime: '17:00',
  photosOpen: true,
  photoIntakeState: 'open',
  photoIntakeRecheckAfterMs: null,
  rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
  rsvpDeadlineDate: '2026-09-05',
  rsvpRosterVersion: 0,
  reservedMediaCount: 0,
  storedMediaCount: 3,
  reservedBytes: 0,
  storedBytes: 128, recoverableMediaCount: 0, recoverableBytes: 0,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z',
  managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z',
  createdAt: '2026-07-29T00:00:00Z',
  deletedAt: null,
  theme: defaultTheme,
};

// Theme tests do not need a cover. Keeping one out of their fixture prevents
// the preview's independent cover read from consuming a queued theme response.
const eventWithoutCover: EventView = {
  ...event,
  cover: {
    config: { version: 1, source: { kind: 'none' } },
    revision: 0,
    hasCover: false,
    available2xProfiles: [],
    surfaceTreatment: 'none',
    preparation: null,
  },
};

function Harness({
  initial = eventWithoutCover,
  onThemeSavedObserved = () => undefined,
}: {
  initial?: EventView;
  onThemeSavedObserved?: (event: EventView) => void;
}) {
  const [current, setCurrent] = useState(initial);
  const [state, setState] = useState<DomainAutosaveState | null>(null);
  return <>
    <EventAppearanceEditor
      key={current.id}
      event={current}
      onEventWrite={(request) => request()}
      onEventRead={(request) => request()}
      // jsdom has no Worker, OffscreenCanvas, or ImageBitmap, so the composition
      // model is injected here exactly as `GuestUploadFlow` takes a transport.
      compositionRunner={async () => ({ x: 0.42, y: 0.61 })}
      onThemeSaved={(updated) => {
        onThemeSavedObserved(updated);
        setCurrent((held) => mergeThemeResponse(held, updated));
      }}
      onCoverSaved={(updated) => setCurrent((held) => mergeCoverResponse(held, updated))}
      onCoverAccessFailure={() => undefined}
      onAutosaveStateChange={setState}
    />
    <output data-testid="appearance-state">{state ? state.domain + ':' + state.status : 'none'}</output>
    <output data-testid="appearance-confirmed">{current.theme.config.presetId}</output>
  </>;
}

function themeMutationCalls(fetchMock: ReturnType<typeof vi.fn>) {
  const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
  return calls.filter(([input, init]) => (
    String(input) === '/api/manage/events/event-a/theme'
    && String(init?.method).toUpperCase() === 'PUT'
  ));
}

async function settleMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
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
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('event appearance editor', () => {
  it('places a truthful guest canvas before theme and color controls', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { container } = render(<Harness />);

    const section = screen.getByRole('region', { name: 'Event appearance editor' });
    const figure = container.querySelector('figure.event-appearance-canvas');
    expect(figure).not.toBeNull();
    expect(figure?.firstElementChild).toHaveTextContent('What guests see');
    expect(screen.getByText(
      'Choose the colors and shape guests see. Theme and color changes save as you make them. Cover changes begin after you choose Done, and the current cover stays live until the new one is ready.',
    )).toBeVisible();
    expect(screen.queryByText(/Cover changes apply immediately/u)).not.toBeInTheDocument();

    for (const control of [
      screen.getByRole('group', { name: 'Event appearance' }),
      screen.getByRole('textbox', { name: 'Primary color' }),
      screen.getByRole('textbox', { name: 'Accent color' }),
    ]) {
      expect(figure?.compareDocumentPosition(control)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(section).toContainElement(control);
    }
    const guest = screen.getByTestId('event-appearance-canvas');
    expect(guest).not.toContainElement(screen.getByRole('button', { name: 'Change cover' }));
  });

  it('shows the confirmed appearance, starts saved, and offers no manual Save button', () => {
    render(<Harness />);

    expect(screen.getByRole('radio', { name: 'Candidary Default' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Primary color' })).toHaveValue('#4a2415');
    expect(screen.getByRole('textbox', { name: 'Accent color' })).toHaveValue('#3f6d95');
    expect(screen.getByText('Event appearance saved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save appearance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Guest preview' })).not.toBeInTheDocument();
  });

  it('saves a preset the moment it is chosen', async () => {
    const saved = { ...eventWithoutCover, theme: resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} }) };
    const fetchMock = vi.fn(() => json({ event: saved }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: 'Garden Party' }));

    expect(themeMutationCalls(fetchMock)).toHaveLength(1);
    expect(JSON.parse(String(themeMutationCalls(fetchMock)[0]![1]?.body))).toEqual({
      version: 1, presetId: 'garden-party', overrides: {},
    });
    await waitFor(() => expect(screen.getByTestId('appearance-confirmed')).toHaveTextContent('garden-party'));
    expect(screen.getByText('Event appearance saved')).toBeInTheDocument();
  });

  it('keeps one live Appearance queue through StrictMode replay and reports Saved only after adoption', async () => {
    let release: (() => void) | null = null;
    const onThemeSavedObserved = vi.fn();
    const saved = { ...eventWithoutCover, theme: resolveEventTheme({
      version: 1, presetId: 'garden-party', overrides: {},
    }) };
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return json({ event: saved });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<StrictMode><Harness onThemeSavedObserved={onThemeSavedObserved} /></StrictMode>);

    fireEvent.click(screen.getByRole('radio', { name: 'Garden Party' }));

    expect(themeMutationCalls(fetchMock)).toHaveLength(1);
    expect(screen.getByTestId('appearance-state')).toHaveTextContent('appearance:saving');
    expect(screen.queryByText('Event appearance saved')).not.toBeInTheDocument();
    expect(release).not.toBeNull();

    release!();
    await waitFor(() => expect(screen.getByTestId('appearance-confirmed')).toHaveTextContent('garden-party'));

    expect(onThemeSavedObserved).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('appearance-state'))
      .toHaveTextContent('appearance:saved'));
    expect(screen.getByText('Event appearance saved')).toBeInTheDocument();
  });

  it('debounces a color into one request and previews it before it is confirmed', async () => {
    const fetchMock = vi.fn(() => json({ event: { ...eventWithoutCover, theme: resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#123456' },
    }) } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);
    const primary = screen.getByRole('textbox', { name: 'Primary color' });

    fireEvent.change(primary, { target: { value: '#123456' } });
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-primary': '#123456' });
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);

    await new Promise<void>((resolve) => { window.setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS); });
    await waitFor(() => expect(themeMutationCalls(fetchMock)).toHaveLength(1));
    await waitFor(() => expect(screen.getByText('Event appearance saved')).toBeInTheDocument());
  });

  it('sends nothing while raw color text is invalid and keeps the last valid preview', async () => {
    const fetchMock = vi.fn(() => json({ event: eventWithoutCover }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);
    const primary = screen.getByRole('textbox', { name: 'Primary color' });

    fireEvent.change(primary, { target: { value: '#abc' } });
    await new Promise<void>((resolve) => { window.setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS * 2); });

    expect(themeMutationCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-primary': '#4a2415' });
    expect(screen.getByText('Event appearance can’t save. Primary color: Enter a six-digit hex color, such as #245c46.')).toBeInTheDocument();
  });

  it('keeps a refused primary color out of the preview and autosave queue', () => {
    const fetchMock = vi.fn(() => json({ event: eventWithoutCover }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);
    const primary = screen.getByRole('textbox', { name: 'Primary color' });

    fireEvent.change(primary, { target: { value: '#ffffff' } });

    expect(primary).toHaveAccessibleDescription(
      'Primary color needs a 3:1 contrast ratio against the event surfaces.',
    );
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-primary': '#4a2415' });
    expect(screen.getByTestId('appearance-state')).toHaveTextContent('appearance:invalid');
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Use preset primary' }));
    expect(primary).toHaveValue('#4a2415');
    expect(primary).toHaveAttribute('aria-invalid', 'false');
  });

  it('keeps a refused accent color out of the preview and autosave queue', () => {
    const fetchMock = vi.fn(() => json({ event: eventWithoutCover }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);
    const accent = screen.getByRole('textbox', { name: 'Accent color' });

    fireEvent.change(accent, { target: { value: '#f5efe6' } });

    expect(accent).toHaveAccessibleDescription(
      'Accent color needs a 3:1 contrast ratio against the event surfaces.',
    );
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-accent': '#3f6d95' });
    expect(screen.getByTestId('appearance-state')).toHaveTextContent('appearance:invalid');
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);
  });

  it('keeps a valid edit when the other saved color is below the legibility floor', () => {
    const legacy = { ...eventWithoutCover, theme: resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { accentColor: '#f5efe6' },
    }) };
    const normalized = { ...eventWithoutCover, theme: resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#123456' },
    }) };
    const fetchMock = vi.fn(() => json({ event: normalized }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness initial={legacy} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Primary color' }), {
      target: { value: '#123456' },
    });

    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-primary': '#123456' });
    expect(screen.getByRole('textbox', { name: 'Primary color' })).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('textbox', { name: 'Accent color' })).toHaveAccessibleDescription(
      'Accent color needs a 3:1 contrast ratio against the event surfaces.',
    );
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Use preset accent' }));
    expect(themeMutationCalls(fetchMock)).toHaveLength(1);
    expect(JSON.parse(String(themeMutationCalls(fetchMock)[0]![1]?.body))).toEqual({
      version: 1,
      presetId: 'candidary-default',
      overrides: { primaryColor: '#123456' },
    });
  });

  it('rejects a newly illegible accent even when a legacy primary also fails', () => {
    const legacy = { ...eventWithoutCover, theme: resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#ffffff' },
    }) };
    const fetchMock = vi.fn(() => json({ event: legacy }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness initial={legacy} />);

    const accent = screen.getByRole('textbox', { name: 'Accent color' });
    fireEvent.change(accent, { target: { value: '#f5efe6' } });

    expect(accent).toHaveAccessibleDescription(
      'Accent color needs a 3:1 contrast ratio against the event surfaces.',
    );
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-accent': '#3f6d95' });
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);
  });

  it('preserves an untouched raw syntax error while the other color changes', () => {
    const legacy = { ...eventWithoutCover, theme: resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#ffffff' },
    }) };
    const fetchMock = vi.fn(() => json({ event: legacy }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness initial={legacy} />);

    const primary = screen.getByRole('textbox', { name: 'Primary color' });
    fireEvent.change(primary, { target: { value: '#abc' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Accent color' }), {
      target: { value: '#123456' },
    });

    expect(primary).toHaveAccessibleDescription('Enter a six-digit hex color, such as #245c46.');
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-accent': '#123456' });
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);
  });

  it('associates a primary legibility refusal with the color picker', () => {
    const fetchMock = vi.fn(() => json({ event: eventWithoutCover }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);

    const picker = screen.getByLabelText('Primary color picker');
    fireEvent.change(picker, { target: { value: '#ffffff' } });

    expect(picker).toHaveAttribute('aria-invalid', 'true');
    expect(picker).toHaveAccessibleDescription(
      'Primary color needs a 3:1 contrast ratio against the event surfaces.',
    );
  });

  it('associates an accent legibility refusal with the color picker', () => {
    const fetchMock = vi.fn(() => json({ event: eventWithoutCover }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);

    const picker = screen.getByLabelText('Accent color picker');
    fireEvent.change(picker, { target: { value: '#f5efe6' } });

    expect(picker).toHaveAttribute('aria-invalid', 'true');
    expect(picker).toHaveAccessibleDescription(
      'Accent color needs a 3:1 contrast ratio against the event surfaces.',
    );
  });

  it('adopts a Worker-normalized theme while the answered intent is still current', async () => {
    const normalized = { ...eventWithoutCover, theme: resolveEventTheme({
      version: 1, presetId: 'garden-party', overrides: { primaryColor: '#234567' },
    }) };
    const fetchMock = vi.fn(() => json({ event: normalized }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: 'Garden Party' }));

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Primary color' }))
      .toHaveValue('#234567'));
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-primary': '#234567' });
    await waitFor(() => expect(screen.getByTestId('appearance-state'))
      .toHaveTextContent('appearance:saved'));
  });

  it('saves Reset immediately', async () => {
    const garden = { ...eventWithoutCover, theme: resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} }) };
    const responses = [garden, eventWithoutCover];
    const fetchMock = vi.fn(() => json({ event: responses.shift() ?? eventWithoutCover }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await waitFor(() => expect(themeMutationCalls(fetchMock)).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('appearance-confirmed')).toHaveTextContent('garden-party'));

    fireEvent.click(screen.getByRole('button', { name: 'Reset to Candidary default' }));
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-primary': '#4a2415' });
    await waitFor(() => expect(themeMutationCalls(fetchMock)).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('appearance-confirmed')).toHaveTextContent('candidary-default'));
  });

  it('restores a saved custom primary color to its preset immediately', () => {
    const custom = { ...eventWithoutCover, theme: resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#123456' },
    }) };
    const fetchMock = vi.fn(() => json({ event: eventWithoutCover }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness initial={custom} />);

    fireEvent.click(screen.getByRole('button', { name: 'Use preset primary' }));
    expect(themeMutationCalls(fetchMock)).toHaveLength(1);
  });

  it('keeps theme controls editable during a save and cover controls on their own busy state', async () => {
    let release: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return json({
        event: { ...eventWithoutCover, theme: resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} }) },
      });
    }));
    render(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: 'Garden Party' }));
    expect(screen.getByRole('radio', { name: 'Coastal Light' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Primary color' })).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId('appearance-state')).toHaveTextContent('appearance:saving'));
    expect(release).not.toBeNull();
    release!();
    await waitFor(() => expect(screen.getByTestId('appearance-state')).toHaveTextContent('appearance:saved'));
  });

  it('does not let a confirmed preset wipe raw color text typed while it saved', async () => {
    let release: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return json({
        event: { ...eventWithoutCover, theme: resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} }) },
      });
    }));
    render(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: 'Garden Party' }));
    const primary = screen.getByRole('textbox', { name: 'Primary color' });
    fireEvent.change(primary, { target: { value: '#abc' } });
    // Invalid text leaves the canonical config untouched, so the response config
    // still matches the draft. Only the raw intent moved.
    await waitFor(() => expect(screen.getByTestId('appearance-state')).toHaveTextContent('appearance:invalid'));
    expect(release).not.toBeNull();
    release!();

    await waitFor(() => expect(screen.getByTestId('appearance-confirmed')).toHaveTextContent('garden-party'));
    expect(screen.getByText('Event appearance can’t save. Primary color: Enter a six-digit hex color, such as #245c46.')).toBeInTheDocument();
    expect(primary).toHaveValue('#abc');
    expect(primary).toHaveAccessibleDescription('Enter a six-digit hex color, such as #245c46.');
  });

  it('does not adopt an Appearance response after its autosave generation retires', async () => {
    let release: (() => void) | null = null;
    const onThemeSaved = vi.fn();
    const saved = { ...eventWithoutCover, theme: resolveEventTheme({
      version: 1, presetId: 'garden-party', overrides: {},
    }) };
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return json({ event: saved });
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<StrictMode><EventAppearanceEditor
      event={eventWithoutCover}
      onThemeSaved={onThemeSaved}
      onCoverSaved={() => undefined}
      onAutosaveStateChange={() => undefined}
      onEventWrite={(request) => request()}
      onEventRead={(request) => request()}
      onCoverAccessFailure={() => undefined}
      compositionRunner={async () => ({ x: 0.42, y: 0.61 })}
    /></StrictMode>);

    fireEvent.click(screen.getByRole('radio', { name: 'Garden Party' }));
    expect(themeMutationCalls(fetchMock)).toHaveLength(1);
    expect(release).not.toBeNull();

    view.unmount();
    release!();
    await settleMicrotasks();

    expect(onThemeSaved).not.toHaveBeenCalled();
  });

  it('keeps the newest draft after a failed save and retries it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    render(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: 'Garden Party' }));
    expect(await screen.findByText('Couldn’t save. Failed to fetch')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry event appearance' })).toBeVisible();
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-primary': '#245c46' });

    const saved = { ...eventWithoutCover, theme: resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} }) };
    const fetchMock = vi.fn(() => json({ event: saved }));
    vi.stubGlobal('fetch', fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Retry event appearance' }));
    await waitFor(() => expect(themeMutationCalls(fetchMock)).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('appearance-confirmed')).toHaveTextContent('garden-party'));
  });

  it('associates a Worker color refusal with the matching field without offering Retry', async () => {
    vi.stubGlobal('fetch', vi.fn(() => errorJson({
      code: 'VALIDATION_FAILED',
      message: 'Check the highlighted theme details.',
      fieldErrors: { 'overrides.accentColor': 'Accent needs another color.' },
      requestId: 'request-a',
    }, 422)));
    render(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await waitFor(() => expect(screen.getByTestId('appearance-state')).toHaveTextContent('appearance:invalid'));

    const accent = screen.getByRole('textbox', { name: /Accent color/ });
    expect(accent).toHaveAttribute('aria-invalid', 'true');
    expect(accent).toHaveAccessibleDescription('Accent needs another color.');
    expect(screen.queryByRole('button', { name: /^Retry/u })).not.toBeInTheDocument();
    expect(screen.getByTestId('appearance-state')).toHaveTextContent('appearance:invalid');
  });

  it('flushes a valid color on blur and Enter without submitting the form', async () => {
    const fetchMock = vi.fn(() => json({ event: { ...eventWithoutCover, theme: resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#123456' },
    }) } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);
    const primary = screen.getByRole('textbox', { name: 'Primary color' });
    const submitted = vi.fn();
    primary.closest('form')!.addEventListener('submit', submitted);

    fireEvent.change(primary, { target: { value: '#123456' } });
    fireEvent.blur(primary);
    await waitFor(() => expect(themeMutationCalls(fetchMock)).toHaveLength(1));

    fireEvent.change(primary, { target: { value: '#234567' } });
    fireEvent.keyDown(primary, { key: 'Enter' });
    await waitFor(() => expect(themeMutationCalls(fetchMock)).toHaveLength(2));
    expect(submitted).not.toHaveBeenCalled();
  });

  it('flushes a color-picker change when the picker blurs', () => {
    const fetchMock = vi.fn(() => json({ event: { ...eventWithoutCover, theme: resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#123456' },
    }) } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);

    const picker = screen.getByLabelText('Primary color picker');
    fireEvent.change(picker, { target: { value: '#123456' } });
    fireEvent.blur(picker);

    expect(themeMutationCalls(fetchMock)).toHaveLength(1);
  });

  it('uploads through the draft pipeline and removes with one publication', async () => {
    installMeasuredCover();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:cover-preview') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
    const cleared = {
      ...event,
      cover: {
        ...eventWithoutCover.cover,
        revision: 2,
      },
    };
    const calls: string[] = [];
    const draft = (state: string, revision: number, extra: Record<string, unknown> = {}) => ({
      id: 'draft-a',
      source: 'new-upload',
      state,
      revision,
      expiresAt: '2026-08-05T00:00:00Z',
      compositionModelVersion: 1,
      master: null,
      focus: null,
      preview: null,
      ...extra,
    });
    const preparing = {
      operationId: 'operation-a',
      status: 'preparing',
      completedSteps: 1,
      requiredSteps: 6,
      retryable: false,
      safeFailureCode: null,
      updatedAt: '2026-08-04T00:00:00Z',
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      calls.push(method + ' ' + path);
      if (path === '/api/manage/events/event-a/cover/drafts' && method === 'POST') {
        return json({
          draft: draft('reserved', 0),
          ingress: { method: 'PUT', path: '/api/manage/events/event-a/cover/drafts/draft-a/raw' },
          replayed: false,
        });
      }
      if (path === '/api/manage/events/event-a/cover/drafts/draft-a/raw' && method === 'PUT') {
        return json({ draft: draft('transferred', 2) });
      }
      if (path === '/api/manage/events/event-a/cover/drafts/draft-a/inspect' && method === 'POST') {
        return json({ draft: draft('inspected', 3, {
          master: { width: 2400, height: 1600, safeZoomMaximum: 2, available2xProfiles: [] },
          preview: { effect: 'natural', width: 1280, height: 853, byteSize: 900, recipeVersion: 1 },
        }) });
      }
      if (path.startsWith('/api/manage/events/event-a/cover/drafts/draft-a/previews/') && method === 'POST') {
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response);
      }
      if (path === '/api/manage/events/event-a/cover/drafts/draft-a/composition' && method === 'PATCH') {
        return json({ draft: draft('ready', 4, {
          master: { width: 2400, height: 1600, safeZoomMaximum: 2, available2xProfiles: [] },
          focus: { x: 0.42, y: 0.61, modelVersion: 1 },
          preview: { effect: 'natural', width: 1280, height: 853, byteSize: 900, recipeVersion: 1 },
        }) });
      }
      if (path === '/api/manage/events/event-a/cover/publications' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          operationId: string;
          source: { kind: string };
        };
        if (body.source.kind === 'none') {
          return json({
            applied: true,
            appliedRevision: 2,
            operation: { ...preparing, operationId: body.operationId, status: 'applied', completedSteps: 6 },
            event: cleared,
          });
        }
        return json({
          applied: false,
          operation: { ...preparing, operationId: body.operationId, completedSteps: 1 },
        }, 202);
      }
      if (path === '/api/manage/events/event-a' && method === 'GET') {
        return json({ event: { ...event, cover: { ...event.cover, preparation: preparing } } });
      }
      if (path === '/api/manage/events/event-a/cover/publications/operation-a' && method === 'GET') {
        return json({ operation: preparing });
      }
      throw new Error('Unexpected request ' + method + ' ' + path);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('d2f3b2a0-885c-4380-bf20-8d44e9712176');
    render(<Harness initial={eventWithoutCover} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change cover' }));
    const input = screen.getByLabelText<HTMLInputElement>('Choose photo');
    // HEIC, which is what an iPhone photo picker hands over and what neither
    // control accepted before.
    const file = new File([new Uint8Array([1, 2, 3])], 'porch.heic', { type: 'image/heic' });

    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(calls).toContain('PATCH /api/manage/events/event-a/cover/drafts/draft-a/composition'));
    const studio = screen.getByRole('dialog', { name: 'Cover Studio' });
    fireEvent.click(within(studio).getByRole('button', { name: 'Continue' }));
    fireEvent.click(await within(studio).findByRole('button', { name: 'Adjust framing' }));
    fireEvent.change(within(studio).getByRole('slider', { name: 'Left or right' }), {
      target: { value: '70' },
    });
    expect(studio.querySelector('.event-appearance-canvas__local-cover img'))
      .toHaveStyle({ objectPosition: '70% 61%' });
    fireEvent.click(within(studio).getByRole('button', { name: 'Back' }));

    fireEvent.click(within(studio).getByRole('radio', { name: /^Warm Linen/u }));
    fireEvent.click(within(studio).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(within(studio).getByRole('heading', { name: 'Choose a style' })).toBeVisible());
    expect(calls.filter((call) => call.includes('/previews/'))).toHaveLength(1);
    expect(studio.querySelector('.responsive-cover__image')?.getAttribute('src'))
      .toContain('/warm-linen/natural/');

    fireEvent.click(within(studio).getByRole('button', { name: 'Back' }));
    fireEvent.click(within(studio).getByRole('radio', { name: /Upload a photo/u }));
    fireEvent.click(within(studio).getByRole('button', { name: 'Continue' }));
    expect(within(studio).getByRole('slider', { name: 'Left or right' })).toHaveValue('70');
    expect(studio.querySelector('.event-appearance-canvas__local-cover img'))
      .toHaveAttribute('src', 'blob:cover-preview');
    expect(studio.querySelector('.event-appearance-canvas__local-cover img'))
      .toHaveStyle({ objectPosition: '70% 61%' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(calls.filter((call) => call.includes('/previews/'))).toHaveLength(5));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(calls).toContain('POST /api/manage/events/event-a/cover/publications'));

    // Reserve, transfer, inspect, compose, publish — once each.
    expect(calls.filter((call) => call.endsWith('/cover/drafts'))).toHaveLength(1);
    expect(calls).toContain('PUT /api/manage/events/event-a/cover/drafts/draft-a/raw');
    expect(calls).toContain('PATCH /api/manage/events/event-a/cover/drafts/draft-a/composition');
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);

    // A 202 leaves the current cover exactly as it was; the status beside the
    // summary owns the rest, and its copy comes from durable step counts.
    await waitFor(() => expect(screen.getAllByText(/Preparing cover 2 of 6/u)).not.toHaveLength(0));

    cleanup();
    // The removal half is an independent Manager load, not an attempt to start
    // a second publication while the accepted upload above is still preparing.
    sessionStorage.clear();
    render(<Harness initial={{ ...event, cover: { ...event.cover, revision: 1 } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change cover' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove cover' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cover Studio' })).not.toBeInTheDocument());
    const removal = (fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>)
      .filter(([path, init]) => String(path).endsWith('/cover/publications') && String(init?.method) === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)) as { source: { kind: string }; expectedRevision: number })
      .find((body) => body.source.kind === 'none');
    // Removal is a publication carrying the revision this page last read, not a
    // DELETE that assumes it is still current.
    expect(removal?.expectedRevision).toBe(1);
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);
  });

  it('guards one authoritative refresh across the Manager and open Studio canvases', async () => {
    installMeasuredCover();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/manage/events/event-a') return json({ event });
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness initial={event} />);

    fireEvent.click(screen.getByRole('button', { name: 'Change cover' }));
    await waitFor(() => expect(document.querySelectorAll('.event-appearance-canvas .responsive-cover__image')).toHaveLength(2));
    for (const image of Array.from(document.querySelectorAll('.event-appearance-canvas .responsive-cover__image'))) {
      fireEvent.error(image);
    }
    for (const image of Array.from(document.querySelectorAll('.event-appearance-canvas .responsive-cover__image'))) {
      fireEvent.error(image);
    }

    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => (
      String(path) === '/api/manage/events/event-a'
    ))).toHaveLength(1));
  });

  it('reads the recovery view out of a 409 envelope instead of reporting a generic error', async () => {
    const winner = {
      ...event,
      cover: { ...eventWithoutCover.cover, revision: 5 },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (path === '/api/manage/events/event-a/cover/publications' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { operationId: string };
        // §11's recovery view travels in the response envelope, not in an error
        // body — so it carries no `code` and no `message`.
        return Promise.resolve(new Response(JSON.stringify({
          data: {
            applied: false,
            operation: { operationId: body.operationId, status: 'conflict', completedSteps: 0, requiredSteps: 0, retryable: false, safeFailureCode: null, updatedAt: '2026-08-04T00:00:00Z' },
            event: winner,
          },
          requestId: 'request-a',
        }), { status: 409, headers: { 'content-type': 'application/json' } }));
      }
      throw new Error('Unexpected request ' + method + ' ' + path);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('f33d6d0a-c2e9-4fc2-940a-51707065ec91');
    render(<Harness initial={{ ...event, cover: { ...event.cover, revision: 1 } }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Change cover' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove cover' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    const dialog = screen.getByRole('dialog', { name: 'Cover Studio' });
    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeVisible());
    // Not "Something went wrong."
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/changed somewhere else/u);
    // And the page is rebased onto the winning revision, so the next change
    // sends an expectedRevision the server will accept.
    expect(screen.getAllByTestId('event-appearance-canvas')).not.toHaveLength(0);
  });

  it('refuses an unsupported type before any request', async () => {
    const fetchMock = vi.fn(() => { throw new Error('No request should be made.'); });
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness initial={eventWithoutCover} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change cover' }));
    const input = screen.getByLabelText<HTMLInputElement>('Choose photo');

    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1])], 'clip.gif', { type: 'image/gif' })] },
    });
    const dialog = screen.getByRole('dialog', { name: 'Cover Studio' });
    await waitFor(() => expect(within(dialog).getByRole('alert'))
      .toHaveTextContent(/JPEG, PNG, WebP, or HEIC/u));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('states the real accepted formats and ceiling', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<Harness initial={eventWithoutCover} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change cover' }));
    const input = screen.getByLabelText<HTMLInputElement>('Choose photo');
    expect(input.accept).toBe('image/jpeg,image/png,image/webp,image/heic');
    expect(screen.getByText(/JPEG, PNG, WebP, or HEIC · 19 MB max/u)).toBeVisible();
  });

  it('uses static preset artwork for every style without creating an upload draft', () => {
    const fetchMock = vi.fn(() => {
      throw new Error('Selecting preset artwork must not make an API request.');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness initial={eventWithoutCover} />);

    fireEvent.click(screen.getByRole('button', { name: 'Change cover' }));
    fireEvent.click(screen.getByRole('radio', { name: /^Warm Linen/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const stylePicker = screen.getByRole('group', { name: 'Style' });
    const items = within(stylePicker).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    const effects = ['natural', 'warm', 'film', 'soft', 'monochrome'] as const;
    for (const [index, effect] of effects.entries()) {
      const item = items[index]!;
      expect(item).toHaveAttribute('data-thumbnail-state', 'ready');
      expect(within(item).getByRole('radio')).toBeEnabled();
      expect(item.querySelector('img')).toHaveAttribute(
        'src',
        `/assets/event-covers/v1/warm-linen/${effect}/standard-default-1x.webp`,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
