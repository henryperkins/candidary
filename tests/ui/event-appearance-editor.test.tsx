import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
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
  coverObjectKey: 'events/event-a/cover/private-photo.jpg',
  uploadsEnabled: true,
  galleryVisible: true,
  moderationRequired: true,
  reservedMediaCount: 0,
  storedMediaCount: 3,
  reservedBytes: 0,
  storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z',
  managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z',
  createdAt: '2026-07-29T00:00:00Z',
  deletedAt: null,
  theme: defaultTheme,
};

function themeMutationCalls(fetchMock: ReturnType<typeof vi.fn>) {
  const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
  return calls.filter(([input, init]) => (
    String(input) === '/api/manage/events/event-a/theme'
    && String(init?.method).toUpperCase() === 'PUT'
  ));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('event appearance editor', () => {
  it('marks pristine invalid raw input as unsaved while preserving the saved draft', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
    const user = userEvent.setup();
    render(<EventAppearanceEditor event={event} onEventSaved={vi.fn()} />);

    expect(screen.getByText('Saved')).toBeVisible();
    const primary = screen.getByRole('textbox', { name: 'Primary color' });
    await user.clear(primary);
    await user.type(primary, '#abc');

    expect(primary).toHaveAccessibleDescription('Enter a six-digit hex color, such as #245c46.');
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#42103b' });
    expect(screen.getByRole('button', { name: 'Save appearance' })).toBeDisabled();
  });

  it('updates only the local preview when a preset is selected before Save', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<EventAppearanceEditor event={event} onEventSaved={vi.fn()} />);

    const preview = screen.getByTestId('event-appearance-preview');
    expect(preview).toHaveStyle({ '--event-primary': '#42103b' });

    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));

    expect(preview).toHaveStyle({
      '--event-primary': '#245c46',
      '--event-accent': '#c36f42',
    });
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/manage/events/event-a/cover')).toBe(true);
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);
  });

  it('keeps the last valid preview while reporting strict syntax and contrast errors', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))));
    const user = userEvent.setup();
    render(<EventAppearanceEditor event={event} onEventSaved={vi.fn()} />);

    const preview = screen.getByTestId('event-appearance-preview');
    const primary = screen.getByRole('textbox', { name: 'Primary color' });
    const accent = screen.getByRole('textbox', { name: 'Accent color' });

    await user.clear(primary);
    await user.type(primary, '#123456');
    await user.clear(accent);
    await user.type(accent, '#c85f50');
    expect(preview).toHaveStyle({
      '--event-primary': '#123456',
      '--event-accent': '#c85f50',
    });

    await user.clear(primary);
    await user.type(primary, '#abc');
    expect(primary).toHaveAttribute('aria-invalid', 'true');
    expect(primary).toHaveAccessibleDescription('Enter a six-digit hex color, such as #245c46.');
    expect(preview).toHaveStyle({ '--event-primary': '#123456' });
    expect(screen.getByRole('button', { name: 'Save appearance' })).toBeDisabled();

    await user.clear(primary);
    await user.type(primary, '#777777');
    expect(primary).toHaveAccessibleDescription('Primary color needs a 4.5:1 foreground contrast ratio.');
    expect(preview).toHaveStyle({ '--event-primary': '#123456' });

    await user.click(screen.getByRole('button', { name: 'Use preset primary' }));
    expect(primary).toHaveValue('#42103b');
    expect(accent).toHaveValue('#c85f50');
    expect(preview).toHaveStyle({
      '--event-primary': '#42103b',
      '--event-accent': '#c85f50',
    });

    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    expect(primary).toHaveValue('#245c46');
    expect(accent).toHaveValue('#c36f42');
    expect(preview).toHaveStyle({
      '--event-primary': '#245c46',
      '--event-accent': '#c36f42',
    });
  });

  it('resets locally, sends the canonical configuration, and adopts the normalized response', async () => {
    const normalizedTheme = resolveEventTheme({
      version: 1,
      presetId: 'garden-party',
      overrides: { primaryColor: '#234567' },
    });
    const normalizedEvent = { ...event, theme: normalizedTheme };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/cover')) return Promise.resolve(new Response(null, { status: 404 }));
      if (String(input).endsWith('/theme') && init?.method === 'PUT') return json({ event: normalizedEvent });
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onEventSaved = vi.fn();
    const user = userEvent.setup();
    render(<EventAppearanceEditor
      event={{ ...event, theme: resolveEventTheme({
        version: 1,
        presetId: 'coastal-light',
        overrides: { accentColor: '#b7693f' },
      }) }}
      onEventSaved={onEventSaved}
    />);

    const reset = screen.getByRole('button', { name: 'Reset to Candidary default' });
    expect(reset).toHaveAttribute('type', 'button');
    await user.click(reset);
    expect(screen.getByRole('radio', { name: 'Candidary Default' })).toBeChecked();
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);

    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    const primary = screen.getByRole('textbox', { name: 'Primary color' });
    await user.clear(primary);
    await user.type(primary, '#123456');
    await user.click(screen.getByRole('button', { name: 'Save appearance' }));

    await waitFor(() => expect(onEventSaved).toHaveBeenCalledWith(normalizedEvent));
    const [, request] = themeMutationCalls(fetchMock)[0]!;
    expect(request?.body).toBe('{"version":1,"presetId":"garden-party","overrides":{"primaryColor":"#123456"}}');
    expect(primary).toHaveValue('#234567');
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#234567' });
    expect(screen.getByText('Saved')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save appearance' })).toBeDisabled();
  });

  it('preserves the draft and position after a failed Save and permits a retry', async () => {
    let attempts = 0;
    const savedTheme = resolveEventTheme({
      version: 1,
      presetId: 'garden-party',
      overrides: { primaryColor: '#123456' },
    });
    const savedEvent = { ...event, theme: savedTheme };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/cover')) return Promise.resolve(new Response(null, { status: 404 }));
      if (String(input).endsWith('/theme') && init?.method === 'PUT') {
        attempts += 1;
        return attempts === 1
          ? errorJson({ code: 'INTERNAL_ERROR', message: 'Could not save appearance.', requestId: 'request-a' }, 500)
          : json({ event: savedEvent });
      }
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const scrollTo = vi.spyOn(window, 'scrollTo');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 640 });
    const user = userEvent.setup();
    render(<EventAppearanceEditor event={event} onEventSaved={vi.fn()} />);

    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    const primary = screen.getByRole('textbox', { name: 'Primary color' });
    await user.clear(primary);
    await user.type(primary, '#123456');
    const preview = screen.getByTestId('event-appearance-preview');
    const save = screen.getByRole('button', { name: 'Save appearance' });
    await user.click(save);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save appearance.');
    expect(primary).toHaveValue('#123456');
    expect(preview).toHaveStyle({ '--event-primary': '#123456' });
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    expect(save).toBeEnabled();
    expect(window.scrollY).toBe(640);
    expect(scrollTo).not.toHaveBeenCalled();

    await user.click(save);
    await waitFor(() => expect(themeMutationCalls(fetchMock)).toHaveLength(2));
    expect(screen.getByText('Saved')).toBeVisible();
  });

  it('disables Save with no change, invalid input, and an active request', async () => {
    let resolveSave!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveSave = resolve; });
    const savedEvent = {
      ...event,
      theme: resolveEventTheme({
        version: 1,
        presetId: 'garden-party',
        overrides: {},
      }),
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/cover')) return Promise.resolve(new Response(null, { status: 404 }));
      if (String(input).endsWith('/theme') && init?.method === 'PUT') return pending;
      throw new Error(`Unexpected request ${String(input)}`);
    }));
    const user = userEvent.setup();
    render(<EventAppearanceEditor event={event} onEventSaved={vi.fn()} />);

    const save = screen.getByRole('button', { name: 'Save appearance' });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    expect(save).toBeEnabled();

    const accent = screen.getByRole('textbox', { name: 'Accent color' });
    await user.clear(accent);
    await user.type(accent, 'orange');
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Use preset accent' }));
    expect(save).toBeEnabled();

    await user.click(save);
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent('Saving…');
    resolveSave(await json({ event: savedEvent }));
    await waitFor(() => expect(screen.getByText('Saved')).toBeVisible());
  });

  it('associates server field errors with the matching color input', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/cover')) return Promise.resolve(new Response(null, { status: 404 }));
      if (String(input).endsWith('/theme') && init?.method === 'PUT') {
        return errorJson({
          code: 'VALIDATION_FAILED',
          message: 'Check the highlighted theme details.',
          fieldErrors: { 'overrides.accentColor': 'Accent needs another color.' },
          requestId: 'request-a',
        }, 422);
      }
      throw new Error(`Unexpected request ${String(input)}`);
    }));
    const user = userEvent.setup();
    render(<EventAppearanceEditor event={event} onEventSaved={vi.fn()} />);

    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await user.click(screen.getByRole('button', { name: 'Save appearance' }));

    const editor = screen.getByRole('region', { name: 'Event appearance editor' });
    const accent = within(editor).getByRole('textbox', { name: 'Accent color' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the highlighted theme details.');
    expect(accent).toHaveAttribute('aria-invalid', 'true');
    expect(accent).toHaveAccessibleDescription('Accent needs another color.');
  });
});
