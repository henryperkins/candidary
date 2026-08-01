import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import { AUTOSAVE_DEBOUNCE_MS, type DomainAutosaveState } from '../../src/features/settings/autosave-queue';
import { mergeSettingsResponse } from '../../src/features/settings/event-merge';
import { EventSettingsEditor } from '../../src/components/EventSettingsEditor';

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

function errorJson(body: Record<string, unknown>, status: number) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

const EVENT: EventView = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.', coverObjectKey: null,
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  reservedMediaCount: 0, storedMediaCount: 3, reservedBytes: 0, storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z', createdAt: '2026-07-29T00:00:00Z', deletedAt: null,
  eventTimezone: 'America/Chicago', rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-06T04:59:59.999Z', rsvpDeadlineDate: '2026-09-05',
  rsvpRosterVersion: 7,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
};

// The editor is controlled by the manager: a confirmed response goes up, is
// merged by ownership, and comes back down. Tests need that same loop.
function Harness({
  initial = EVENT,
  rosterVersion,
  synchronousResponses = false,
}: {
  initial?: EventView;
  rosterVersion?: number;
  synchronousResponses?: boolean;
}) {
  const [event, setEvent] = useState(initial);
  const [state, setState] = useState<DomainAutosaveState | null>(null);
  // rosterVersion stands in for an RSVP-destination mutation on the same page:
  // the manager pushes a new version down without remounting the editor.
  const applied = rosterVersion === undefined ? event : { ...event, rsvpRosterVersion: rosterVersion };
  return <>
    <EventSettingsEditor
      key={event.id}
      event={applied}
      onEventWrite={(request) => request()}
      onSettingsSaved={(updated) => {
        const applyResponse = () => setEvent((current) => mergeSettingsResponse(current, updated));
        if (synchronousResponses) flushSync(applyResponse);
        else applyResponse();
      }}
      onAutosaveStateChange={setState}
    />
    <output data-testid="domain-state">{state ? state.domain + ':' + state.status : 'none'}</output>
  </>;
}

function settingsWrites() {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
  return calls
    .filter(([input, init]) => String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

async function settleMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('event settings editor', () => {
  it('shows the confirmed values, offers no Save button, and starts saved', () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ event: EVENT })));
    render(<Harness />);

    expect(screen.getByLabelText('Event name')).toHaveValue('Maya & Theo');
    expect(screen.getByLabelText('Welcome message')).toHaveValue('Welcome.');
    expect(screen.getByLabelText('Event time zone')).toHaveValue('America/Chicago');
    expect(screen.getByLabelText('RSVP deadline')).toHaveValue('2026-09-05');
    expect(screen.getByLabelText('Accept RSVPs')).not.toBeChecked();
    expect(screen.getByLabelText('Accept private photo deliveries')).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
    expect(screen.getByText('Event settings saved')).toBeInTheDocument();
  });

  it('treats a legacy null deadline as a clean confirmed baseline', async () => {
    const legacyEvent = { ...EVENT, rsvpDeadlineAt: null, rsvpDeadlineDate: null };
    vi.stubGlobal('fetch', vi.fn(() => json({ event: legacyEvent })));
    render(<Harness initial={legacyEvent} />);

    await settleMicrotasks();

    expect(screen.getByLabelText(/^RSVP deadline/)).toHaveValue('');
    expect(screen.getByLabelText(/^RSVP deadline/)).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByTestId('domain-state')).toHaveTextContent('settings:saved');
    expect(settingsWrites()).toHaveLength(0);
  });

  it('requires a deadline before changing another setting on a legacy event', async () => {
    const legacyEvent = { ...EVENT, rsvpDeadlineAt: null, rsvpDeadlineDate: null };
    vi.stubGlobal('fetch', vi.fn(() => json({ event: legacyEvent })));
    render(<Harness initial={legacyEvent} />);

    fireEvent.click(screen.getByLabelText('Review notes before sharing'));
    await settleMicrotasks();

    expect(screen.getByLabelText(/^RSVP deadline/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('domain-state')).toHaveTextContent('settings:invalid');
    expect(settingsWrites()).toHaveLength(0);
  });

  it('saves a toggle immediately and sends the complete payload', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ event: { ...EVENT, galleryVisible: false } })));
    render(<Harness />);

    fireEvent.click(screen.getByLabelText('Show the optional shared gallery'));

    expect(settingsWrites()).toHaveLength(1);
    expect(settingsWrites()[0]).toEqual({
      name: 'Maya & Theo', welcomeMessage: 'Welcome.', eventTimezone: 'America/Chicago',
      rsvpDeadlineDate: '2026-09-05', rsvpEnabled: false, uploadsEnabled: true,
      galleryVisible: false, moderationRequired: true, rsvpRosterVersion: 7,
    });
    await settleMicrotasks();
    expect(screen.getByTestId('domain-state')).toHaveTextContent('settings:saved');
  });

  it('debounces typing into one request and flushes on blur', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ event: { ...EVENT, name: 'Reception' } })));
    render(<Harness />);
    const name = screen.getByLabelText('Event name');

    fireEvent.change(name, { target: { value: 'Reception' } });
    expect(settingsWrites()).toHaveLength(0);
    expect(screen.getByText('Saving event settings')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settleMicrotasks();
    expect(settingsWrites()).toHaveLength(1);
    expect(settingsWrites()[0]!.name).toBe('Reception');

    fireEvent.change(name, { target: { value: 'Ceremony' } });
    fireEvent.blur(name);
    // Blur does not wait out the rest of the window.
    await settleMicrotasks();
    expect(settingsWrites()).toHaveLength(2);
    expect(settingsWrites()[1]!.name).toBe('Ceremony');
  });

  it('normalizes a canonically equivalent edit on blur without a request', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ event: EVENT })));
    render(<Harness />);
    const name = screen.getByLabelText('Event name');

    fireEvent.change(name, { target: { value: 'Maya & Theo   ' } });
    fireEvent.blur(name);

    expect(name).toHaveValue('Maya & Theo');
    expect(settingsWrites()).toHaveLength(0);
    expect(screen.getByText('Event settings saved')).toBeInTheDocument();
  });

  it('sends nothing while the complete draft is invalid and names the blocking field', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ event: EVENT })));
    render(<Harness />);

    const name = screen.getByLabelText('Event name');
    fireEvent.change(name, { target: { value: '' } });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);

    expect(settingsWrites()).toHaveLength(0);
    expect(screen.getByLabelText(/^Event name/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/^Event name/)).toHaveAccessibleDescription('Enter an event name.');
    expect(screen.getByText('Event settings can’t save. Event name: Enter an event name.')).toBeInTheDocument();

    // The payload is atomic, so one bad field holds back an otherwise fine toggle.
    fireEvent.click(screen.getByLabelText('Review notes before sharing'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(settingsWrites()).toHaveLength(0);

    fireEvent.change(name, { target: { value: 'Reception' } });
    fireEvent.blur(name);
    await settleMicrotasks();
    expect(settingsWrites()).toHaveLength(1);
    expect(settingsWrites()[0]).toMatchObject({ name: 'Reception', moderationRequired: false });
  });

  it('adopts server normalization without overwriting a newer draft', async () => {
    let release: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      // The Worker trimmed what it was sent; the host has typed on since.
      return json({ event: { ...EVENT, name: 'Reception' } });
    }));
    render(<Harness />);
    const name = screen.getByLabelText('Event name');

    fireEvent.change(name, { target: { value: '  Reception  ' } });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(settingsWrites()).toHaveLength(1);

    fireEvent.change(name, { target: { value: 'Ceremony' } });
    release!();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settleMicrotasks();
    expect(settingsWrites()).toHaveLength(2);
    expect(name).toHaveValue('Ceremony');
    expect(settingsWrites()[1]!.name).toBe('Ceremony');
  });

  it('keeps an explicit baseline reversion made while the older value is in flight', async () => {
    let releaseFirst: (() => void) | null = null;
    let attempt = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        attempt += 1;
        if (attempt === 1) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
          return json({ event: { ...EVENT, rsvpEnabled: true } });
        }
        return json({ event: { ...EVENT, rsvpEnabled: false } });
      }
      throw new Error(`Unexpected request ${String(input)}`);
    }));
    // A parent is allowed to commit the response prop before the queue's promise
    // continuation settles. This schedule is the one that exposes an ABA rebase.
    render(<Harness synchronousResponses />);
    const rsvp = screen.getByLabelText('Accept RSVPs');

    fireEvent.click(rsvp);
    expect(settingsWrites()).toHaveLength(1);
    expect(rsvp).toBeChecked();

    // This is a new host action even though it equals the pre-request baseline.
    // The first write may already commit, so false has to follow it to the Worker.
    fireEvent.click(rsvp);
    expect(rsvp).not.toBeChecked();

    releaseFirst!();
    await settleMicrotasks();
    await settleMicrotasks();

    expect(settingsWrites()).toHaveLength(2);
    expect(settingsWrites()[1]).toMatchObject({ rsvpEnabled: false });
    expect(rsvp).not.toBeChecked();
    expect(screen.getByText('Event settings saved')).toBeInTheDocument();
  });

  it('keeps the draft and offers Retry when a save fails for a reason that can pass', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    render(<Harness />);

    const name = screen.getByLabelText('Event name');
    fireEvent.change(name, { target: { value: 'Reception' } });
    fireEvent.blur(name);

    await settleMicrotasks();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(screen.getByLabelText('Event name')).toHaveValue('Reception');
    expect(screen.getByTestId('domain-state')).toHaveTextContent('settings:failed');

    vi.stubGlobal('fetch', vi.fn(() => json({ event: { ...EVENT, name: 'Reception' } })));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settleMicrotasks();
    expect(screen.getByText('Event settings saved')).toBeInTheDocument();
  });

  it('turns a current server field error into invalid state with no Retry', async () => {
    vi.stubGlobal('fetch', vi.fn(() => errorJson({
      code: 'VALIDATION_FAILED', message: 'Check the event settings.',
      fieldErrors: { rsvpDeadlineDate: 'The RSVP deadline must be on or before the event date.' },
      requestId: 'request-a',
    }, 422)));
    render(<Harness />);

    fireEvent.click(screen.getByLabelText('Accept RSVPs'));
    // The host has moved on to another field while the refusal is in flight.
    screen.getByLabelText('Event name').focus();

    await settleMicrotasks();
    expect(screen.getByLabelText(/^RSVP deadline/))
      .toHaveAccessibleDescription('The RSVP deadline must be on or before the event date.');
    // A background refusal announces itself; it does not take the caret away
    // from whatever the host is typing in.
    expect(screen.getByLabelText('Event name')).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByTestId('domain-state')).toHaveTextContent('settings:invalid');
    // Editing an unrelated field cannot clear a refusal about this one.
    fireEvent.click(screen.getByLabelText('Review notes before sharing'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(screen.getByTestId('domain-state')).toHaveTextContent('settings:invalid');
  });

  it('refreshes once and retries when the roster version moved under the write', async () => {
    let attempt = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        attempt += 1;
        return attempt === 1
          ? errorJson({
            code: 'RSVP_ROSTER_INVALID',
            message: 'The guest list changed since this page loaded. Reload and try again.',
            fieldErrors: { rsvpEnabled: 'The guest list changed since this page loaded.' },
            requestId: 'request-a',
          }, 409)
          : json({ event: { ...EVENT, rsvpEnabled: true, rsvpRosterVersion: 9 } });
      }
      return json({ event: { ...EVENT, rsvpRosterVersion: 9 } });
    }));
    render(<Harness />);

    fireEvent.click(screen.getByLabelText('Accept RSVPs'));

    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settleMicrotasks();
    expect(settingsWrites()).toHaveLength(2);
    expect(settingsWrites()[0]!.rsvpRosterVersion).toBe(7);
    // The second attempt carries the version the refresh reported, and the
    // host intent survives it.
    expect(settingsWrites()[1]).toMatchObject({ rsvpRosterVersion: 9, rsvpEnabled: true });
    expect(screen.getByText('Event settings saved')).toBeInTheDocument();
    expect(screen.getByLabelText('Accept RSVPs')).toBeChecked();
  });

  it('stops after one automatic retry when the roster keeps moving', async () => {
    let rosterVersion = 7;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        return errorJson({
          code: 'RSVP_ROSTER_INVALID',
          message: 'The guest list changed since this page loaded. Reload and try again.',
          fieldErrors: { rsvpEnabled: 'The guest list changed since this page loaded.' },
          requestId: 'request-a',
        }, 409);
      }
      rosterVersion += 1;
      return json({ event: { ...EVENT, rsvpRosterVersion: rosterVersion } });
    }));
    render(<Harness />);

    fireEvent.click(screen.getByLabelText('Accept RSVPs'));
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settleMicrotasks();

    expect(settingsWrites()).toHaveLength(2);
    expect(settingsWrites().map((write) => write.rsvpRosterVersion)).toEqual([7, 8]);
    expect(screen.getByTestId('domain-state')).toHaveTextContent('settings:failed');
    expect(screen.getByRole('button', { name: /^Retry/u })).toBeVisible();
  });

  it('never reports Saved for the refused write that provoked the rebase', async () => {
    const announced: string[] = [];
    let releaseRetry: (() => void) | null = null;
    let attempt = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        attempt += 1;
        if (attempt === 1) {
          return errorJson({
            code: 'RSVP_ROSTER_INVALID',
            message: 'The guest list changed since this page loaded. Reload and try again.',
            fieldErrors: { rsvpEnabled: 'The guest list changed since this page loaded.' },
            requestId: 'request-a',
          }, 409);
        }
        // Hold the rebased retry open so the window between the refused write
        // and its replacement is observable.
        await new Promise<void>((resolve) => { releaseRetry = resolve; });
        return json({ event: { ...EVENT, rsvpEnabled: true, rsvpRosterVersion: 9 } });
      }
      return json({ event: { ...EVENT, rsvpRosterVersion: 9 } });
    }));
    render(<Harness />);
    const status = screen.getByTestId('domain-state');
    const observer = new MutationObserver(() => { announced.push(status.textContent ?? ''); });
    observer.observe(status, { childList: true, characterData: true, subtree: true });

    fireEvent.click(screen.getByLabelText('Accept RSVPs'));
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settleMicrotasks();
    expect(settingsWrites()).toHaveLength(2);

    // Nothing has committed yet, so nothing may have claimed it did.
    expect(announced).not.toContain('settings:saved');
    releaseRetry!();
    await settleMicrotasks();
    expect(screen.getByText('Event settings saved')).toBeInTheDocument();
    observer.disconnect();
  });

  it('treats a same-version roster refusal as terminal and names Accept RSVPs', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        return errorJson({
          code: 'RSVP_ROSTER_INVALID', message: 'Add a guest list before accepting RSVPs.',
          fieldErrors: { rsvpEnabled: 'Add a guest list before accepting RSVPs.' },
          requestId: 'request-a',
        }, 409);
      }
      return json({ event: EVENT });
    }));
    render(<Harness />);

    fireEvent.click(screen.getByLabelText('Accept RSVPs'));

    await settleMicrotasks();
    expect(screen.getByLabelText(/^Accept RSVPs/))
      .toHaveAccessibleDescription('Add a guest list before accepting RSVPs.');
    // No version moved, so repeating the write would be refused identically.
    expect(settingsWrites()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Accept RSVPs/)).toBeChecked();
  });

  it('re-enqueues the preserved RSVP intent once a later roster version arrives', async () => {
    const refused = () => errorJson({
      code: 'RSVP_ROSTER_INVALID', message: 'Add a guest list before accepting RSVPs.',
      fieldErrors: { rsvpEnabled: 'Add a guest list before accepting RSVPs.' },
      requestId: 'request-a',
    }, 409);
    let repaired = false;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        return repaired ? json({ event: { ...EVENT, rsvpEnabled: true, rsvpRosterVersion: 8 } }) : refused();
      }
      return json({ event: EVENT });
    }));
    const view = render(<Harness />);

    fireEvent.click(screen.getByLabelText('Accept RSVPs'));
    await settleMicrotasks();
    expect(screen.getByLabelText(/^Accept RSVPs/)).toHaveAccessibleDescription(
      'Add a guest list before accepting RSVPs.',
    );

    // The host repairs the roster in the RSVP destination, which advances the version.
    repaired = true;
    view.rerender(<Harness rosterVersion={8} />);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settleMicrotasks();
    expect(settingsWrites()).toHaveLength(2);
    expect(settingsWrites()[1]).toMatchObject({ rsvpEnabled: true, rsvpRosterVersion: 8 });
  });

  it('escalates a dead credential instead of offering a futile Retry', async () => {
    vi.stubGlobal('fetch', vi.fn(() => errorJson({
      code: 'SESSION_EXPIRED', message: 'This session has expired.', requestId: 'request-a',
    }, 401)));
    render(<Harness />);

    fireEvent.click(screen.getByLabelText('Review notes before sharing'));

    await settleMicrotasks();
    expect(screen.getByTestId('domain-state')).toHaveTextContent('settings:failed');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('flushes on Enter in a single-line field without submitting the page', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ event: { ...EVENT, name: 'Reception' } })));
    render(<Harness />);
    const submitted = vi.fn();
    const name = screen.getByLabelText('Event name');
    name.closest('form')!.addEventListener('submit', submitted);

    fireEvent.change(name, { target: { value: 'Reception' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(settingsWrites()).toHaveLength(1);
    expect(submitted).not.toHaveBeenCalled();
  });
});
