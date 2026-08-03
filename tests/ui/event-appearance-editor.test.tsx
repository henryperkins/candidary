import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import { AUTOSAVE_DEBOUNCE_MS, type DomainAutosaveState } from '../../src/features/settings/autosave-queue';
import { mergeCoverResponse, mergeThemeResponse } from '../../src/features/settings/event-merge';
import { EventAppearanceEditor } from '../../src/components/EventAppearanceEditor';

function json(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    json: async () => ({ data, requestId: 'request-a' }),
  } as Response);
}

function errorJson(body: Record<string, unknown>, status: number) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response);
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
  storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z',
  managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z',
  createdAt: '2026-07-29T00:00:00Z',
  deletedAt: null,
  theme: defaultTheme,
};

// Theme tests do not need a cover. Keeping one out of their fixture prevents
// the preview's independent cover read from consuming a queued theme response.
const eventWithoutCover: EventView = { ...event, coverObjectKey: null };

function Harness({ initial = eventWithoutCover }: { initial?: EventView }) {
  const [current, setCurrent] = useState(initial);
  const [state, setState] = useState<DomainAutosaveState | null>(null);
  return <>
    <EventAppearanceEditor
      key={current.id}
      event={current}
      onEventWrite={(request) => request()}
      onThemeSaved={(updated) => setCurrent((held) => mergeThemeResponse(held, updated))}
      onCoverSaved={(updated) => setCurrent((held) => mergeCoverResponse(held, updated))}
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('event appearance editor', () => {
  it('shows the confirmed appearance, starts saved, and offers no manual Save button', () => {
    render(<Harness />);

    expect(screen.getByRole('radio', { name: 'Candidary Default' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Primary color' })).toHaveValue('#4a2415');
    expect(screen.getByRole('textbox', { name: 'Accent color' })).toHaveValue('#3f6d95');
    expect(screen.getByText('Event appearance saved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save appearance' })).not.toBeInTheDocument();
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

  it('debounces a color into one request and previews it before it is confirmed', async () => {
    const fetchMock = vi.fn(() => json({ event: { ...eventWithoutCover, theme: resolveEventTheme({
      version: 1, presetId: 'candidary-default', overrides: { primaryColor: '#123456' },
    }) } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);
    const primary = screen.getByRole('textbox', { name: 'Primary color' });

    fireEvent.change(primary, { target: { value: '#123456' } });
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#123456' });
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
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#4a2415' });
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
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#4a2415' });
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
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-accent': '#3f6d95' });
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

    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#123456' });
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
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-accent': '#3f6d95' });
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
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-accent': '#123456' });
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
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#234567' });
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
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#4a2415' });
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

  it('keeps the newest draft after a failed save and retries it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    render(<Harness />);

    fireEvent.click(screen.getByRole('radio', { name: 'Garden Party' }));
    expect(await screen.findByText('Couldn’t save. Failed to fetch')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry event appearance' })).toBeVisible();
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#245c46' });

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

  it('uploads and removes a cover immediately without creating a theme write', async () => {
    const covered = { ...event, coverObjectKey: 'events/event-a/cover/new.png' };
    const cleared = { ...event, coverObjectKey: null };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (path === '/api/manage/events/event-a/cover' && method === 'POST') {
        return json({ objectKey: 'events/event-a/cover/new.png', url: 'https://upload.test/cover' });
      }
      if (path === 'https://upload.test/cover' && method === 'PUT') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (path === '/api/manage/events/event-a/cover/finalize' && method === 'POST') {
        return json({ event: covered });
      }
      if (path === '/api/manage/events/event-a/cover' && method === 'DELETE') {
        return json({ event: cleared });
      }
      throw new Error('Unexpected request ' + method + ' ' + path);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness />);
    const input = document.querySelector<HTMLInputElement>('.cover-field__input')!;
    const file = new File([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' });

    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove cover' })).toBeVisible());
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Remove cover' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove cover' })).not.toBeInTheDocument());
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);
  });
});
