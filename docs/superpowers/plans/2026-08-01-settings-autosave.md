# Settings Autosave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-01-settings-autosave-design.md` (approved 2026-08-01). Section numbers below refer to it.

**Goal:** Remove **Save settings** and **Save appearance** from manager Settings so every valid general-setting and appearance change saves itself, without letting an older request overwrite a newer draft or reopen guest intake after the printed entry was disabled.

**Architecture:** Two independent client autosave queues — one for the complete general-settings `PATCH`, one for the theme `PUT` — each holding at most one in-flight and one pending snapshot, with the newest valid draft always replacing the pending one. `ManagerPage` keeps the Settings subtree mounted (hidden) after its first visit so timers and in-flight requests survive a destination change, merges each mutation response by ownership instead of refreshing the whole manager, and blocks router navigation and page unload while either domain is unconfirmed. On the Worker, `EventsRepository.updateSettings` gains an atomic open-entry predicate so a delayed autosave cannot reopen intake after `entry/disable`.

**Tech Stack:** React 19.2.8 (function-component `ref` props, no `forwardRef`), react-router-dom 7.18.1 (`useBlocker`), TypeScript 6.0.3, Vitest 4 (jsdom for `tests/unit` + `tests/ui`, `@cloudflare/vitest-pool-workers` for `tests/worker`), Playwright 1.61.1, Hono 4 + Zod 4 + D1 on the Worker.

## Global Constraints

- No D1 migration, no new route, no new `ApiErrorCode`. `PATCH /api/manage/events/:eventId/settings` stays a complete-payload write and `PUT /api/manage/events/:eventId/theme` stays a whole-config write.
- Debounce is exactly **600 ms** for text, textarea, time-zone, color-picker, and hex-color changes. Deadline, checkboxes, preset selection, preset-color restoration, and Reset enqueue immediately.
- Responses stay `{ data, requestId: context.get('requestId') }`. Errors stay `ApiError(code, message, status, fieldErrors?)` from `shared/errors.ts`.
- `@typescript-eslint/consistent-type-imports` is an **error** and `npm run lint` runs with `--max-warnings=0`. Every type-only import must be `import type`.
- `noUncheckedIndexedAccess` is on in both TS projects: indexed reads need `!` or a guard.
- `shared/` is imported by relative path from both projects (`../../shared/...`). There are no path aliases.
- Limits and rules stay sourced from `shared/constants.ts`, `shared/rsvp.ts`, and `shared/event-time.ts`. Client validation mirrors the Worker; the Worker stays authoritative.
- The autosave status chip is below the fold inside Settings and reuses the already-approved `.event-appearance-editor__status` treatment. `design/design-system.md`'s no-badge/no-pill rule governs **above-the-fold** copy only; do not add any new above-the-fold copy.
- Retry and every new control keep a minimum **44 × 44** CSS-pixel target. Manager layouts must stay contained at **320 px** and **390 px**.
- Never claim a setting is saved before the Worker response succeeds.

---

## File Structure

**Create:**

- `src/features/settings/autosave-queue.ts` — domain-free serialized coalescing queue: debounce, one in-flight, one pending, status derivation, failure classification seam. No React, no `fetch`.
- `src/features/settings/event-settings-draft.ts` — the eight general settings as a draft type, canonical snapshot, canonical key, client validation, field labels.
- `src/features/settings/event-merge.ts` — response-ownership merges (`mergeSettingsResponse`, `mergeThemeResponse`, `mergeCoverResponse`).
- `src/features/settings/event-read-guard.ts` — decides whether a whole-event read is still authoritative when it lands. Ownership merges fix *mutation* responses; this fixes the plain `GET`s that would otherwise rebase an editor backward.
- `src/components/AutosaveStatus.tsx` — the shared accessible status container, its pure label function, and Retry.
- `src/components/EventSettingsEditor.tsx` — the controlled general-settings editor that replaces the inline `ManagerPage` form.
- `src/components/UnsavedSettingsPrompt.tsx` — the navigation prompt with **Leave now** / **Stay and fix settings**.
- `tests/unit/settings-autosave-queue.test.ts`
- `tests/unit/event-settings-draft.test.ts`
- `tests/unit/manager-event-merge.test.ts`
- `tests/unit/event-read-guard.test.ts`
- `tests/unit/autosave-status-text.test.ts`
- `tests/ui/event-settings-editor.test.tsx`
- `tests/ui/manager-settings-autosave.test.tsx`

**Modify:**

- `worker/db/events.ts` — `updateSettings` gains the atomic open-entry predicate.
- `worker/routes/manage.ts` — classify a refused guarded update as entry-vs-roster.
- `src/pages/ManagerPage.tsx` — Settings stays mounted, ownership merges, flush on destination change, autosave notice, navigation guard.
- `src/components/EventAppearanceEditor.tsx` — autosave, split saved callbacks, no Save button.
- `src/styles.css` — autosave status, notice, and prompt styles.
- `tests/worker/repositories.test.ts`, `tests/worker/manage-api.test.ts`, `tests/ui/app.test.tsx`, `tests/ui/event-appearance-editor.test.tsx`, `tests/e2e/event-theming.spec.ts`
- `design-qa.md`, `design/fidelity-ledger.md`, `docs/superpowers/specs/2026-07-29-event-theming-design.md`, `docs/superpowers/plans/2026-07-29-event-theming.md`

---

### Task 1: Atomic open-entry predicate on the settings write

The route already calls `requireOpenEntry()` before validating, but that is a read-before-write: a settings request that started before `entry/disable` committed can still reopen `uploads_enabled` or `rsvp_enabled` afterwards. Move the invariant into the same `UPDATE` statement.

**Files:**
- Modify: `worker/db/events.ts:130-171` (`updateSettings`)
- Modify: `worker/routes/manage.ts:267-279` (refusal classification)
- Test: `tests/worker/repositories.test.ts`, `tests/worker/manage-api.test.ts`

**Interfaces:**
- Consumes: `EventEntryService.requireOpenEntry(eventId)` from `worker/services/event-entry.ts`, which throws `ApiError('EVENT_ENTRY_UNAVAILABLE', …, 410)` and adopts a pre-0008 legacy entry when one exists.
- Produces: `EventsRepository.updateSettings(id, input)` keeps its exact signature and still returns `Promise<EventRecord | null>`; `null` now means "roster race **or** closed entry" and the route decides which.

- [ ] **Step 1: Write the failing repository test**

Add to `tests/worker/repositories.test.ts`, inside the existing `describe` that already covers `EventsRepository` (place it after the last `EventsRepository` case):

```ts
  it('refuses to reopen either intake while the printed entry is disabled', async () => {
    const events = new EventsRepository(env.DB);
    const created = await events.create({
      id: 'event-entry-guard', slug: 'entry-guard', name: 'Maya & Theo',
      eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
      guestAccessExpiresAt: now, managementAccessExpiresAt: now, purgeAfter: now,
      createdAt: now, themeConfig: serializeEventThemeConfig(DEFAULT_EVENT_THEME_CONFIG),
      eventTimezone: 'America/Chicago', rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
    });
    const settings = {
      galleryVisible: true, moderationRequired: false,
      eventTimezone: 'America/Chicago', rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
      expectedRosterVersion: 0,
    };
    const entries = new EventEntriesRepository(env.DB);
    await entries.createStatement({
      id: 'entry-a', eventId: created.id, secretDigest: 'digest', secretCiphertext: 'cipher',
      createdAt: now,
    }).run();

    // Open entry: reopening intake is allowed.
    expect(await events.updateSettings(created.id, {
      ...settings, uploadsEnabled: true, rsvpEnabled: false,
    })).not.toBeNull();

    await entries.disableForEvent(created.id, now);
    await env.DB.prepare('UPDATE events SET uploads_enabled = 0, rsvp_enabled = 0 WHERE id = ?')
      .bind(created.id).run();

    // A disabled entry refuses either intake, atomically, whatever the caller checked first.
    expect(await events.updateSettings(created.id, {
      ...settings, uploadsEnabled: true, rsvpEnabled: false,
    })).toBeNull();
    expect(await events.updateSettings(created.id, {
      ...settings, uploadsEnabled: false, rsvpEnabled: true,
    })).toBeNull();

    // Every other setting still saves, because the host has to keep managing the event.
    const kept = await events.updateSettings(created.id, {
      ...settings, name: 'Renamed', uploadsEnabled: false, rsvpEnabled: false,
    });
    expect(kept?.name).toBe('Renamed');
    expect(kept?.uploadsEnabled).toBe(false);
  });
```

`EventEntriesRepository` is already imported at the top of `tests/worker/repositories.test.ts`, as are `EventsRepository`, `DEFAULT_EVENT_THEME_CONFIG`, `serializeEventThemeConfig`, and the `now` constant.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/repositories.test.ts -t 'reopen either intake'`
Expected: FAIL — the second and third `updateSettings` calls return an event instead of `null`.

- [ ] **Step 3: Add the predicate to the update**

In `worker/db/events.ts`, replace the `UPDATE` inside `updateSettings` with:

```ts
    const result = await this.db.prepare(`
      UPDATE events SET
        name = COALESCE(?, name),
        welcome_message = COALESCE(?, welcome_message),
        uploads_enabled = ?,
        gallery_visible = ?,
        moderation_required = ?,
        event_timezone = ?,
        rsvp_deadline_at = ?,
        rsvp_enabled = ?
      WHERE id = ? AND deleted_at IS NULL AND rsvp_roster_version = ?
        -- Reopening either intake is only legal while a printed entry is still
        -- enabled, and that has to be decided inside this statement: the route's
        -- earlier check is a read, and a settings write already in flight when
        -- the entry was disabled would otherwise commit against a stale answer.
        AND (
          (? = 0 AND ? = 0)
          OR EXISTS (
            SELECT 1 FROM event_entry_credentials
            WHERE event_id = events.id AND disabled_at IS NULL
          )
        )
    `).bind(
      input.name ?? null,
      input.welcomeMessage ?? null,
      input.uploadsEnabled ? 1 : 0,
      input.galleryVisible ? 1 : 0,
      input.moderationRequired ? 1 : 0,
      input.eventTimezone,
      input.rsvpDeadlineAt,
      input.rsvpEnabled ? 1 : 0,
      id,
      input.expectedRosterVersion,
      input.uploadsEnabled ? 1 : 0,
      input.rsvpEnabled ? 1 : 0,
    ).run();
```

Leave the `if ((result.meta.changes ?? 0) !== 1) return null;` line and the doc comment above it in place.

- [ ] **Step 4: Run the repository test to verify it passes**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/repositories.test.ts -t 'reopen either intake'`
Expected: PASS

- [ ] **Step 5: Write the failing route-classification test**

Add to `tests/worker/manage-api.test.ts` inside `describe('manager settings and private photo intake', …)`:

```ts
  it('classifies a guarded settings refusal as the entry stop, not a roster race', async () => {
    const access = await eventAccess();
    await createApp().request(`/api/manage/events/${access.event.id}/entry/disable`, {
      method: 'POST', headers: writeHeaders(access.manager),
      body: JSON.stringify({ confirmName: access.event.name }),
    }, testEnv);

    // Settings that touch nothing guests can reach still save after the stop.
    const renamed = await applySettings(access, {
      name: 'Renamed', uploadsEnabled: false, rsvpEnabled: false,
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json<any>()).data.event.name).toBe('Renamed');

    const reopened = await applySettings(access, { uploadsEnabled: true });
    expect(reopened.status).toBe(410);
    expect((await reopened.json<any>()).code).toBe('EVENT_ENTRY_UNAVAILABLE');
  });
```

Import `applySettings` from `./helpers` if the file does not already.

- [ ] **Step 6: Run it and confirm the current behavior**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts -t 'guarded settings refusal'`
Expected: PASS for the 410 (the route's early `requireOpenEntry` already produces it) and PASS for the rename. If the rename fails with 409 `RSVP_ROSTER_INVALID`, that is the regression Step 7 fixes.

- [ ] **Step 7: Classify the refused guarded update in the route**

In `worker/routes/manage.ts`, replace the `if (!event) { … }` block at the end of the settings handler with:

```ts
  if (!event) {
    // The update now refuses an intake reopen itself, so a lost row is no longer
    // proof of a roster race. Re-read the entry before naming the reason: the
    // irreversible stop and a moving guest list are different problems with
    // different ways out.
    if (parsed.data.uploadsEnabled || parsed.data.rsvpEnabled) {
      await new EventEntryService(context.env).requireOpenEntry(auth.event.id);
    }
    throw new ApiError(
      'RSVP_ROSTER_INVALID',
      'The guest list changed while these settings were saving. Review it and try again.',
      409,
      { rsvpEnabled: 'The guest list changed while these settings were saving.' },
    );
  }
```

- [ ] **Step 8: Run the whole Worker suite**

Run: `npm run test:worker`
Expected: PASS, including the existing `will not let rotation or settings reopen a disabled entry` case in `tests/worker/event-entry-api.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add worker/db/events.ts worker/routes/manage.ts tests/worker/repositories.test.ts tests/worker/manage-api.test.ts
git commit -m "fix: hold the settings write to the irreversible entry stop"
```

---

### Task 2: The serialized coalescing autosave queue

**Files:**
- Create: `src/features/settings/autosave-queue.ts`
- Test: `tests/unit/settings-autosave-queue.test.ts`

**Interfaces:**
- Consumes: `LoadFailure` (type only) from `src/components/States.tsx`.
- Produces, for every later task:
  - `AUTOSAVE_DEBOUNCE_MS: 600`
  - `type AutosaveStatus = 'saved' | 'scheduled' | 'saving' | 'invalid' | 'failed'`
  - `interface AutosaveFailure { message: string; retryable: boolean; escalation?: LoadFailure }`
  - `interface AutosaveState { status: AutosaveStatus; failure: AutosaveFailure | null }`
  - `interface AutosaveDraft<S> { key: string; intent: string; snapshot: S | null }`
  - `type AutosaveOutcome = { status: 'confirmed'; key: string } | { status: 'rebased' }`
  - `interface AutosaveHandle { flush(): void }`
  - `interface DomainAutosaveState { domain: 'settings' | 'appearance'; label: string; status: AutosaveStatus; failure: AutosaveFailure | null; blockingField: { label: string; message: string } | null }`
  - `createAutosaveQueue<S>(options: AutosaveQueueOptions<S>): AutosaveQueue<S>` with methods `submit(draft, immediate?)`, `flush()`, `adoptBaseline(key)`, `state()`, `dispose()`.

There is deliberately no `retry()` on the queue: Retry must send the newest valid draft, which is exactly `submit(currentDraft, true)`. A second entry point that resends a remembered snapshot would be the one that eventually sends the wrong one.

Name collision to keep in mind: the **type** `AutosaveStatus` lives here and the **component** `AutosaveStatus` lives in `src/components/AutosaveStatus.tsx`. No file imports both, and none should — a file that needs the status vocabulary should reach for `AutosaveState` instead.

**The queue keeps three things apart, and conflating any two of them is a bug:**

| Concept | Field | Decides |
| --- | --- | --- |
| Persistence identity | `AutosaveDraft.key` | whether two drafts are the same write, and what the baseline is compared against |
| Raw host intent | `AutosaveDraft.intent` | whether the screen has moved on since a request was sent — it changes for edits that leave `key` untouched, such as invalid hex text sitting on top of the last valid color |
| Confirmation | `AutosaveOutcome` | whether a resolved request actually committed, and under which key |

`save()` returns `{ status: 'confirmed', key }` with the key the **Worker** reports storing — not the key that was sent — so server normalization cannot leave a draft looking permanently dirty. It returns `{ status: 'rebased' }` when the request resolved without committing and something newer is already on its way; the queue then keeps reporting `Saving…` rather than a `Saved` no write earned.

- [ ] **Step 1: Write the failing queue tests**

Create `tests/unit/settings-autosave-queue.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTOSAVE_DEBOUNCE_MS,
  createAutosaveQueue,
  type AutosaveFailure,
  type AutosaveOutcome,
  type AutosaveState,
} from '../../src/features/settings/autosave-queue';

interface Deferred {
  promise: Promise<AutosaveOutcome>;
  confirm(key?: string): void;
  rebase(): void;
  reject(error: unknown): void;
}

function deferred(sentKey: string): Deferred {
  let resolve!: (outcome: AutosaveOutcome) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<AutosaveOutcome>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {
    promise,
    confirm: (key = sentKey) => { resolve({ status: 'confirmed', key }); },
    rebase: () => { resolve({ status: 'rebased' }); },
    reject,
  };
}

const RETRYABLE: AutosaveFailure = { message: 'That change could not be saved.', retryable: true };

function harness(baselineKey = 'v0') {
  const sent: string[] = [];
  const intents: string[] = [];
  const gates: Deferred[] = [];
  const states: AutosaveState[] = [];
  const queue = createAutosaveQueue<string>({
    baselineKey,
    save(snapshot, draft) {
      sent.push(draft.key);
      intents.push(draft.intent);
      void snapshot;
      const gate = deferred(draft.key);
      gates.push(gate);
      return gate.promise;
    },
    describeFailure: () => RETRYABLE,
    onChange: (state) => { states.push(state); },
  });
  // `intent` defaults to the key: most drafts move both together, and the tests
  // that care about them diverging pass it explicitly.
  const draft = (key: string, intent = key) => ({ key, intent, snapshot: key });
  return { queue, sent, intents, gates, states, draft };
}

// Vitest's fake timers must be installed before the queue schedules anything.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('autosave queue', () => {
  it('waits the full debounce before sending, and sends once', () => {
    const { queue, sent, draft } = harness();
    queue.submit(draft('v1'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(['v1']);
    expect(queue.state().status).toBe('saving');
  });

  it('collapses intermediate drafts into the newest one', () => {
    const { queue, sent, draft } = harness();
    queue.submit(draft('v1'));
    vi.advanceTimersByTime(300);
    queue.submit(draft('v2'));
    vi.advanceTimersByTime(300);
    queue.submit(draft('v3'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(sent).toEqual(['v3']);
  });

  it('flushes the newest valid draft immediately', () => {
    const { queue, sent, draft } = harness();
    queue.submit(draft('v1'));
    queue.flush();
    expect(sent).toEqual(['v1']);
  });

  it('sends immediate drafts without waiting', () => {
    const { queue, sent, draft } = harness();
    queue.submit(draft('v1'), true);
    expect(sent).toEqual(['v1']);
  });

  it('keeps one request in flight and starts only the newest pending snapshot', async () => {
    const { queue, sent, gates, draft } = harness();
    queue.submit(draft('v1'), true);
    queue.submit(draft('v2'), true);
    queue.submit(draft('v3'), true);
    expect(sent).toEqual(['v1']);

    gates[0]!.confirm();
    await vi.waitFor(() => expect(sent).toEqual(['v1', 'v3']));
    gates[1]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
    expect(sent).toEqual(['v1', 'v3']);
  });

  it('drops a pending snapshot when the host returns to the value being written', async () => {
    const { queue, sent, gates, draft } = harness('v0');
    queue.submit(draft('v1'), true);
    queue.submit(draft('v2'), true);
    // Back to exactly what is in flight. What was queued behind it described
    // intent the host has since abandoned, and sending it would make older
    // intent final.
    queue.submit(draft('v1'), true);

    gates[0]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
    expect(sent).toEqual(['v1']);
  });

  it('cancels a scheduled snapshot when the host returns to the confirmed baseline', () => {
    const { queue, sent, draft } = harness('v0');
    queue.submit(draft('v1'));
    queue.submit(draft('v0'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(sent).toEqual([]);
    expect(queue.state().status).toBe('saved');
  });

  it('still queues a baseline reversion behind an in-flight snapshot', async () => {
    const { queue, sent, gates, draft } = harness('v0');
    queue.submit(draft('v1'), true);
    queue.submit(draft('v0'), true);
    expect(sent).toEqual(['v1']);
    gates[0]!.confirm();
    // v1 may already have committed, so v0 has to be stated rather than assumed.
    await vi.waitFor(() => expect(sent).toEqual(['v1', 'v0']));
  });

  it('cancels scheduled and pending work when the latest draft becomes invalid', async () => {
    const { queue, sent, gates, draft } = harness();
    queue.submit(draft('v1'), true);
    queue.submit(draft('v2'));
    queue.submit({ key: 'v3-invalid', intent: 'v3-invalid', snapshot: null });
    expect(queue.state().status).toBe('invalid');
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    gates[0]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('invalid'));
    expect(sent).toEqual(['v1']);
  });

  it('suppresses a superseded failure and starts the pending snapshot', async () => {
    const { queue, sent, gates, states, draft } = harness();
    queue.submit(draft('v1'), true);
    queue.submit(draft('v2'), true);
    gates[0]!.reject(new Error('offline'));
    await vi.waitFor(() => expect(sent).toEqual(['v1', 'v2']));
    expect(states.some((state) => state.status === 'failed')).toBe(false);
    gates[1]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
  });

  it('reports a current failure, and a newer valid edit clears it and queues normally', async () => {
    const { queue, sent, gates, draft } = harness();
    queue.submit(draft('v1'), true);
    gates[0]!.reject(new Error('offline'));
    await vi.waitFor(() => expect(queue.state()).toEqual({ status: 'failed', failure: RETRYABLE }));

    queue.submit(draft('v2'));
    expect(queue.state().status).toBe('scheduled');
    expect(queue.state().failure).toBeNull();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(sent).toEqual(['v1', 'v2']);
    gates[1]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
  });

  it('resends the current draft immediately when Retry submits it again', async () => {
    const { queue, sent, gates, draft } = harness();
    queue.submit(draft('v1'), true);
    gates[0]!.reject(new Error('offline'));
    await vi.waitFor(() => expect(queue.state().status).toBe('failed'));

    // Retry is an immediate resubmit of whatever the host can see now. There is
    // no second entry point that could resend the snapshot that failed.
    queue.submit(draft('v1'), true);
    expect(sent).toEqual(['v1', 'v1']);
    expect(queue.state()).toEqual({ status: 'saving', failure: null });
    gates[1]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
  });

  it('advances the baseline on success so an unchanged redraft sends nothing', async () => {
    const { queue, sent, gates, draft } = harness('v0');
    queue.submit(draft('v1'), true);
    gates[0]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
    queue.submit(draft('v1'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(sent).toEqual(['v1']);
  });

  it('adopts the key the Worker says it stored, not the key that was sent', async () => {
    const { queue, sent, gates, draft } = harness('v0');
    queue.submit(draft('v1-raw'), true);
    // The Worker normalized what it was sent and reports the stored form.
    gates[0]!.confirm('v1');
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));

    queue.submit(draft('v1'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    // The normalized value is the baseline, so it is not dirty and sends nothing.
    expect(sent).toEqual(['v1-raw']);
  });

  it('keeps reporting that it is saving when a request resolved without committing', async () => {
    const { queue, gates, states, draft } = harness('v0');
    queue.submit(draft('v1'), true);
    gates[0]!.rebase();

    // Nothing committed, so nothing may say `Saved` — something newer is coming.
    await vi.waitFor(() => expect(queue.state().status).toBe('saving'));
    expect(states.some((state) => state.status === 'saved')).toBe(false);

    queue.submit(draft('v2'), true);
    gates[1]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
  });

  it('tells a response whether the screen moved on, even when the payload did not', async () => {
    const { queue, sent, intents, gates, draft } = harness('v0');
    queue.submit(draft('v1', 'v1-raw'), true);
    // Raw input that leaves the canonical value alone: same key, new intent.
    queue.submit({ key: 'v1', intent: 'v1-typed', snapshot: null });

    gates[0]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('invalid'));
    expect(sent).toEqual(['v1']);
    expect(intents).toEqual(['v1-raw']);
  });

  it('adopts a baseline confirmed elsewhere without sending', () => {
    const { queue, sent, draft } = harness('v0');
    queue.adoptBaseline('v9');
    queue.submit(draft('v9'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(sent).toEqual([]);
    expect(queue.state().status).toBe('saved');
  });

  it('disposal discards unsent intent but never the request already sent', async () => {
    const { queue, sent, gates, draft } = harness();
    queue.submit(draft('v1'));
    queue.flush();
    // v2 is pending behind the in-flight v1, and v3 has not left the timer.
    queue.submit(draft('v2'), true);
    queue.submit(draft('v3'));
    queue.dispose();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);

    // The request already in flight still finishes; nothing new is started.
    // This is what makes `Leave now` honest about what it discards.
    gates[0]!.confirm();
    await expect(gates[0]!.promise).resolves.toEqual({ status: 'confirmed', key: 'v1' });
    await vi.waitFor(() => expect(sent).toEqual(['v1']));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --config vitest.config.ts tests/unit/settings-autosave-queue.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/features/settings/autosave-queue"`.

- [ ] **Step 3: Write the queue**

Create `src/features/settings/autosave-queue.ts`:

```ts
import type { LoadFailure } from '../../components/States';

/**
 * One persistence domain's write queue. It exists because the settings and
 * theme endpoints each accept one complete payload: two requests in flight at
 * once means the slower one decides what is stored, whatever the host last
 * typed. So a domain holds at most one in-flight snapshot and one pending
 * snapshot, and the pending one is always the newest valid draft. Intermediate
 * drafts are dropped on purpose — they are keystrokes, not intent.
 *
 * Aborting `fetch` is deliberately not the ordering mechanism: an aborted
 * request may already have committed on the Worker. Serialization is.
 */

export const AUTOSAVE_DEBOUNCE_MS = 600;

export type AutosaveStatus = 'saved' | 'scheduled' | 'saving' | 'invalid' | 'failed';

export interface AutosaveFailure {
  message: string;
  // Whether repeating the same request could reasonably succeed. A revoked
  // credential or an ended event cannot, and offering Retry there is a lie.
  retryable: boolean;
  // Set for credential and lifecycle failures, so the manager can raise its
  // existing recovery notice instead of a local Retry button.
  escalation?: LoadFailure;
}

export interface AutosaveState {
  status: AutosaveStatus;
  failure: AutosaveFailure | null;
}

export interface AutosaveDraft<S> {
  /** Persistence identity. Two drafts sharing a key are the same write. */
  key: string;
  /**
   * What the host can actually see. It changes for edits that leave the payload
   * alone — invalid hex text sitting on top of the last valid color, a trailing
   * space — which is the only way a response can tell whether the screen has
   * moved on since it was sent.
   */
  intent: string;
  /** `null` means the latest complete domain draft cannot be sent at all. */
  snapshot: S | null;
}

/**
 * What a resolved `save` actually achieved. `confirmed` carries the key the
 * Worker reports storing, which is not always the key that was sent: server
 * normalization would otherwise leave the draft looking dirty forever.
 * `rebased` means the request resolved without committing and something newer
 * is already on its way — the domain is still saving, and must not say `Saved`.
 */
export type AutosaveOutcome =
  | { status: 'confirmed'; key: string }
  | { status: 'rebased' };

export interface AutosaveHandle {
  flush(): void;
}

export interface DomainAutosaveState {
  domain: 'settings' | 'appearance';
  label: string;
  status: AutosaveStatus;
  failure: AutosaveFailure | null;
  blockingField: { label: string; message: string } | null;
}

export interface AutosaveQueueOptions<S> {
  baselineKey: string;
  debounceMs?: number;
  save(snapshot: S, draft: { key: string; intent: string }): Promise<AutosaveOutcome>;
  // Called only for a failure that still describes the latest draft, so the
  // editor can attach server field errors in the same moment it learns the
  // request was refused — and never for intent the host has already replaced.
  describeFailure(error: unknown, key: string): AutosaveFailure;
  onChange(state: AutosaveState): void;
}

export interface AutosaveQueue<S> {
  submit(draft: AutosaveDraft<S>, immediate?: boolean): void;
  flush(): void;
  adoptBaseline(key: string): void;
  state(): AutosaveState;
  dispose(): void;
}

interface Ready<S> { key: string; intent: string; snapshot: S }

export function createAutosaveQueue<S>(options: AutosaveQueueOptions<S>): AutosaveQueue<S> {
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  let baselineKey = options.baselineKey;
  let latest: AutosaveDraft<S> | null = null;
  let scheduled: Ready<S> | null = null;
  let inFlight: Ready<S> | null = null;
  let pending: Ready<S> | null = null;
  let failure: AutosaveFailure | null = null;
  // A request resolved without committing and a replacement is expected. It
  // stops `derive` from reporting a `Saved` that no write earned, and clears on
  // the next submit — which is the replacement arriving.
  let rebasing = false;
  let timer: number | null = null;
  let announced: AutosaveState = { status: 'saved', failure: null };
  let disposed = false;

  function cancelTimer() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  // `invalid` outranks an older in-flight or failed state, and a live request
  // outranks an older failure: the host is told about the draft in front of
  // them, not about intent they have already moved past.
  function derive(): AutosaveStatus {
    if (latest?.snapshot === null) return 'invalid';
    if (inFlight) return 'saving';
    if (scheduled) return 'scheduled';
    if (rebasing) return 'saving';
    if (failure) return 'failed';
    return 'saved';
  }

  function emit() {
    if (disposed) return;
    const next: AutosaveState = { status: derive(), failure };
    if (next.status === announced.status && next.failure === announced.failure) return;
    announced = next;
    options.onChange(next);
  }

  function settle(sent: Ready<S>, error: unknown, outcome: AutosaveOutcome | null) {
    if (inFlight !== sent) return;
    inFlight = null;
    // A response describes the snapshot it was sent for. If anything newer is
    // queued or on screen, its verdict is about intent that no longer exists.
    const superseded = pending !== null || latest === null || latest.key !== sent.key;
    if (error !== null) {
      rebasing = false;
      if (!superseded && !disposed) failure = options.describeFailure(error, sent.key);
    } else if (outcome?.status === 'confirmed') {
      // The Worker's own answer, not the key that was sent.
      baselineKey = outcome.key;
      rebasing = false;
      failure = null;
    } else {
      rebasing = true;
    }
    const next = pending;
    pending = null;
    if (next) start(next);
    else emit();
  }

  function start(next: Ready<S>) {
    if (disposed) return;
    if (inFlight) {
      pending = next;
      emit();
      return;
    }
    inFlight = next;
    emit();
    void options.save(next.snapshot, { key: next.key, intent: next.intent }).then(
      (outcome) => { settle(next, null, outcome); },
      (error: unknown) => {
        settle(next, error ?? new Error('The change could not be saved.'), null);
      },
    );
  }

  function submit(draft: AutosaveDraft<S>, immediate = false) {
    if (disposed) return;
    latest = draft;
    // A new draft is the replacement a `rebased` outcome was waiting for.
    rebasing = false;
    if (draft.snapshot === null) {
      // Saving historical intent after the host has made the domain unsendable
      // is worse than saving nothing, so nothing unstarted survives this.
      cancelTimer();
      scheduled = null;
      pending = null;
      emit();
      return;
    }
    const next: Ready<S> = { key: draft.key, intent: draft.intent, snapshot: draft.snapshot };
    if (failure) failure = null;
    // Equivalence is judged against the baseline, the in-flight snapshot, and
    // the pending snapshot together — never against the baseline alone.
    if (inFlight === null && next.key === baselineKey) {
      cancelTimer();
      scheduled = null;
      pending = null;
      emit();
      return;
    }
    if (inFlight?.key === next.key) {
      // The host is back at exactly what is being written. Anything queued
      // behind it described intent they have since abandoned, and letting it
      // run would make the older value the one that survives.
      cancelTimer();
      scheduled = null;
      pending = null;
      emit();
      return;
    }
    if (pending?.key === next.key) {
      cancelTimer();
      scheduled = null;
      emit();
      return;
    }
    if (immediate) {
      cancelTimer();
      scheduled = null;
      start(next);
      return;
    }
    if (scheduled?.key === next.key) {
      // Resubmitting the same value must not keep pushing the deadline out.
      emit();
      return;
    }
    scheduled = next;
    cancelTimer();
    timer = window.setTimeout(() => {
      timer = null;
      const ready = scheduled;
      scheduled = null;
      if (ready) start(ready);
    }, debounceMs);
    emit();
  }

  return {
    submit,
    flush() {
      if (disposed) return;
      cancelTimer();
      const ready = scheduled;
      scheduled = null;
      if (ready) start(ready);
    },
    adoptBaseline(key: string) {
      baselineKey = key;
      emit();
    },
    state: () => announced,
    /**
     * Everything not yet sent is discarded, and nothing new starts. This runs
     * on unmount — which is what a client navigation past the prompt causes —
     * and it is what makes `Leave now` honest: the host was told that unsent
     * changes go, so a debounce timer or a pending snapshot must not fire after
     * they have gone. A request already sent still finishes, because cancelling
     * it here would not un-commit it on the Worker; the prompt says that too.
     *
     * A destination change inside the manager does not unmount anything, so it
     * never reaches this.
     */
    dispose() {
      disposed = true;
      cancelTimer();
      scheduled = null;
      pending = null;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts tests/unit/settings-autosave-queue.test.ts`
Expected: PASS — 19 tests.

- [ ] **Step 5: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/autosave-queue.ts tests/unit/settings-autosave-queue.test.ts
git commit -m "feat: add the serialized settings autosave queue"
```

---

### Task 3: The general-settings draft, canonical snapshot, and client validation

**Files:**
- Create: `src/features/settings/event-settings-draft.ts`
- Test: `tests/unit/event-settings-draft.test.ts`

**Interfaces:**
- Consumes: `EventView` from `shared/contracts.ts`; `canonicalTimeZone`, `isIanaTimeZone` from `shared/event-time.ts`.
- Produces:
  - `interface EventSettingsDraft { name; welcomeMessage; eventTimezone; rsvpDeadlineDate: string; rsvpEnabled; uploadsEnabled; galleryVisible; moderationRequired: boolean }`
  - `type EventSettingsField = keyof EventSettingsDraft`
  - `interface EventSettingsPayload extends EventSettingsDraft { rsvpRosterVersion: number }`
  - `EVENT_SETTINGS_FIELDS: readonly EventSettingsField[]` (form order)
  - `EVENT_SETTINGS_LABELS: Record<EventSettingsField, string>`
  - `draftFromEvent(event: EventView): EventSettingsDraft`
  - `canonicalEventSettings(draft, rsvpRosterVersion): EventSettingsPayload`
  - `eventSettingsKey(payload: EventSettingsPayload): string`
  - `validateEventSettings(draft, eventDate): Partial<Record<EventSettingsField, string>>`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/event-settings-draft.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { EventView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import {
  canonicalEventSettings,
  draftFromEvent,
  eventSettingsKey,
  EVENT_SETTINGS_FIELDS,
  EVENT_SETTINGS_LABELS,
  validateEventSettings,
} from '../../src/features/settings/event-settings-draft';

const event: EventView = {
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

describe('event settings draft', () => {
  it('covers every autosaving general setting exactly once, in form order', () => {
    expect(EVENT_SETTINGS_FIELDS).toEqual([
      'name', 'welcomeMessage', 'eventTimezone', 'rsvpDeadlineDate',
      'rsvpEnabled', 'uploadsEnabled', 'galleryVisible', 'moderationRequired',
    ]);
    expect(Object.keys(EVENT_SETTINGS_LABELS).sort()).toEqual([...EVENT_SETTINGS_FIELDS].sort());
  });

  it('reads a draft from the confirmed event and treats a missing deadline as empty', () => {
    expect(draftFromEvent(event)).toEqual({
      name: 'Maya & Theo', welcomeMessage: 'Welcome.', eventTimezone: 'America/Chicago',
      rsvpDeadlineDate: '2026-09-05', rsvpEnabled: false, uploadsEnabled: true,
      galleryVisible: true, moderationRequired: true,
    });
    expect(draftFromEvent({ ...event, rsvpDeadlineDate: null }).rsvpDeadlineDate).toBe('');
  });

  it('trims and canonicalizes before the value ever becomes a snapshot', () => {
    const payload = canonicalEventSettings({
      ...draftFromEvent(event), name: '  Maya & Theo  ', welcomeMessage: ' Welcome. ',
      eventTimezone: 'america/chicago',
    }, 7);
    expect(payload).toEqual({
      name: 'Maya & Theo', welcomeMessage: 'Welcome.', eventTimezone: 'America/Chicago',
      rsvpDeadlineDate: '2026-09-05', rsvpEnabled: false, uploadsEnabled: true,
      galleryVisible: true, moderationRequired: true, rsvpRosterVersion: 7,
    });
  });

  it('gives canonically equivalent drafts one identity and different drafts another', () => {
    const base = draftFromEvent(event);
    expect(eventSettingsKey(canonicalEventSettings({ ...base, name: '  Maya & Theo ' }, 7)))
      .toBe(eventSettingsKey(canonicalEventSettings(base, 7)));
    expect(eventSettingsKey(canonicalEventSettings(base, 8)))
      .not.toBe(eventSettingsKey(canonicalEventSettings(base, 7)));
    expect(eventSettingsKey(canonicalEventSettings({ ...base, rsvpEnabled: true }, 7)))
      .not.toBe(eventSettingsKey(canonicalEventSettings(base, 7)));
  });

  it('accepts the confirmed values it was built from', () => {
    expect(validateEventSettings(draftFromEvent(event), event.eventDate)).toEqual({});
  });

  it('mirrors the Worker rules field by field', () => {
    const base = draftFromEvent(event);
    expect(validateEventSettings({ ...base, name: '   ' }, event.eventDate))
      .toEqual({ name: 'Enter an event name.' });
    expect(validateEventSettings({ ...base, name: 'a'.repeat(81) }, event.eventDate))
      .toEqual({ name: 'Use 80 characters or fewer.' });
    expect(validateEventSettings({ ...base, welcomeMessage: '' }, event.eventDate))
      .toEqual({ welcomeMessage: 'Enter a welcome message.' });
    expect(validateEventSettings({ ...base, welcomeMessage: 'w'.repeat(501) }, event.eventDate))
      .toEqual({ welcomeMessage: 'Use 500 characters or fewer.' });
    expect(validateEventSettings({ ...base, eventTimezone: 'Mars/Olympus' }, event.eventDate))
      .toEqual({ eventTimezone: 'Choose a valid time zone.' });
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'Choose a valid RSVP deadline.' });
    // Shape alone is not a date. The Worker rejects this in `endOfLocalDate`;
    // sending it would be a round trip spent learning what is already known.
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-02-31' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'Choose a valid RSVP deadline.' });
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-13-01' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'Choose a valid RSVP deadline.' });
    // A leap day that does exist is not rejected with them.
    expect(validateEventSettings(
      { ...base, rsvpDeadlineDate: '2028-02-29' },
      '2028-09-19',
    )).toEqual({});
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-09-20' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'The RSVP deadline must be on or before the event date.' });
    // The deadline may fall on the event date itself.
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-09-19' }, event.eventDate))
      .toEqual({});
  });

  it('reports every blocking field at once, because the payload is atomic', () => {
    expect(validateEventSettings(
      { ...draftFromEvent(event), name: '', eventTimezone: 'nope' },
      event.eventDate,
    )).toEqual({
      name: 'Enter an event name.',
      eventTimezone: 'Choose a valid time zone.',
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --config vitest.config.ts tests/unit/event-settings-draft.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write the module**

Create `src/features/settings/event-settings-draft.ts`:

```ts
import type { EventView } from '../../../shared/contracts';
import { canonicalTimeZone, isIanaTimeZone } from '../../../shared/event-time';

/**
 * The eight general event settings, as the host edits them. The endpoint takes
 * one complete payload, so this is deliberately the whole domain rather than a
 * per-field shape: deadline/time-zone and RSVP/roster are cross-field rules and
 * splitting them would only move the invariants somewhere they are not checked.
 */
export interface EventSettingsDraft {
  name: string;
  welcomeMessage: string;
  eventTimezone: string;
  rsvpDeadlineDate: string;
  rsvpEnabled: boolean;
  uploadsEnabled: boolean;
  galleryVisible: boolean;
  moderationRequired: boolean;
}

export type EventSettingsField = keyof EventSettingsDraft;

export interface EventSettingsPayload extends EventSettingsDraft {
  // The version the draft was built from. The Worker treats it as a stale-view
  // signal and guards its write on the version it reads itself.
  rsvpRosterVersion: number;
}

// Form order, not response order: a status that names the blocking field should
// name the first one the host would reach.
export const EVENT_SETTINGS_FIELDS = [
  'name',
  'welcomeMessage',
  'eventTimezone',
  'rsvpDeadlineDate',
  'rsvpEnabled',
  'uploadsEnabled',
  'galleryVisible',
  'moderationRequired',
] as const satisfies readonly EventSettingsField[];

export const EVENT_SETTINGS_LABELS: Record<EventSettingsField, string> = {
  name: 'Event name',
  welcomeMessage: 'Welcome message',
  eventTimezone: 'Event time zone',
  rsvpDeadlineDate: 'RSVP deadline',
  rsvpEnabled: 'Accept RSVPs',
  uploadsEnabled: 'Accept private photo deliveries',
  galleryVisible: 'Show the optional shared gallery',
  moderationRequired: 'Review notes before sharing',
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * Shape is not enough: `Date.UTC` silently rolls February 31st into March, so
 * the only way to reject an impossible date is to build it and check it came
 * back unchanged. This mirrors `parseCalendarDate` in `shared/event-time.ts`,
 * which is what refuses the same value on the Worker.
 */
function isRealCalendarDate(value: string): boolean {
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const rebuilt = new Date(Date.UTC(year, month - 1, day));
  return rebuilt.getUTCFullYear() === year
    && rebuilt.getUTCMonth() + 1 === month
    && rebuilt.getUTCDate() === day;
}

export function draftFromEvent(event: EventView): EventSettingsDraft {
  return {
    name: event.name,
    welcomeMessage: event.welcomeMessage,
    eventTimezone: event.eventTimezone,
    rsvpDeadlineDate: event.rsvpDeadlineDate ?? '',
    rsvpEnabled: event.rsvpEnabled,
    uploadsEnabled: event.uploadsEnabled,
    galleryVisible: event.galleryVisible,
    moderationRequired: event.moderationRequired,
  };
}

/**
 * The one shape that is ever sent, and the one shape identity is computed from.
 * Canonicalizing here is what lets a raw edit that means nothing — trailing
 * space, lower-cased zone — settle back to `Saved` without a request.
 */
export function canonicalEventSettings(
  draft: EventSettingsDraft,
  rsvpRosterVersion: number,
): EventSettingsPayload {
  return {
    name: draft.name.trim(),
    welcomeMessage: draft.welcomeMessage.trim(),
    eventTimezone: canonicalTimeZone(draft.eventTimezone) ?? draft.eventTimezone,
    rsvpDeadlineDate: draft.rsvpDeadlineDate,
    rsvpEnabled: draft.rsvpEnabled,
    uploadsEnabled: draft.uploadsEnabled,
    galleryVisible: draft.galleryVisible,
    moderationRequired: draft.moderationRequired,
    rsvpRosterVersion,
  };
}

// Fixed key order, so two equivalent payloads always serialize identically.
export function eventSettingsKey(payload: EventSettingsPayload): string {
  return JSON.stringify([
    payload.name,
    payload.welcomeMessage,
    payload.eventTimezone,
    payload.rsvpDeadlineDate,
    payload.rsvpEnabled,
    payload.uploadsEnabled,
    payload.galleryVisible,
    payload.moderationRequired,
    payload.rsvpRosterVersion,
  ]);
}

/**
 * Mirrors the Worker's usable-input rules so an unsendable draft never becomes
 * a request. The Worker repeats every one of them, plus the open-entry and
 * roster rules only it can decide.
 */
export function validateEventSettings(
  draft: EventSettingsDraft,
  eventDate: string,
): Partial<Record<EventSettingsField, string>> {
  const errors: Partial<Record<EventSettingsField, string>> = {};
  const name = draft.name.trim();
  if (name.length === 0) errors.name = 'Enter an event name.';
  else if (name.length > 80) errors.name = 'Use 80 characters or fewer.';

  const welcome = draft.welcomeMessage.trim();
  if (welcome.length === 0) errors.welcomeMessage = 'Enter a welcome message.';
  else if (welcome.length > 500) errors.welcomeMessage = 'Use 500 characters or fewer.';

  if (!isIanaTimeZone(draft.eventTimezone)) errors.eventTimezone = 'Choose a valid time zone.';

  if (!isRealCalendarDate(draft.rsvpDeadlineDate)) {
    errors.rsvpDeadlineDate = 'Choose a valid RSVP deadline.';
  } else if (draft.rsvpDeadlineDate > eventDate) {
    errors.rsvpDeadlineDate = 'The RSVP deadline must be on or before the event date.';
  }
  return errors;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts tests/unit/event-settings-draft.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/event-settings-draft.ts tests/unit/event-settings-draft.test.ts
git commit -m "feat: add the general settings draft, snapshot, and validation"
```

---

### Task 4: The accessible autosave status and Retry control

Both editors report through one component, so the two domains announce themselves distinctly and neither steals focus.

**Files:**
- Create: `src/components/AutosaveStatus.tsx`
- Modify: `src/styles.css` (append after the `.event-appearance-editor__actions` rules near line 210)
- Test: `tests/unit/autosave-status-text.test.ts`

**Interfaces:**
- Consumes: `AutosaveState`, `AutosaveStatus` (type only) from `src/features/settings/autosave-queue.ts`.
- Produces:
  - `autosaveStatusText(label: string, state: AutosaveState, blockingField: { label: string; message: string } | null): { visible: string; announcement: string }`
  - `<AutosaveStatus label={string} state={AutosaveState} blockingField={…} onRetry={() => void} className?={string} />`

- [ ] **Step 1: Write the failing label tests**

Create `tests/unit/autosave-status-text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { autosaveStatusText } from '../../src/components/AutosaveStatus';

const blocking = { label: 'Event name', message: 'Enter an event name.' };

describe('autosave status text', () => {
  it('keeps the visible chip short and the announcement domain-specific', () => {
    expect(autosaveStatusText('Event settings', { status: 'saved', failure: null }, null))
      .toEqual({ visible: 'Saved', announcement: 'Event settings saved' });
    expect(autosaveStatusText('Event appearance', { status: 'saved', failure: null }, null).announcement)
      .toBe('Event appearance saved');
  });

  it('reads scheduled and saving as the same in-progress state', () => {
    const scheduled = autosaveStatusText('Event settings', { status: 'scheduled', failure: null }, null);
    const saving = autosaveStatusText('Event settings', { status: 'saving', failure: null }, null);
    expect(scheduled).toEqual({ visible: 'Saving…', announcement: 'Saving event settings' });
    expect(saving).toEqual(scheduled);
  });

  it('names the blocking field when the draft cannot be sent', () => {
    expect(autosaveStatusText('Event settings', { status: 'invalid', failure: null }, blocking))
      .toEqual({
        visible: 'Fix the highlighted field to save.',
        announcement: 'Event settings can’t save. Event name: Enter an event name.',
      });
  });

  it('falls back to the generic invalid announcement when no field is named', () => {
    expect(autosaveStatusText('Event appearance', { status: 'invalid', failure: null }, null).announcement)
      .toBe('Event appearance can’t save. Fix the highlighted field.');
  });

  it('announces a failure with its domain and its message', () => {
    expect(autosaveStatusText(
      'Event settings',
      { status: 'failed', failure: { message: 'The network dropped.', retryable: true } },
      null,
    )).toEqual({
      visible: 'Couldn’t save.',
      announcement: 'Event settings couldn’t save. The network dropped.',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.config.ts tests/unit/autosave-status-text.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write the component**

Create `src/components/AutosaveStatus.tsx`:

```tsx
import type { AutosaveState } from '../features/settings/autosave-queue';

/**
 * One status surface for both persistence domains. The chip stays short enough
 * to sit beside a heading at 320px; the announcement names its domain, because
 * `Saved` on its own is meaningless when two of these can be live at once.
 */

interface BlockingField {
  label: string;
  message: string;
}

export function autosaveStatusText(
  label: string,
  state: AutosaveState,
  blockingField: BlockingField | null,
): { visible: string; announcement: string } {
  const domain = label.toLowerCase();
  if (state.status === 'invalid') {
    return {
      visible: 'Fix the highlighted field to save.',
      announcement: blockingField
        ? `${label} can’t save. ${blockingField.label}: ${blockingField.message}`
        : `${label} can’t save. Fix the highlighted field.`,
    };
  }
  if (state.status === 'failed') {
    return {
      visible: 'Couldn’t save.',
      announcement: `${label} couldn’t save.${state.failure ? ` ${state.failure.message}` : ''}`,
    };
  }
  if (state.status === 'saved') {
    return { visible: 'Saved', announcement: `${label} saved` };
  }
  return { visible: 'Saving…', announcement: `Saving ${domain}` };
}

interface AutosaveStatusProps {
  label: string;
  state: AutosaveState;
  blockingField?: BlockingField | null;
  onRetry(): void;
  className?: string;
}

export function AutosaveStatus({
  label,
  state,
  blockingField = null,
  onRetry,
  className,
}: AutosaveStatusProps) {
  const { visible, announcement } = autosaveStatusText(label, state, blockingField);
  // Retry is a real button and lives outside the live region: inserting it must
  // not re-announce the message, and a credential or lifecycle failure escalates
  // to the manager's recovery notice rather than offering a repeat that cannot work.
  const retryable = state.status === 'failed' && state.failure?.retryable === true;
  return <div className={className ? `autosave-status ${className}` : 'autosave-status'}>
    <div role="status" aria-live="polite" aria-atomic="true">
      <span className={`autosave-status__chip autosave-status__chip--${state.status}`} aria-hidden="true">
        {visible}
      </span>
      <span className="sr-only">{announcement}</span>
    </div>
    {retryable && <button
      type="button"
      className="autosave-status__retry"
      onClick={onRetry}
    >Retry</button>}
  </div>;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts tests/unit/autosave-status-text.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Add the styles**

In `src/styles.css`, immediately after the `.event-appearance-editor__actions .button { … }` line (about line 210), insert:

```css
.autosave-status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.autosave-status__chip { display: inline-block; width: fit-content; padding: 6px 10px; border-radius: 999px; background: var(--moss-soft); color: #4e5b28; font-size: .75rem; font-weight: 700; }
.autosave-status__chip--scheduled, .autosave-status__chip--saving { background: var(--denim-soft); color: var(--chestnut); }
.autosave-status__chip--invalid, .autosave-status__chip--failed { background: #fff1ee; color: var(--danger); }
.autosave-status__retry { min-width: 44px; min-height: 44px; padding: 8px 14px; border: 1px solid var(--border); border-radius: 7px; background: var(--paper); color: var(--chestnut); font: inherit; font-size: .8rem; font-weight: 700; cursor: pointer; }
.autosave-status__retry:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
```

- [ ] **Step 6: Lint, typecheck, and commit**

Run: `npm run lint && npm run typecheck`
Expected: no errors.

```bash
git add src/components/AutosaveStatus.tsx src/styles.css tests/unit/autosave-status-text.test.ts
git commit -m "feat: add the shared autosave status and retry control"
```

---

### Task 5: Keep Settings mounted and merge mutation responses by ownership

Before any autosave exists, give it somewhere to live: a Settings subtree that survives a destination change, mutation responses that update only the fields they own, and whole-event reads that know when they have been overtaken.

Ownership merges alone are not enough. `refresh`, `refreshIntake` — which polls every five seconds — and `refreshEvent` all replace the event wholesale. Once an autosave can be in flight while the host is looking at another destination, a `GET` opened before a write can land after it, rebase the editor backward onto values the Worker has already replaced, and get those stale values folded into the *next* complete settings payload. So the reads need a guard in the same task as the merges.

**Files:**
- Create: `src/features/settings/event-merge.ts`, `src/features/settings/event-read-guard.ts`
- Modify: `src/pages/ManagerPage.tsx:161-202` (`refresh`), `:204-243` (`refreshIntake`), `:295-302` (`runManagerAction`), `:332-347` (`openSection`), `:349-432` (the mutations and `refreshEvent`), `:629` (the Settings section)
- Modify: `src/components/EventAppearanceEditor.tsx:23-26, 169, 213, 232` (split the saved callback, bracket the writes)
- Modify: `src/styles.css`
- Test: `tests/unit/manager-event-merge.test.ts`, `tests/unit/event-read-guard.test.ts`, `tests/ui/app.test.tsx`

**Interfaces:**
- Consumes: `EventView` from `shared/contracts.ts`.
- Produces:
  - `mergeSettingsResponse(current: EventView, response: EventView): EventView`
  - `mergeThemeResponse(current: EventView, response: EventView): EventView`
  - `mergeCoverResponse(current: EventView, response: EventView): EventView`
  - `createEventReadGuard(): EventReadGuard` with `beginWrite()`, `endWrite()`, `openRead(): number`, `adopt(token: number): boolean`
  - `EventAppearanceEditor` props become `{ event, onThemeSaved(event: EventView): void, onCoverSaved(event: EventView): void, onEventWrite<T>(request: () => Promise<T>): Promise<T> }`.

- [ ] **Step 1: Write the failing merge tests**

Create `tests/unit/manager-event-merge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { EventView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import {
  mergeCoverResponse,
  mergeSettingsResponse,
  mergeThemeResponse,
} from '../../src/features/settings/event-merge';

const candidary = resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} });
const garden = resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} });

const current: EventView = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.', coverObjectKey: 'events/event-a/cover/new.jpg',
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  reservedMediaCount: 0, storedMediaCount: 3, reservedBytes: 0, storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z', createdAt: '2026-07-29T00:00:00Z', deletedAt: null,
  eventTimezone: 'America/Chicago', rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-06T04:59:59.999Z', rsvpDeadlineDate: '2026-09-05',
  rsvpRosterVersion: 7, theme: garden,
};

// What a settings PATCH answered with, built from a view that predates the newer
// theme and cover the host has since confirmed.
const staleElsewhere: EventView = {
  ...current, name: 'Renamed', rsvpEnabled: true, rsvpRosterVersion: 8,
  theme: candidary, coverObjectKey: null,
};

describe('manager event merges', () => {
  it('takes only the settings a settings response owns', () => {
    const merged = mergeSettingsResponse(current, staleElsewhere);
    expect(merged.name).toBe('Renamed');
    expect(merged.rsvpEnabled).toBe(true);
    expect(merged.rsvpRosterVersion).toBe(8);
    expect(merged.theme).toBe(garden);
    expect(merged.coverObjectKey).toBe('events/event-a/cover/new.jpg');
  });

  it('takes only the theme a theme response owns', () => {
    const merged = mergeThemeResponse(current, { ...staleElsewhere, theme: candidary });
    expect(merged.theme).toBe(candidary);
    expect(merged.name).toBe('Maya & Theo');
    expect(merged.rsvpRosterVersion).toBe(7);
    expect(merged.coverObjectKey).toBe('events/event-a/cover/new.jpg');
  });

  it('takes only the cover a cover response owns', () => {
    const merged = mergeCoverResponse(current, staleElsewhere);
    expect(merged.coverObjectKey).toBeNull();
    expect(merged.theme).toBe(garden);
    expect(merged.name).toBe('Maya & Theo');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.config.ts tests/unit/manager-event-merge.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write the merge module**

Create `src/features/settings/event-merge.ts`:

```ts
import type { EventView } from '../../../shared/contracts';

/**
 * Every manager mutation answers with a whole event, and the three writable
 * domains run independently. Adopting a whole response would let a settings
 * write that started before a theme write restore the old theme after it —
 * so each response is allowed to update only the fields it decided.
 */

const SETTINGS_OWNED = [
  'name',
  'welcomeMessage',
  'eventTimezone',
  'rsvpEnabled',
  'rsvpDeadlineAt',
  'rsvpDeadlineDate',
  'rsvpRosterVersion',
  'uploadsEnabled',
  'galleryVisible',
  'moderationRequired',
] as const satisfies readonly (keyof EventView)[];

const THEME_OWNED = ['theme'] as const satisfies readonly (keyof EventView)[];
const COVER_OWNED = ['coverObjectKey'] as const satisfies readonly (keyof EventView)[];

function mergeOwned(
  current: EventView,
  response: EventView,
  owned: readonly (keyof EventView)[],
): EventView {
  const merged = { ...current };
  for (const key of owned) {
    // One assignment per key rather than a spread, so nothing outside the
    // owned list can travel with it.
    (merged as Record<string, unknown>)[key] = response[key];
  }
  return merged;
}

export function mergeSettingsResponse(current: EventView, response: EventView): EventView {
  return mergeOwned(current, response, SETTINGS_OWNED);
}

export function mergeThemeResponse(current: EventView, response: EventView): EventView {
  return mergeOwned(current, response, THEME_OWNED);
}

export function mergeCoverResponse(current: EventView, response: EventView): EventView {
  return mergeOwned(current, response, COVER_OWNED);
}
```

- [ ] **Step 4: Run the merge tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts tests/unit/manager-event-merge.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 4b: Write the failing read-guard tests**

Create `tests/unit/event-read-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createEventReadGuard } from '../../src/features/settings/event-read-guard';

describe('event read guard', () => {
  it('adopts a read that no write overlapped', () => {
    const guard = createEventReadGuard();
    const token = guard.openRead();
    expect(guard.adopt(token)).toBe(true);
  });

  it('drops a read that a write started under', () => {
    const guard = createEventReadGuard();
    const token = guard.openRead();
    guard.beginWrite();
    // The write may commit before this read's answer arrives, and that answer
    // was assembled from a row that is about to move.
    expect(guard.adopt(token)).toBe(false);
  });

  it('drops a read that a write finished under', () => {
    const guard = createEventReadGuard();
    guard.beginWrite();
    const token = guard.openRead();
    guard.endWrite();
    expect(guard.adopt(token)).toBe(false);
  });

  it('adopts a read taken after a write settled, which is the refresh case', () => {
    const guard = createEventReadGuard();
    guard.beginWrite();
    guard.endWrite();
    const token = guard.openRead();
    expect(guard.adopt(token)).toBe(true);
  });

  it('keeps concurrent reads independent', () => {
    const guard = createEventReadGuard();
    const first = guard.openRead();
    const second = guard.openRead();
    expect(guard.adopt(first)).toBe(true);
    guard.beginWrite();
    expect(guard.adopt(second)).toBe(false);
  });
});
```

- [ ] **Step 4c: Write the read guard**

Create `src/features/settings/event-read-guard.ts`:

```ts
/**
 * Whole-event reads and manager writes race. The five-second intake poll can be
 * open when an autosave commits, and its answer — assembled before the write —
 * would arrive afterward and put the row back. Ownership merges cannot help
 * here: a `GET` legitimately owns every field, it is just answering for a row
 * that has moved.
 *
 * So a read is adopted only if nothing wrote while it was open. One counter is
 * enough: a write moves it on the way in and on the way out, and a read that
 * sees a different number than it started with is answering for a version of
 * the row that no longer exists. Dropping a read that would have been fine
 * costs one poll interval; adopting a stale one silently rewrites the host's
 * settings.
 */
export interface EventReadGuard {
  beginWrite(): void;
  endWrite(): void;
  openRead(): number;
  adopt(token: number): boolean;
}

export function createEventReadGuard(): EventReadGuard {
  let epoch = 0;
  const move = () => { epoch += 1; };
  return {
    beginWrite: move,
    endWrite: move,
    openRead: () => epoch,
    adopt: (token) => token === epoch,
  };
}
```

- [ ] **Step 4d: Run the guard tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts tests/unit/event-read-guard.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Write the failing manager tests**

Add to `tests/ui/app.test.tsx`, inside `describe('manager experience', …)`:

```ts
  it('keeps an unsaved Settings edit while the host visits another destination', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    const navigation = screen.getByRole('navigation', { name: 'Manager sections' });

    await user.click(within(navigation).getByRole('button', { name: /settings/i }));
    const name = screen.getByLabelText('Event name');
    await user.clear(name);
    await user.type(name, 'Maya & Theo — Reception');

    await user.click(within(navigation).getByRole('button', { name: /gallery/i }));
    // Mounted but out of the way. `queryByLabelText` deliberately still finds a
    // hidden control, so this has to assert visibility rather than presence.
    expect(screen.getByLabelText('Event name')).not.toBeVisible();
    expect(document.querySelector('.manager-panel[hidden]')).toHaveAttribute('inert');

    await user.click(within(navigation).getByRole('button', { name: /settings/i }));
    expect(screen.getByLabelText('Event name')).toHaveValue('Maya & Theo — Reception');
  });

  it('adopts the settings response without refreshing the whole manager', async () => {
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    const settingsResponse = {
      ...MANAGED_EVENT,
      name: 'Renamed',
      rsvpRosterVersion: 8,
      // A settings response is built from whatever the row said when it committed,
      // so it may carry a theme older than the one already on screen.
      theme: resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} }),
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        return json({ event: settingsResponse });
      }
      return fetchMock(input, init);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /settings/i }));

    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Renamed'));
    const after = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    // One PATCH, and no five-request manager refresh behind it.
    expect(after - before).toBe(1);
    // The stale theme in that response must not travel with the settings it owns.
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#4a2415' });
  });

  it('drops a whole-event read that a later write overtook', async () => {
    const gardenTheme = resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} });
    let releaseRead: (() => void) | null = null;
    let reads = 0;
    const fetchMock = managerFetch({ first: { media: makeMedia(1), nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/manage/events/event-a') && method === 'GET') {
        reads += 1;
        // Hold the read that a manager action opened, so a theme write can
        // commit underneath it. It answers with the pre-write row.
        if (reads === 2) await new Promise<void>((resolve) => { releaseRead = resolve; });
        return json({ event: MANAGED_EVENT });
      }
      if (url.includes('/media/') && method === 'PATCH') return json({ media: {} });
      if (url.endsWith('/theme') && method === 'PUT') {
        return json({ event: { ...MANAGED_EVENT, theme: gardenTheme } });
      }
      return fetchMock(input, init);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    const navigation = screen.getByRole('navigation', { name: 'Manager sections' });

    await user.click(within(navigation).getByRole('button', { name: /gallery/i }));
    await user.click(await screen.findByRole('button', { name: /^Publish / }));
    await waitFor(() => expect(reads).toBe(2));

    await user.click(within(navigation).getByRole('button', { name: /settings/i }));
    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await user.click(screen.getByRole('button', { name: 'Save appearance' }));
    await waitFor(() => expect(screen.getByTestId('event-appearance-preview'))
      .toHaveStyle({ '--event-primary': '#245c46' }));

    releaseRead!();
    // The overtaken read carries the pre-write theme. Adopting it would put the
    // old appearance back and then feed it into the next complete write.
    await waitFor(() => expect(screen.getByTestId('event-appearance-preview'))
      .toHaveStyle({ '--event-primary': '#245c46' }));
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#245c46' });
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t 'another destination'`
Expected: FAIL — the field is gone after switching back, because the section unmounts.

Run: `npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t 'without refreshing the whole manager'`
Expected: FAIL — five extra requests, and the heading updates only after the refresh.

- [ ] **Step 7: Split the appearance editor's saved callback**

In `src/components/EventAppearanceEditor.tsx`, replace the props interface:

```tsx
interface EventAppearanceEditorProps {
  event: EventView;
  // Two callbacks rather than one: the theme write and the cover writes are
  // separate domains, and the manager may not adopt either response wholesale.
  onThemeSaved(event: EventView): void;
  onCoverSaved(event: EventView): void;
  // Brackets a write so a whole-event read cannot be adopted across it.
  onEventWrite<T>(request: () => Promise<T>): Promise<T>;
}
```

Update the destructuring to `export function EventAppearanceEditor({ event, onThemeSaved, onCoverSaved, onEventWrite }: EventAppearanceEditorProps) {`, then change the three call sites: `onEventSaved(result.event)` inside `save()` becomes `onThemeSaved(result.event)`; both `onEventSaved(result.event)` calls inside `uploadCover()` and `removeCover()` become `onCoverSaved(result.event)`.

Wrap each of the three writes in the bracket. In `save()`, `uploadCover()`, and `removeCover()`, the whole request sequence goes inside — for the cover that includes the presign, the direct `PUT`, and the finalize, because the row does not change until the last of them:

```tsx
      const result = await onEventWrite(async () => {
        const upload = await api<{ objectKey: string; url: string }>(…);
        const transferred = await fetch(upload.url, { … });
        if (!transferred.ok) throw new Error('Cover transfer failed.');
        return api<{ event: EventView }>(`/api/manage/events/${event.id}/cover/finalize`, { … });
      });
```

In the manager, pass `onEventWrite={eventWrite}` to `<EventAppearanceEditor>`.

In `tests/ui/event-appearance-editor.test.tsx`, replace every `onEventSaved={…}` prop with `onThemeSaved={…} onCoverSaved={…} onEventWrite={(request) => request()}`, giving each callback its own `vi.fn()` where the test asserts on it. All three props are required, so this is a compile error until every render site is updated.

- [ ] **Step 8: Rewrite the manager's settings save and section mounting**

In `src/pages/ManagerPage.tsx`:

Add to the imports:

```tsx
import {
  mergeCoverResponse,
  mergeSettingsResponse,
  mergeThemeResponse,
} from '../features/settings/event-merge';
import { createEventReadGuard } from '../features/settings/event-read-guard';
```

Add the guard beside the other refs, with the one helper every event-changing write goes through:

```tsx
  // Reads and writes of the event row overlap once autosave can be running
  // behind another destination. Every write brackets itself here, and every
  // whole-event read checks whether it was overtaken before it is adopted.
  const eventReads = useRef(createEventReadGuard());
  const eventWrite = useCallback(async <T,>(request: () => Promise<T>): Promise<T> => {
    eventReads.current.beginWrite();
    try {
      return await request();
    } finally {
      eventReads.current.endWrite();
    }
  }, []);
```

Guard the event half of all three whole-event reads. In `refresh`, take the token immediately before the `Promise.all` and gate only `setEvent`:

```tsx
      const readToken = eventReads.current.openRead();
      const [eventData, mediaData, messageData, exportData, linkData] = await Promise.all([…]);
      // Media, notes, exports, and the link are unaffected by a settings or
      // theme write, so only the event itself is at risk of being put back.
      if (eventReads.current.adopt(readToken)) setEvent(eventData.event);
```

Do the same in `refreshIntake` — take the token before its `Promise.all`, and wrap its `setEvent(eventData.event)` in the same check — and in `refreshEvent`:

```tsx
  async function refreshEvent() {
    const readToken = eventReads.current.openRead();
    const loaded = await api<{ event: EventView }>(`/api/manage/events/${eventId}`);
    if (eventReads.current.adopt(readToken)) setEvent(loaded.event);
  }
```

Bracket every ManagerPage mutation that can change the event row, so the `refresh()` each one runs afterward is taken *after* the write and is therefore adopted. In `bulk`, `changePublication`, `moderateMessage`, `prepareExport`, `downloadExport`, `retryExport`, and `runEntryAction`, wrap the `api(…)` call — and only that call, never the following `refresh()` — as:

```tsx
    await eventWrite(() => api(`/api/manage/events/${eventId}/media/bulk`, {
      method: 'POST', body: JSON.stringify({ ids, action, expectedStatus }),
    }));
```

Replace `saveSettings` with:

```tsx
  async function saveSettings(element: HTMLFormElement) {
    const form = new FormData(element);
    const result = await api<{ event: EventView }>(`/api/manage/events/${eventId}/settings`, {
      method: 'PATCH', body: JSON.stringify({
        name: form.get('name'),
        welcomeMessage: form.get('welcomeMessage'),
        uploadsEnabled: form.get('uploadsEnabled') === 'on',
        galleryVisible: form.get('galleryVisible') === 'on',
        moderationRequired: form.get('moderationRequired') === 'on',
        eventTimezone: form.get('eventTimezone'),
        rsvpDeadlineDate: form.get('rsvpDeadlineDate'),
        rsvpEnabled: form.get('rsvpEnabled') === 'on',
        // The version this form was built from. The server treats it as a stale-view
        // signal and guards the write on what it reads itself.
        rsvpRosterVersion: event?.rsvpRosterVersion ?? 0,
      }),
    });
    // One settings mutation confirms one settings mutation. Reloading media,
    // notes, exports, and the entry to learn a new event name was five requests
    // spent on answers this response already carries.
    setEvent((current) => current ? mergeSettingsResponse(current, result.event) : result.event);
  }
```

and wrap its `api` call in `eventWrite(() => …)` like the others.

Add the mounted-once flag beside the other `useState` declarations:

```tsx
  // Settings stays mounted after its first visit so a debounce timer, an
  // in-flight write, and an unsaved draft all survive a destination change.
  // It is hidden from layout and the accessibility tree rather than unmounted.
  const [settingsMounted, setSettingsMounted] = useState(false);
```

and set it in `openSection`, immediately after `setSection(next)`:

```tsx
    if (next === 'settings') setSettingsMounted(true);
```

- [ ] **Step 9: Render the Settings subtree as a persistent, hidden-when-inactive section**

Replace the whole `{section === 'settings' && <section className="manager-panel">…</section>}` expression at `src/pages/ManagerPage.tsx:629` with:

```tsx
      {settingsMounted && <section className="manager-panel" hidden={section !== 'settings'} inert={section !== 'settings'}>
        <p className="section-label">Event controls</p>
        <h2>Settings</h2>
        <form className="settings-form" onSubmit={(formEvent) => { formEvent.preventDefault(); const element = formEvent.currentTarget; void runManagerAction(() => saveSettings(element)); }}>
          <label>Event name<input name="name" defaultValue={event.name} /></label>
          <label>Welcome message<textarea name="welcomeMessage" rows={4} defaultValue={event.welcomeMessage} /></label>
          <label>Event time zone<input name="eventTimezone" defaultValue={event.eventTimezone} required autoComplete="off" spellCheck={false} /></label>
          <label>RSVP deadline<input name="rsvpDeadlineDate" type="date" defaultValue={event.rsvpDeadlineDate ?? ''} required /></label>
          <label className="toggle"><input type="checkbox" name="rsvpEnabled" defaultChecked={event.rsvpEnabled} /><span>Accept RSVPs</span></label>
          <label className="toggle"><input type="checkbox" name="uploadsEnabled" defaultChecked={event.uploadsEnabled} /><span>Accept private photo deliveries</span></label>
          <label className="toggle"><input type="checkbox" name="galleryVisible" defaultChecked={event.galleryVisible} /><span>Show the optional shared gallery</span></label>
          <label className="toggle"><input type="checkbox" name="moderationRequired" defaultChecked={event.moderationRequired} /><span>Review notes before sharing</span></label>
          <button className="button button--primary">Save settings</button>
        </form>
        <EventAppearanceEditor
          key={event.id}
          event={event}
          onEventWrite={eventWrite}
          onThemeSaved={(updated) => setEvent((current) => current ? mergeThemeResponse(current, updated) : updated)}
          onCoverSaved={(updated) => setEvent((current) => current ? mergeCoverResponse(current, updated) : updated)}
        />
        <EventAccountCard eventId={event.id} />
        <section className="manager-credential" aria-labelledby="manager-credential-title">
          <h3 id="manager-credential-title">Manager access</h3>
          <p>Rotating issues a new management link and stops this one immediately. It does not change the printed event QR.</p>
          <button type="button" className="button button--secondary" onClick={() => void runManagerAction(rotateManagerLink)}>Rotate manager link</button>
        </section>
        <div className="danger-zone">
          <h3>Delete this event</h3>
          <p>Type <strong>{event.name}</strong> to revoke both links and permanently remove every file.</p>
          <form onSubmit={(formEvent) => { formEvent.preventDefault(); const element = formEvent.currentTarget; void runManagerAction(() => deleteEvent(element)); }}>
            <input name="confirmation" aria-label="Confirm event name" autoComplete="off" />
            <button className="button button--danger-outline"><Trash2 aria-hidden="true" /> Delete event</button>
          </form>
        </div>
      </section>}
```

Add to `src/styles.css`, next to the `.manager-panel` rule (about line 183):

```css
/* A hidden destination must not merely be transparent: it keeps its DOM so its
   timers and drafts survive, and must take no space and no tab stop. */
.manager-panel[hidden] { display: none; }
```

- [ ] **Step 10: Run the manager tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts tests/ui/app.test.tsx tests/ui/event-appearance-editor.test.tsx`
Expected: PASS.

- [ ] **Step 11: Lint, typecheck, and commit**

Run: `npm run lint && npm run typecheck && npm run test:unit`
Expected: PASS.

```bash
git add src/features/settings/event-merge.ts src/pages/ManagerPage.tsx src/components/EventAppearanceEditor.tsx src/styles.css tests/unit/manager-event-merge.test.ts tests/ui/app.test.tsx tests/ui/event-appearance-editor.test.tsx
git commit -m "refactor: keep Settings mounted and merge manager responses by ownership"
```

---

### Task 6: The autosaving general-settings editor

**Files:**
- Create: `src/components/EventSettingsEditor.tsx`
- Modify: `src/pages/ManagerPage.tsx` (replace the inline settings form, drop `saveSettings`)
- Modify: `src/styles.css`
- Test: `tests/ui/event-settings-editor.test.tsx`, `tests/ui/app.test.tsx`

**Interfaces:**
- Consumes: `createAutosaveQueue`, `AutosaveState`, `AutosaveHandle`, `DomainAutosaveState`, `AutosaveFailure` from `src/features/settings/autosave-queue.ts`; every export of `src/features/settings/event-settings-draft.ts`; `AutosaveStatus` from `src/components/AutosaveStatus.tsx`; `describeLoadFailure` from `src/components/States.tsx`; `api`, `ClientApiError` from `src/app/api.ts`; `mergeSettingsResponse` from `src/features/settings/event-merge.ts` (in the manager, not the editor).
- Produces: `<EventSettingsEditor event={EventView} onSettingsSaved={(event: EventView) => void} onAutosaveStateChange={(state: DomainAutosaveState) => void} ref={Ref<AutosaveHandle>} />`. The manager must mount it with `key={event.id}`.

- [ ] **Step 1: Write the failing editor tests**

Create `tests/ui/event-settings-editor.test.tsx`:

```tsx
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
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
function Harness({ initial = EVENT, rosterVersion }: { initial?: EventView; rosterVersion?: number }) {
  const [event, setEvent] = useState(initial);
  const [state, setState] = useState<DomainAutosaveState | null>(null);
  // `rosterVersion` stands in for an RSVP-destination mutation on the same page:
  // the manager pushes a new version down without remounting the editor.
  const applied = rosterVersion === undefined ? event : { ...event, rsvpRosterVersion: rosterVersion };
  return <>
    <EventSettingsEditor
      key={event.id}
      event={applied}
      onEventWrite={(request) => request()}
      onSettingsSaved={(updated) => setEvent((current) => mergeSettingsResponse(current, updated))}
      onAutosaveStateChange={setState}
    />
    <output data-testid="domain-state">{state ? `${state.domain}:${state.status}` : 'none'}</output>
  </>;
}

function settingsWrites() {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
  return calls
    .filter(([input, init]) => String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

function typist() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
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

  it('saves a toggle immediately and sends the complete payload', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ event: { ...EVENT, galleryVisible: false } })));
    const user = typist();
    render(<Harness />);

    await user.click(screen.getByLabelText('Show the optional shared gallery'));

    await waitFor(() => expect(settingsWrites()).toHaveLength(1));
    expect(settingsWrites()[0]).toEqual({
      name: 'Maya & Theo', welcomeMessage: 'Welcome.', eventTimezone: 'America/Chicago',
      rsvpDeadlineDate: '2026-09-05', rsvpEnabled: false, uploadsEnabled: true,
      galleryVisible: false, moderationRequired: true, rsvpRosterVersion: 7,
    });
    await waitFor(() => expect(screen.getByTestId('domain-state')).toHaveTextContent('settings:saved'));
  });

  it('debounces typing into one request and flushes on blur', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ event: { ...EVENT, name: 'Reception' } })));
    const user = typist();
    render(<Harness />);
    const name = screen.getByLabelText('Event name');

    await user.clear(name);
    await user.type(name, 'Reception');
    expect(settingsWrites()).toHaveLength(0);
    expect(screen.getByText('Saving event settings')).toBeInTheDocument();

    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    await waitFor(() => expect(settingsWrites()).toHaveLength(1));
    expect(settingsWrites()[0]!.name).toBe('Reception');

    await user.clear(name);
    await user.type(name, 'Ceremony');
    await user.tab();
    // Blur does not wait out the rest of the window.
    await waitFor(() => expect(settingsWrites()).toHaveLength(2));
    expect(settingsWrites()[1]!.name).toBe('Ceremony');
  });

  it('normalizes a canonically equivalent edit on blur without a request', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ event: EVENT })));
    const user = typist();
    render(<Harness />);
    const name = screen.getByLabelText('Event name');

    await user.type(name, '   ');
    await user.tab();

    expect(name).toHaveValue('Maya & Theo');
    expect(settingsWrites()).toHaveLength(0);
    expect(screen.getByText('Event settings saved')).toBeInTheDocument();
  });

  it('sends nothing while the complete draft is invalid and names the blocking field', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ event: EVENT })));
    const user = typist();
    render(<Harness />);

    await user.clear(screen.getByLabelText('Event name'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);

    expect(settingsWrites()).toHaveLength(0);
    expect(screen.getByLabelText('Event name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Event name')).toHaveAccessibleDescription('Enter an event name.');
    expect(screen.getByText('Event settings can’t save. Event name: Enter an event name.')).toBeInTheDocument();

    // The payload is atomic, so one bad field holds back an otherwise fine toggle.
    await user.click(screen.getByLabelText('Review notes before sharing'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(settingsWrites()).toHaveLength(0);

    await user.type(screen.getByLabelText('Event name'), 'Reception');
    await user.tab();
    await waitFor(() => expect(settingsWrites()).toHaveLength(1));
    expect(settingsWrites()[0]).toMatchObject({ name: 'Reception', moderationRequired: false });
  });

  it('adopts server normalization without overwriting a newer draft', async () => {
    let release: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      // The Worker trimmed what it was sent; the host has typed on since.
      return json({ event: { ...EVENT, name: 'Reception' } });
    }));
    const user = typist();
    render(<Harness />);
    const name = screen.getByLabelText('Event name');

    await user.clear(name);
    await user.type(name, '  Reception  ');
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    await waitFor(() => expect(settingsWrites()).toHaveLength(1));

    await user.clear(name);
    await user.type(name, 'Ceremony');
    release!();

    await waitFor(() => expect(settingsWrites()).toHaveLength(2));
    expect(name).toHaveValue('Ceremony');
    expect(settingsWrites()[1]!.name).toBe('Ceremony');
  });

  it('keeps the draft and offers Retry when a save fails for a reason that can pass', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    const user = typist();
    render(<Harness />);

    await user.clear(screen.getByLabelText('Event name'));
    await user.type(screen.getByLabelText('Event name'), 'Reception');
    await user.tab();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible());
    expect(screen.getByLabelText('Event name')).toHaveValue('Reception');
    expect(screen.getByTestId('domain-state')).toHaveTextContent('settings:failed');

    vi.stubGlobal('fetch', vi.fn(() => json({ event: { ...EVENT, name: 'Reception' } })));
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Event settings saved')).toBeInTheDocument());
  });

  it('turns a current server field error into invalid state with no Retry', async () => {
    vi.stubGlobal('fetch', vi.fn(() => errorJson({
      code: 'VALIDATION_FAILED', message: 'Check the event settings.',
      fieldErrors: { rsvpDeadlineDate: 'The RSVP deadline must be on or before the event date.' },
      requestId: 'request-a',
    }, 422)));
    const user = typist();
    render(<Harness />);

    await user.click(screen.getByLabelText('Accept RSVPs'));
    // The host has moved on to another field while the refusal is in flight.
    screen.getByLabelText('Event name').focus();

    await waitFor(() => expect(screen.getByLabelText('RSVP deadline'))
      .toHaveAccessibleDescription('The RSVP deadline must be on or before the event date.'));
    // A background refusal announces itself; it does not take the caret away
    // from whatever the host is typing in.
    expect(screen.getByLabelText('Event name')).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByTestId('domain-state')).toHaveTextContent('settings:invalid');
    // Editing an unrelated field cannot clear a refusal about this one.
    await user.click(screen.getByLabelText('Review notes before sharing'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);
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
    const user = typist();
    render(<Harness />);

    await user.click(screen.getByLabelText('Accept RSVPs'));

    await waitFor(() => expect(settingsWrites()).toHaveLength(2));
    expect(settingsWrites()[0]!.rsvpRosterVersion).toBe(7);
    // The second attempt carries the version the refresh reported, and the
    // host's intent survives it.
    expect(settingsWrites()[1]).toMatchObject({ rsvpRosterVersion: 9, rsvpEnabled: true });
    await waitFor(() => expect(screen.getByText('Event settings saved')).toBeInTheDocument());
    expect(screen.getByLabelText('Accept RSVPs')).toBeChecked();
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
    const user = typist();
    render(<Harness />);
    const status = screen.getByTestId('domain-state');
    const observer = new MutationObserver(() => { announced.push(status.textContent ?? ''); });
    observer.observe(status, { childList: true, characterData: true, subtree: true });

    await user.click(screen.getByLabelText('Accept RSVPs'));
    await waitFor(() => expect(settingsWrites()).toHaveLength(2));

    // Nothing has committed yet, so nothing may have claimed it did.
    expect(announced).not.toContain('settings:saved');
    releaseRetry!();
    await waitFor(() => expect(screen.getByText('Event settings saved')).toBeInTheDocument());
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
    const user = typist();
    render(<Harness />);

    await user.click(screen.getByLabelText('Accept RSVPs'));

    await waitFor(() => expect(screen.getByLabelText('Accept RSVPs'))
      .toHaveAccessibleDescription('Add a guest list before accepting RSVPs.'));
    // No version moved, so repeating the write would be refused identically.
    expect(settingsWrites()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Accept RSVPs')).toBeChecked();
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
    const user = typist();
    const view = render(<Harness />);

    await user.click(screen.getByLabelText('Accept RSVPs'));
    await waitFor(() => expect(screen.getByLabelText('Accept RSVPs')).toHaveAccessibleDescription(
      'Add a guest list before accepting RSVPs.',
    ));

    // The host repairs the roster in the RSVP destination, which advances the version.
    repaired = true;
    view.rerender(<Harness rosterVersion={8} />);

    await waitFor(() => expect(settingsWrites()).toHaveLength(2));
    expect(settingsWrites()[1]).toMatchObject({ rsvpEnabled: true, rsvpRosterVersion: 8 });
  });

  it('escalates a dead credential instead of offering a futile Retry', async () => {
    vi.stubGlobal('fetch', vi.fn(() => errorJson({
      code: 'SESSION_EXPIRED', message: 'This session has expired.', requestId: 'request-a',
    }, 401)));
    const user = typist();
    render(<Harness />);

    await user.click(screen.getByLabelText('Review notes before sharing'));

    await waitFor(() => expect(screen.getByTestId('domain-state')).toHaveTextContent('settings:failed'));
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('flushes on Enter in a single-line field without submitting the page', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({ event: { ...EVENT, name: 'Reception' } })));
    const user = typist();
    render(<Harness />);
    const submitted = vi.fn();
    screen.getByLabelText('Event name').closest('form')!.addEventListener('submit', submitted);

    await user.clear(screen.getByLabelText('Event name'));
    await user.type(screen.getByLabelText('Event name'), 'Reception{Enter}');

    await waitFor(() => expect(settingsWrites()).toHaveLength(1));
    expect(submitted).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --config vitest.config.ts tests/ui/event-settings-editor.test.tsx`
Expected: FAIL — `Failed to resolve import "../../src/components/EventSettingsEditor"`.

- [ ] **Step 3: Write the editor's state and queue wiring**

Create `src/components/EventSettingsEditor.tsx` with everything above the returned JSX:

```tsx
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { KeyboardEvent, Ref } from 'react';

import type { EventView } from '../../shared/contracts';
import { api, ClientApiError } from '../app/api';
import {
  createAutosaveQueue,
  type AutosaveFailure,
  type AutosaveHandle,
  type AutosaveQueue,
  type AutosaveState,
  type DomainAutosaveState,
} from '../features/settings/autosave-queue';
import {
  canonicalEventSettings,
  draftFromEvent,
  eventSettingsKey,
  EVENT_SETTINGS_FIELDS,
  EVENT_SETTINGS_LABELS,
  validateEventSettings,
  type EventSettingsDraft,
  type EventSettingsField,
  type EventSettingsPayload,
} from '../features/settings/event-settings-draft';
import { AutosaveStatus } from './AutosaveStatus';
import { describeLoadFailure } from './States';

const DOMAIN_LABEL = 'Event settings';

/** A roster race that has already been refused twice for the same intent. It is
 *  something the host can retry by hand, not a field they can fix, so it must
 *  not become a field error and must not re-enqueue itself. */
class RosterRaceExhausted extends Error {
  constructor(readonly refusal: ClientApiError) { super(refusal.message); }
}

interface ServerFieldError {
  message: string;
  // The edit generation of the field this error names. A later edit of *that*
  // field retires it; editing anything else must not.
  generation: number;
  // Set for the RSVP refusal, which the roster version owns rather than the
  // control the host can see. A newer version retires it and revalidates.
  rosterVersion: number | null;
}

interface EditorState {
  confirmed: EventSettingsDraft;
  rosterVersion: number;
  draft: EventSettingsDraft;
  generations: Record<EventSettingsField, number>;
  serverErrors: Partial<Record<EventSettingsField, ServerFieldError>>;
}

function zeroGenerations(): Record<EventSettingsField, number> {
  return {
    name: 0, welcomeMessage: 0, eventTimezone: 0, rsvpDeadlineDate: 0,
    rsvpEnabled: 0, uploadsEnabled: 0, galleryVisible: 0, moderationRequired: 0,
  };
}

function initialState(event: EventView): EditorState {
  const confirmed = draftFromEvent(event);
  return {
    confirmed,
    rosterVersion: event.rsvpRosterVersion,
    draft: confirmed,
    generations: zeroGenerations(),
    serverErrors: {},
  };
}

function liveServerErrors(state: EditorState): Partial<Record<EventSettingsField, string>> {
  const live: Partial<Record<EventSettingsField, string>> = {};
  for (const field of EVENT_SETTINGS_FIELDS) {
    const error = state.serverErrors[field];
    if (!error) continue;
    if (error.generation !== state.generations[field]) continue;
    if (error.rosterVersion !== null && error.rosterVersion !== state.rosterVersion) continue;
    live[field] = error.message;
  }
  return live;
}

function editorErrors(
  state: EditorState,
  eventDate: string,
): Partial<Record<EventSettingsField, string>> {
  return { ...validateEventSettings(state.draft, eventDate), ...liveServerErrors(state) };
}

function baselineKeyOf(state: EditorState): string {
  return eventSettingsKey(canonicalEventSettings(state.confirmed, state.rosterVersion));
}

// Newly confirmed values are adopted wherever the host has not moved on. A
// dirty field stays theirs until it saves — that is what makes a same-page RSVP
// mutation safe to absorb without an avoidable stale write.
function rebaseDraft(state: EditorState, incoming: EventSettingsDraft): EventSettingsDraft {
  const next = { ...state.draft };
  for (const field of EVENT_SETTINGS_FIELDS) {
    if (state.draft[field] === state.confirmed[field]) {
      (next as Record<string, unknown>)[field] = incoming[field];
    }
  }
  return next;
}

interface EventSettingsEditorProps {
  event: EventView;
  onSettingsSaved(event: EventView): void;
  onAutosaveStateChange(state: DomainAutosaveState): void;
  // Brackets a write so a whole-event read cannot be adopted across it.
  onEventWrite<T>(request: () => Promise<T>): Promise<T>;
  ref?: Ref<AutosaveHandle>;
}

export function EventSettingsEditor({
  event, onSettingsSaved, onAutosaveStateChange, onEventWrite, ref,
}: EventSettingsEditorProps) {
  const [state, setState] = useState<EditorState>(() => initialState(event));
  const [autosave, setAutosave] = useState<AutosaveState>({ status: 'saved', failure: null });
  // Everything the queue's callbacks read has to be readable synchronously from
  // a promise continuation, so state is mirrored rather than closed over.
  const stateRef = useRef(state);
  const queueRef = useRef<AutosaveQueue<EventSettingsPayload> | null>(null);
  // The queue is built once, so anything it closes over has to be read through
  // a ref or it would keep calling the first render's props forever.
  const savedRef = useRef(onSettingsSaved);
  savedRef.current = onSettingsSaved;
  // One automatic race retry per intent. A roster that keeps moving becomes a
  // visible failure rather than a loop.
  const raceRef = useRef<{ intent: string; races: number } | null>(null);
  // Event id and date are fixed for a mounted editor: the manager keys it by id.
  const eventId = event.id;
  const eventDate = event.eventDate;

  function intentKeyOf(payload: EventSettingsPayload): string {
    return eventSettingsKey({ ...payload, rsvpRosterVersion: 0 });
  }

  async function sendSettings(payload: EventSettingsPayload): Promise<AutosaveOutcome> {
    try {
      const result = await onEventWrite(() => api<{ event: EventView }>(
        `/api/manage/events/${eventId}/settings`,
        { method: 'PATCH', body: JSON.stringify(payload) },
      ));
      raceRef.current = null;
      savedRef.current(result.event);
      // The stored form, read back from the Worker: it canonicalizes the time
      // zone and may return a roster version this payload did not carry.
      return {
        status: 'confirmed',
        key: eventSettingsKey(canonicalEventSettings(
          draftFromEvent(result.event),
          result.event.rsvpRosterVersion,
        )),
      };
    } catch (caught) {
      if (!(caught instanceof ClientApiError) || caught.code !== 'RSVP_ROSTER_INVALID') throw caught;
      // One read decides which kind of refusal this is. A version that moved is
      // a race worth rebasing; the same version is a roster that cannot open at
      // all, and repeating the write would be refused identically.
      const refreshed = await api<{ event: EventView }>(`/api/manage/events/${eventId}`);
      savedRef.current(refreshed.event);
      if (refreshed.event.rsvpRosterVersion === payload.rsvpRosterVersion) throw caught;
      const intent = intentKeyOf(payload);
      const seen = raceRef.current?.intent === intent ? raceRef.current.races : 0;
      raceRef.current = { intent, races: seen + 1 };
      if (seen >= 1) throw new RosterRaceExhausted(caught);
      // Nothing was written. The refreshed version arrives as a prop, and the
      // reconciliation effect rebases the dirty intent onto it and enqueues the
      // retry — doing it here as well would send the same change twice. Saying
      // `rebased` rather than returning quietly is what stops the queue from
      // advancing its baseline and announcing a `Saved` that never happened.
      return { status: 'rebased' };
    }
  }

  function describeFailure(error: unknown): AutosaveFailure {
    if (error instanceof RosterRaceExhausted) {
      return { message: error.refusal.message, retryable: true };
    }
    if (error instanceof ClientApiError && error.fieldErrors) {
      // A refusal about named fields is not something Retry can help with. It is
      // recorded against the generations it was refused at and shown on the
      // fields themselves, which is what makes the domain invalid.
      const current = stateRef.current;
      const recorded: Partial<Record<EventSettingsField, ServerFieldError>> = {};
      for (const field of EVENT_SETTINGS_FIELDS) {
        const message = error.fieldErrors[field];
        if (!message) continue;
        recorded[field] = {
          message,
          generation: current.generations[field],
          rosterVersion: error.code === 'RSVP_ROSTER_INVALID' ? current.rosterVersion : null,
        };
      }
      if (Object.keys(recorded).length > 0) {
        apply({ ...current, serverErrors: { ...current.serverErrors, ...recorded } }, 'silent');
        return { message: error.message, retryable: false };
      }
    }
    const failure = describeLoadFailure(error, 'manager', 'These settings could not be saved.');
    // A revoked credential or an ended event cannot be fixed by repeating the
    // request, so it goes to the manager's recovery notice instead of Retry.
    return failure.kind === 'retry'
      ? { message: failure.message, retryable: true }
      : { message: failure.message, retryable: false, escalation: failure };
  }

  if (queueRef.current === null) {
    queueRef.current = createAutosaveQueue<EventSettingsPayload>({
      baselineKey: baselineKeyOf(stateRef.current),
      save: (snapshot) => sendSettings(snapshot),
      describeFailure: (error) => describeFailure(error),
      onChange: setAutosave,
    });
  }
  const queue = queueRef.current;

  // `'silent'` records state without touching the queue: `describeFailure` runs
  // inside the queue's own settle path, and re-entering it there would decide
  // the next request before this one has finished being classified.
  function apply(next: EditorState, mode: 'enqueue' | 'immediate' | 'silent') {
    stateRef.current = next;
    setState(next);
    if (mode === 'silent') return;
    const errors = editorErrors(next, eventDate);
    const payload = canonicalEventSettings(next.draft, next.rosterVersion);
    queue.submit(
      {
        key: eventSettingsKey(payload),
        // Every general setting is a controlled value, so what the host can see
        // is the draft itself plus whichever server errors are still live.
        intent: JSON.stringify([next.draft, Object.entries(errors).sort()]),
        snapshot: Object.keys(errors).length > 0 ? null : payload,
      },
      mode === 'immediate',
    );
  }

  function edit<K extends EventSettingsField>(
    field: K,
    value: EventSettingsDraft[K],
    mode: 'enqueue' | 'immediate',
  ) {
    const current = stateRef.current;
    apply({
      ...current,
      draft: { ...current.draft, [field]: value },
      generations: { ...current.generations, [field]: current.generations[field] + 1 },
    }, mode);
  }

  useEffect(() => () => { queue.dispose(); }, [queue]);

  useEffect(() => {
    const current = stateRef.current;
    const incoming = draftFromEvent(event);
    const next: EditorState = {
      confirmed: incoming,
      rosterVersion: event.rsvpRosterVersion,
      draft: rebaseDraft(current, incoming),
      generations: current.generations,
      serverErrors: current.serverErrors,
    };
    const baseline = baselineKeyOf(next);
    const unchanged = baseline === baselineKeyOf(current)
      && eventSettingsKey(canonicalEventSettings(next.draft, next.rosterVersion))
        === eventSettingsKey(canonicalEventSettings(current.draft, current.rosterVersion));
    if (unchanged) return;
    // The confirmed value moved, so the baseline moves with it before anything
    // is judged equivalent to it.
    queue.adoptBaseline(baseline);
    const exhausted = raceRef.current !== null && raceRef.current.races >= 2;
    apply(next, exhausted ? 'silent' : 'enqueue');
  }, [event, queue]);

  const errors = editorErrors(state, eventDate);
  const blockingName = EVENT_SETTINGS_FIELDS.find((field) => errors[field]);
  const blockingField = blockingName
    ? { label: EVENT_SETTINGS_LABELS[blockingName], message: errors[blockingName]! }
    : null;

  // Server field errors are recorded from inside the queue's settle path, which
  // must not re-enter it. This is where the domain learns it can no longer send,
  // so a refusal about a named field reads as `invalid` rather than `failed`.
  // Resubmitting the same unsendable key is a no-op, so this is safe to repeat.
  const blockedKey = blockingName
    ? eventSettingsKey(canonicalEventSettings(state.draft, state.rosterVersion))
    : null;
  useEffect(() => {
    if (blockedKey === null) return;
    queue.submit({
      key: blockedKey,
      intent: JSON.stringify([state.draft, Object.entries(errors).sort()]),
      snapshot: null,
    });
    // `state` and `errors` are deliberately not dependencies: this exists only
    // to tell the queue the domain became unsendable, and rerunning it on every
    // keystroke would fight `apply`. (The repository lints with
    // `eslint.configs.recommended` and `tseslint.configs.recommended` only, so
    // there is no exhaustive-deps rule to suppress here — do not add a disable
    // comment for one, because unused disable directives fail `--max-warnings=0`.)
  }, [blockedKey, queue]);

  useEffect(() => {
    onAutosaveStateChange({
      domain: 'settings',
      label: DOMAIN_LABEL,
      status: autosave.status,
      failure: autosave.failure,
      blockingField,
    });
  }, [autosave, blockingField?.label, blockingField?.message, onAutosaveStateChange]);

  useImperativeHandle(ref, () => ({ flush: () => { queue.flush(); } }), [queue]);
```

- [ ] **Step 4: Write the editor's markup**

Append to the same file:

```tsx
  function describedBy(field: EventSettingsField) {
    return errors[field] ? `settings-${field}-error` : undefined;
  }

  function fieldError(field: EventSettingsField) {
    return errors[field]
      ? <small className="field-error" id={`settings-${field}-error`}>{errors[field]}</small>
      : null;
  }

  // Three fields block implicit submission, so Enter would otherwise do nothing
  // at all. It flushes instead, and never reloads the page.
  function flushOnEnter(keyEvent: KeyboardEvent) {
    if (keyEvent.key !== 'Enter') return;
    keyEvent.preventDefault();
    queue.flush();
  }

  // A raw value that canonicalizes to what is already stored is normalized on
  // screen and needs no request; anything else is flushed rather than waiting
  // out the rest of its window.
  function settleField(field: 'name' | 'welcomeMessage' | 'eventTimezone', canonical: string) {
    const current = stateRef.current;
    if (current.draft[field] !== canonical) {
      apply({ ...current, draft: { ...current.draft, [field]: canonical } }, 'enqueue');
    }
    queue.flush();
  }

  return <section className="event-settings-editor" aria-labelledby="event-settings-title">
    <div className="event-settings-editor__heading">
      <h3 id="event-settings-title" className="sr-only">Event settings</h3>
      <AutosaveStatus
        label={DOMAIN_LABEL}
        state={autosave}
        blockingField={blockingField}
        onRetry={() => apply(stateRef.current, 'immediate')}
      />
    </div>
    <form className="settings-form" onSubmit={(formEvent) => { formEvent.preventDefault(); queue.flush(); }}>
      <label>Event name<input
        name="name"
        value={state.draft.name}
        aria-invalid={Boolean(errors.name)}
        aria-describedby={describedBy('name')}
        onChange={(change) => edit('name', change.target.value, 'enqueue')}
        onBlur={() => settleField('name', state.draft.name.trim())}
        onKeyDown={flushOnEnter}
      />{fieldError('name')}</label>
      <label>Welcome message<textarea
        name="welcomeMessage"
        rows={4}
        value={state.draft.welcomeMessage}
        aria-invalid={Boolean(errors.welcomeMessage)}
        aria-describedby={describedBy('welcomeMessage')}
        onChange={(change) => edit('welcomeMessage', change.target.value, 'enqueue')}
        onBlur={() => settleField('welcomeMessage', state.draft.welcomeMessage.trim())}
      />{fieldError('welcomeMessage')}</label>
      <label>Event time zone<input
        name="eventTimezone"
        value={state.draft.eventTimezone}
        required
        autoComplete="off"
        spellCheck={false}
        aria-invalid={Boolean(errors.eventTimezone)}
        aria-describedby={describedBy('eventTimezone')}
        onChange={(change) => edit('eventTimezone', change.target.value, 'enqueue')}
        onBlur={() => settleField(
          'eventTimezone',
          canonicalEventSettings(state.draft, state.rosterVersion).eventTimezone,
        )}
        onKeyDown={flushOnEnter}
      />{fieldError('eventTimezone')}</label>
      <label>RSVP deadline<input
        name="rsvpDeadlineDate"
        type="date"
        value={state.draft.rsvpDeadlineDate}
        required
        aria-invalid={Boolean(errors.rsvpDeadlineDate)}
        aria-describedby={describedBy('rsvpDeadlineDate')}
        onChange={(change) => edit('rsvpDeadlineDate', change.target.value, 'immediate')}
        onKeyDown={flushOnEnter}
      />{fieldError('rsvpDeadlineDate')}</label>
      {([
        ['rsvpEnabled', 'Accept RSVPs'],
        ['uploadsEnabled', 'Accept private photo deliveries'],
        ['galleryVisible', 'Show the optional shared gallery'],
        ['moderationRequired', 'Review notes before sharing'],
      ] as const).map(([field, label]) => <label className="toggle" key={field}>
        <input
          type="checkbox"
          name={field}
          checked={state.draft[field]}
          aria-invalid={Boolean(errors[field])}
          aria-describedby={describedBy(field)}
          onChange={(change) => edit(field, change.target.checked, 'immediate')}
        />
        <span>{label}</span>
        {fieldError(field)}
      </label>)}
    </form>
  </section>;
}
```

- [ ] **Step 5: Mount it in the manager**

In `src/pages/ManagerPage.tsx`: delete `saveSettings` entirely, add `import { EventSettingsEditor } from '../components/EventSettingsEditor';`, and replace the `<form className="settings-form">…</form>` block inside the Settings section with:

```tsx
        <EventSettingsEditor
          key={event.id}
          ref={settingsAutosave}
          event={event}
          onEventWrite={eventWrite}
          onSettingsSaved={(updated) => setEvent((current) => current ? mergeSettingsResponse(current, updated) : updated)}
          onAutosaveStateChange={recordAutosaveState}
        />
```

Add beside the other refs:

```tsx
  // Held so leaving Settings can flush a scheduled write without waiting for
  // the network, and so the navigation guard can do the same.
  const settingsAutosave = useRef<AutosaveHandle>(null);
  const appearanceAutosave = useRef<AutosaveHandle>(null);
  const [autosaveStates, setAutosaveStates] = useState<Partial<Record<DomainAutosaveState['domain'], DomainAutosaveState>>>({});
  const recordAutosaveState = useCallback((next: DomainAutosaveState) => {
    setAutosaveStates((current) => ({ ...current, [next.domain]: next }));
    // A credential or lifecycle failure is the manager's existing recovery
    // problem, not a local Retry the host could ever win.
    if (next.failure?.escalation) setActionError({ type: 'load', failure: next.failure.escalation });
  }, []);
```

with `import type { AutosaveHandle, DomainAutosaveState } from '../features/settings/autosave-queue';`.

In `openSection`, before `setSection(next)`:

```tsx
    if (section === 'settings' && next !== 'settings') {
      // Leaving flushes the newest valid drafts. It deliberately does not wait
      // for their responses: the subtree stays mounted, so they finish anyway.
      settingsAutosave.current?.flush();
      appearanceAutosave.current?.flush();
    }
```

- [ ] **Step 6: Add the editor's styles**

In `src/styles.css`, beside the `.settings-form` rules (about line 183), add:

```css
.event-settings-editor__heading { margin-top: 30px; }
.settings-form .field-error { display: block; margin-top: 5px; color: var(--danger); font-size: .8rem; font-weight: 500; }
.settings-form .toggle { flex-wrap: wrap; }
.settings-form .toggle .field-error { flex-basis: 100%; }
```

- [ ] **Step 7: Update the manager test that named the Save button**

In `tests/ui/app.test.tsx`, change the `keeps appearance inside Settings between its form and account controls` case to locate the form without the removed button, and drop the now-obsolete `adopts the settings response without refreshing the whole manager` click target:

```ts
    const settingsForm = document.querySelector('form.settings-form');
    const editor = screen.getByRole('region', { name: 'Event appearance editor' });
```

and in the response-adoption case, replace `await user.click(screen.getByRole('button', { name: 'Save settings' }));` with:

```ts
    await user.click(screen.getByLabelText('Show the optional shared gallery'));
```

keeping the rest of that test as written, and its request-count assertion at `1`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts tests/ui/event-settings-editor.test.tsx tests/ui/app.test.tsx`
Expected: PASS.

- [ ] **Step 9: Lint, typecheck, and commit**

Run: `npm run lint && npm run typecheck && npm run test:unit`
Expected: PASS.

```bash
git add src/components/EventSettingsEditor.tsx src/pages/ManagerPage.tsx src/styles.css tests/ui/event-settings-editor.test.tsx tests/ui/app.test.tsx
git commit -m "feat: autosave the general event settings"
```

---

### Task 7: Autosave the event appearance

The saved/draft/preview separation stays exactly as it is. Only the manual save goes.

**Files:**
- Modify: `src/components/EventAppearanceEditor.tsx`
- Modify: `src/pages/ManagerPage.tsx` (pass the ref and the state callback)
- Test: `tests/ui/event-appearance-editor.test.tsx`

**Interfaces:**
- Consumes: `createAutosaveQueue`, `AutosaveHandle`, `AutosaveOutcome`, `AutosaveQueue`, `AutosaveState`, `AutosaveFailure`, `DomainAutosaveState` from `src/features/settings/autosave-queue.ts`; `AutosaveStatus` from `src/components/AutosaveStatus.tsx`; `describeLoadFailure` from `src/components/States.tsx`.
- Produces: props become `{ event, onThemeSaved, onCoverSaved, onAutosaveStateChange, ref }`, with the same two callbacks Task 5 introduced.

- [ ] **Step 1: Replace the manual-save expectations with autosave ones**

In `tests/ui/event-appearance-editor.test.tsx`, add fake timers to the existing setup (`beforeEach(() => { vi.useFakeTimers(); })`, `vi.useRealTimers()` in `afterEach`) and add the controlled harness, so a confirmed theme comes back down the way the manager sends it:

```tsx
import { useState } from 'react';

import { mergeCoverResponse, mergeThemeResponse } from '../../src/features/settings/event-merge';

function Harness() {
  const [current, setCurrent] = useState(event);
  return <EventAppearanceEditor
    key={current.id}
    event={current}
    onEventWrite={(request) => request()}
    onThemeSaved={(updated) => setCurrent((held) => mergeThemeResponse(held, updated))}
    onCoverSaved={(updated) => setCurrent((held) => mergeCoverResponse(held, updated))}
    onAutosaveStateChange={() => {}}
  />;
}
```

Replace every existing `render(<EventAppearanceEditor … />)` — Task 5 already renamed those props — with `render(<Harness />)`, except the cases that assert on a callback, which keep an explicit element with its own `vi.fn()` for `onThemeSaved` or `onCoverSaved` plus the new `onAutosaveStateChange={() => {}}`.

Then replace each `expect(screen.getByRole('button', { name: 'Save appearance' })).toBeDisabled()` with an assertion that nothing was sent, and each `Unsaved changes` assertion with the autosave status. Add these cases:

```tsx
  it('saves a preset the moment it is chosen', async () => {
    const fetchMock = vi.fn(() => json({
      event: { ...event, theme: resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} }) },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);

    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));

    await waitFor(() => expect(themeMutationCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(themeMutationCalls(fetchMock)[0]![1]?.body))).toEqual({
      version: 1, presetId: 'garden-party', overrides: {},
    });
    await waitFor(() => expect(screen.getByText('Event appearance saved')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Save appearance' })).not.toBeInTheDocument();
  });

  it('debounces a color into one request and previews it before it is confirmed', async () => {
    const fetchMock = vi.fn(() => json({ event }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);
    const primary = screen.getByRole('textbox', { name: 'Primary color' });

    await user.clear(primary);
    await user.type(primary, '#123456');
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#123456' });
    expect(themeMutationCalls(fetchMock)).toHaveLength(0);

    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    await waitFor(() => expect(themeMutationCalls(fetchMock)).toHaveLength(1));
  });

  it('sends nothing while the raw color is invalid and keeps the last valid preview', async () => {
    const fetchMock = vi.fn(() => json({ event }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);
    const primary = screen.getByRole('textbox', { name: 'Primary color' });

    await user.clear(primary);
    await user.type(primary, '#abc');
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);

    expect(themeMutationCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#4a2415' });
    expect(screen.getByText(/Event appearance can’t save/u)).toBeInTheDocument();
  });

  it('keeps theme controls editable during a save and cover controls on their own busy state', async () => {
    let release: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return json({ event });
    }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);

    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    expect(screen.getByRole('radio', { name: 'Coastal Light' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Primary color' })).toBeEnabled();
    release!();
    await waitFor(() => expect(screen.getByText('Event appearance saved')).toBeInTheDocument());
  });

  it('does not let a confirmed preset wipe raw color text typed while it saved', async () => {
    let release: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return json({
        event: { ...event, theme: resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} }) },
      });
    }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);

    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    const primary = screen.getByRole('textbox', { name: 'Primary color' });
    await user.clear(primary);
    await user.type(primary, '#abc');
    // Invalid text leaves the canonical config untouched, so the response's
    // config still matches the draft's. Only the raw intent moved.
    release!();

    await waitFor(() => expect(screen.getByText(/Event appearance can’t save/u)).toBeInTheDocument());
    expect(primary).toHaveValue('#abc');
    expect(primary).toHaveAccessibleDescription('Enter a six-digit hex color, such as #245c46.');
  });

  it('keeps the newest draft after a failed save and retries it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);

    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible());
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#245c46' });

    const fetchMock = vi.fn(() => json({
      event: { ...event, theme: resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} }) },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Event appearance saved')).toBeInTheDocument());
  });
```

Import `AUTOSAVE_DEBOUNCE_MS` from `../../src/features/settings/autosave-queue`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --config vitest.config.ts tests/ui/event-appearance-editor.test.tsx`
Expected: FAIL — no requests are sent without the removed Save button.

- [ ] **Step 3: Wire the queue into the appearance editor**

In `src/components/EventAppearanceEditor.tsx`:

Extend the imports with `useEffect`, `useImperativeHandle`, `type Ref`, `createAutosaveQueue` plus `type AutosaveFailure`, `AutosaveHandle`, `AutosaveOutcome`, `AutosaveQueue`, `AutosaveState`, `DomainAutosaveState` from `../features/settings/autosave-queue`, and `AutosaveStatus`/`describeLoadFailure`. Extend the props:

```tsx
interface EventAppearanceEditorProps {
  event: EventView;
  onThemeSaved(event: EventView): void;
  onCoverSaved(event: EventView): void;
  onAutosaveStateChange(state: DomainAutosaveState): void;
  ref?: Ref<AutosaveHandle>;
}
```

Delete the `busy` and `saveError` state. Add, beside the existing state:

```tsx
  const [autosave, setAutosave] = useState<AutosaveState>({ status: 'saved', failure: null });
  const queueRef = useRef<AutosaveQueue<EventThemeConfigV1> | null>(null);
  // The queue settles from a promise continuation, so what is on screen has to
  // be readable without waiting for a render.
  const draftRef = useRef<EventThemeConfigV1>(event.theme.config);
  const errorsRef = useRef<ThemeErrors>({});
  // The raw text in the two hex fields, which moves for edits the canonical
  // config never sees.
  const rawRef = useRef({ primary: initialRaw.primary, accent: initialRaw.accent });
  // Built once, so the saved callback is read through a ref rather than closed
  // over from the first render.
  const themeSavedRef = useRef(onThemeSaved);
  themeSavedRef.current = onThemeSaved;
```

Make `adoptDraft` and every `setErrors` call keep the refs current:

```tsx
  function adoptDraft(theme: ResolvedEventTheme) {
    draftRef.current = theme.config;
    setDraftTheme(theme.config);
    setPreviewTheme(theme);
  }

  function recordErrors(next: ThemeErrors) {
    errorsRef.current = next;
    setErrors(next);
  }

  function setRaw(kind: ColorKind, value: string) {
    if (kind === 'primaryColor') {
      rawRef.current = { ...rawRef.current, primary: value };
      setRawPrimary(value);
    } else {
      rawRef.current = { ...rawRef.current, accent: value };
      setRawAccent(value);
    }
  }

  // What the host can see, as one string. It changes for raw text that leaves
  // the canonical config alone, which is exactly the case a response has to be
  // able to notice.
  function themeIntent(): string {
    return JSON.stringify([
      serializeEventThemeConfig(draftRef.current),
      rawRef.current.primary,
      rawRef.current.accent,
    ]);
  }
```

Replace every `setErrors(…)` in `applyResolved`, `choosePreset`, `changeColor`, `usePresetColor`, and `reset` with `recordErrors(…)`, resolving the functional updates against `errorsRef.current` rather than the previous state argument. Replace every `setRawPrimary(…)`/`setRawAccent(…)` in those same five functions with `setRaw('primaryColor', …)`/`setRaw('accentColor', …)` so the raw refs never lag the fields — `sendTheme` reads them from a promise continuation.

- [ ] **Step 4: Replace `save()` with the queue**

Delete `save()` and add:

```tsx
  async function sendTheme(
    config: EventThemeConfigV1,
    draft: { key: string; intent: string },
  ): Promise<AutosaveOutcome> {
    const result = await onEventWrite(() => api<{ event: EventView }>(
      `/api/manage/events/${event.id}/theme`,
      { method: 'PUT', body: serializeEventThemeConfig(config) },
    ));
    const normalized = result.event.theme;
    setSavedTheme(normalized.config);
    /* Normalization is adopted only while the host is still looking at the draft
       it answers — and "still looking at" is about the *screen*, not the payload.
       Invalid hex text leaves the canonical config untouched, so comparing
       configs would say nothing changed and this would wipe the host's half-typed
       color and the error explaining it. The raw intent is what moved, so that is
       what is compared. */
    if (themeIntent() === draft.intent) {
      const raw = rawColors(normalized);
      adoptDraft(normalized);
      setRawPrimary(raw.primary);
      setRawAccent(raw.accent);
      recordErrors({});
    }
    themeSavedRef.current(result.event);
    // The Worker's own canonical form, so a normalized answer does not leave the
    // draft looking permanently dirty.
    return { status: 'confirmed', key: serializeEventThemeConfig(normalized.config) };
  }

  function describeThemeFailure(error: unknown): AutosaveFailure {
    if (error instanceof ClientApiError && error.fieldErrors) {
      const refused: ThemeErrors = {};
      for (const field of ['overrides.primaryColor', 'overrides.accentColor'] as const) {
        const message = error.fieldErrors[field];
        if (message) refused[field] = message;
      }
      if (Object.keys(refused).length > 0) {
        recordErrors({ ...errorsRef.current, ...refused });
        return { message: error.message, retryable: false };
      }
    }
    const failure = describeLoadFailure(error, 'manager', 'The event appearance could not be saved.');
    return failure.kind === 'retry'
      ? { message: failure.message, retryable: true }
      : { message: failure.message, retryable: false, escalation: failure };
  }

  if (queueRef.current === null) {
    queueRef.current = createAutosaveQueue<EventThemeConfigV1>({
      baselineKey: serializeEventThemeConfig(event.theme.config),
      save: (snapshot, draft) => sendTheme(snapshot, draft),
      describeFailure: (error) => describeThemeFailure(error),
      onChange: setAutosave,
    });
  }
  const queue = queueRef.current;

  // Contrast and syntax refusals gate the write, not the preview: the last valid
  // preview stays on screen while the domain reports that it cannot save.
  function enqueueTheme(immediate: boolean) {
    const config = draftRef.current;
    const valid = !errorsRef.current['overrides.primaryColor'] && !errorsRef.current['overrides.accentColor'];
    queue.submit({
      key: serializeEventThemeConfig(config),
      intent: themeIntent(),
      snapshot: valid ? config : null,
    }, immediate);
  }

  useEffect(() => () => { queue.dispose(); }, [queue]);
  // A contrast or syntax refusal returned by the Worker is recorded from inside
  // the settle path, which must not re-enter the queue. This is where the domain
  // learns it can no longer send, so it reads as `invalid` rather than `failed`.
  const themeBlocked = Boolean(errors['overrides.primaryColor'] || errors['overrides.accentColor']);
  useEffect(() => {
    if (!themeBlocked) return;
    queue.submit({
      key: serializeEventThemeConfig(draftRef.current),
      intent: themeIntent(),
      snapshot: null,
    });
  }, [themeBlocked, queue]);
  useEffect(() => {
    onAutosaveStateChange({
      domain: 'appearance',
      label: 'Event appearance',
      status: autosave.status,
      failure: autosave.failure,
      blockingField: errors['overrides.primaryColor']
        ? { label: 'Primary color', message: errors['overrides.primaryColor'] }
        : errors['overrides.accentColor']
          ? { label: 'Accent color', message: errors['overrides.accentColor'] }
          : null,
    });
  }, [autosave, errors, onAutosaveStateChange]);
  useImperativeHandle(ref, () => ({ flush: () => { queue.flush(); } }), [queue]);
```

Call `enqueueTheme(true)` at the end of `choosePreset`, `usePresetColor`, and `reset`, and `enqueueTheme(false)` at the end of every `changeColor` path — including the two early returns that record a syntax or resolution error, so an invalid draft cancels a snapshot that has not started.

- [ ] **Step 5: Replace the manual-save markup**

- Change the heading paragraph to: `<p>Choose the colors and shape guests see. Changes save as you make them. Cover changes apply immediately.</p>`
- Replace the `<span className={...event-appearance-editor__status...}>` element with:

```tsx
      <AutosaveStatus
        className="event-appearance-editor__status"
        label="Event appearance"
        state={autosave}
        blockingField={errors['overrides.primaryColor']
          ? { label: 'Primary color', message: errors['overrides.primaryColor'] }
          : errors['overrides.accentColor']
            ? { label: 'Accent color', message: errors['overrides.accentColor'] }
            : null}
        onRetry={() => enqueueTheme(true)}
      />
```

- Delete the `{saveError && <p className="form-error" role="alert">{saveError}</p>}` line. Keep the cover one.
- Replace `const locked = busy || coverBusy;` with `const locked = coverBusy;`, and remove `disabled={locked}` from the preset selector, both color pickers, both hex inputs, and both `Use preset …` buttons. Cover controls keep `disabled={locked}`.
- Change the `if (busy || coverBusy) return;` guards in `uploadCover` and `removeCover` to `if (coverBusy) return;`.
- Replace the actions row with the Reset button alone, and add Enter handling to the two hex inputs:

```tsx
      <div className="event-appearance-editor__actions">
        <button type="button" className="button button--secondary" onClick={reset}>
          Reset to Candidary default
        </button>
      </div>
```

with `onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter') { keyEvent.preventDefault(); queue.flush(); } }}` and `onBlur={() => queue.flush()}` on each `input type="text"`, and the form's `onSubmit` becoming `(formEvent) => { formEvent.preventDefault(); queue.flush(); }`.

- [ ] **Step 6: Pass the ref and state callback from the manager**

In `src/pages/ManagerPage.tsx`, add `ref={appearanceAutosave}` and `onAutosaveStateChange={recordAutosaveState}` to the `<EventAppearanceEditor …>` element.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts tests/ui/event-appearance-editor.test.tsx tests/ui/app.test.tsx`
Expected: PASS.

- [ ] **Step 8: Lint, typecheck, and commit**

Run: `npm run lint && npm run typecheck && npm run test:unit`
Expected: PASS.

```bash
git add src/components/EventAppearanceEditor.tsx src/pages/ManagerPage.tsx tests/ui/event-appearance-editor.test.tsx
git commit -m "feat: autosave the event appearance"
```

---

### Task 8: Guard destination changes, client routes, and page exit

**Files:**
- Create: `src/components/UnsavedSettingsPrompt.tsx`
- Modify: `src/pages/ManagerPage.tsx`, `src/styles.css`
- Test: `tests/ui/manager-settings-autosave.test.tsx`

**Interfaces:**
- Consumes: `useBlocker` from `react-router-dom`; `DomainAutosaveState`, `AutosaveHandle` from `src/features/settings/autosave-queue.ts`.
- Produces: `<UnsavedSettingsPrompt domains={readonly DomainAutosaveState[]} onLeave={() => void} onStay?={() => void} />`.

- [ ] **Step 1: Write the failing guard tests**

Create `tests/ui/manager-settings-autosave.test.tsx`. It reuses the manager fixtures from `tests/ui/app.test.tsx`; copy `json`, `errorJson`, `MANAGED_EVENT`, and `managerFetch` into the new file rather than exporting them from a test file.

```tsx
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,x')) } }));

import { createAppRouter } from '../../src/app/router';
// Copy `json`, `errorJson`, `MANAGED_EVENT`, and `managerFetch` verbatim from
// tests/ui/app.test.tsx rather than exporting them out of a test file.

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'Live intake' });
  await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
    .getByRole('button', { name: /settings/i }));
}

function typist() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('manager settings autosave guards', () => {
  it('flushes a scheduled edit when the host leaves Settings', async () => {
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        writes.push(String(init?.body));
        return json({ event: { ...MANAGED_EVENT, name: 'Reception' } });
      }
      return fetchMock(input, init);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.clear(screen.getByLabelText('Event name'));
    await user.type(screen.getByLabelText('Event name'), 'Reception');
    expect(writes).toHaveLength(0);

    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /gallery/i }));

    // The flush does not wait for the response; the subtree stays mounted so it lands.
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(writes[0]!).name).toBe('Reception');
  });

  it('blocks a client route while a save is in flight and proceeds once it confirms', async () => {
    let release: (() => void) | null = null;
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        await new Promise<void>((resolve) => { release = resolve; });
        return json({ event: { ...MANAGED_EVENT, moderationRequired: false } });
      }
      return fetchMock(input, init);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.click(screen.getByLabelText('Review notes before sharing'));
    await user.click(screen.getByRole('link', { name: 'Candidary home' }));

    const prompt = await screen.findByRole('alertdialog');
    expect(within(prompt).getByRole('button', { name: 'Leave now' })).toBeVisible();
    // Nothing is broken, so there is nothing to stay and fix.
    expect(within(prompt).queryByRole('button', { name: 'Stay and fix settings' })).not.toBeInTheDocument();
    expect(prompt).toHaveFocus();

    release!();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Manager sections' })).not.toBeInTheDocument());
  });

  it('always offers Leave now, so a stalled network cannot trap the host', async () => {
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        return new Promise<Response>(() => { /* never settles */ });
      }
      return fetchMock(input, init);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.click(screen.getByLabelText('Review notes before sharing'));
    await user.click(screen.getByRole('link', { name: 'Candidary home' }));
    const prompt = await screen.findByRole('alertdialog');
    expect(within(prompt).getByText(/may still finish saving after you leave/u)).toBeVisible();

    await user.click(within(prompt).getByRole('button', { name: 'Leave now' }));
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Manager sections' })).not.toBeInTheDocument());
  });

  it('offers a way back to Settings when the draft cannot be saved', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.clear(screen.getByLabelText('Event name'));
    await user.click(screen.getByRole('link', { name: 'Candidary home' }));

    const prompt = await screen.findByRole('alertdialog');
    await user.click(within(prompt).getByRole('button', { name: 'Stay and fix settings' }));

    expect(screen.getByLabelText('Event name')).toBeVisible();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('raises a manager notice when a hidden Settings draft cannot save, and routes back', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.clear(screen.getByLabelText('Event name'));
    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /gallery/i }));

    const notice = await screen.findByRole('region', { name: 'Unsaved settings' });
    expect(within(notice).getByRole('alert')).toHaveTextContent(
      'Event settings has a change that cannot be saved yet.',
    );
    await user.click(within(notice).getByRole('button', { name: 'Open settings' }));
    expect(screen.getByLabelText('Event name')).toBeVisible();
  });

  it('registers beforeunload only while something is unconfirmed', async () => {
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        return json({ event: { ...MANAGED_EVENT, moderationRequired: false } });
      }
      return fetchMock(input, init);
    }));
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);
    expect(added.mock.calls.filter(([type]) => type === 'beforeunload')).toHaveLength(0);

    await user.click(screen.getByLabelText('Review notes before sharing'));
    await waitFor(() => expect(added.mock.calls.filter(([type]) => type === 'beforeunload').length)
      .toBeGreaterThan(0));
    await waitFor(() => expect(removed.mock.calls.filter(([type]) => type === 'beforeunload').length)
      .toBeGreaterThan(0));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --config vitest.config.ts tests/ui/manager-settings-autosave.test.tsx`
Expected: FAIL — no `alertdialog`, no `Unsaved settings` region.

- [ ] **Step 3: Write the prompt**

Create `src/components/UnsavedSettingsPrompt.tsx`:

```tsx
import { useEffect, useRef } from 'react';

import type { DomainAutosaveState } from '../features/settings/autosave-queue';

interface UnsavedSettingsPromptProps {
  domains: readonly DomainAutosaveState[];
  onLeave(): void;
  // Offered only when staying would achieve something: a draft that cannot be
  // sent, or a save that failed. A request merely in flight has nothing to fix.
  onStay?(): void;
}

export function UnsavedSettingsPrompt({ domains, onLeave, onStay }: UnsavedSettingsPromptProps) {
  const container = useRef<HTMLDivElement>(null);
  // The host asked to navigate, so this answers their own action and focus
  // belongs on it. Background save errors never move focus.
  useEffect(() => { container.current?.focus(); }, []);
  const names = domains.map((domain) => domain.label).join(' and ');
  return <div
    className="unsaved-settings-prompt"
    role="alertdialog"
    aria-labelledby="unsaved-settings-title"
    aria-describedby="unsaved-settings-body"
    tabIndex={-1}
    ref={container}
  >
    <h2 id="unsaved-settings-title">
      {names || 'Your settings'} {domains.length > 1 ? 'are' : 'is'} not saved yet
    </h2>
    {/* Honest about what leaving can and cannot undo: a request already sent may
        still commit, and no button here can recall it. */}
    <p id="unsaved-settings-body">
      A change already sent may still finish saving after you leave. Leaving now discards anything
      that has not been sent.
    </p>
    <div className="button-row">
      <button type="button" className="button button--secondary" onClick={onLeave}>Leave now</button>
      {onStay && <button type="button" className="button button--primary" onClick={onStay}>
        Stay and fix settings
      </button>}
    </div>
  </div>;
}
```

- [ ] **Step 4: Wire the guards into the manager**

In `src/pages/ManagerPage.tsx`, add `useBlocker` to the `react-router-dom` import and `import { UnsavedSettingsPrompt } from '../components/UnsavedSettingsPrompt';`. Then, after `recordAutosaveState`:

```tsx
  const unconfirmedDomains = Object.values(autosaveStates)
    .filter((domain): domain is DomainAutosaveState => Boolean(domain) && domain.status !== 'saved');
  const stuckDomains = unconfirmedDomains.filter(
    ({ status }) => status === 'invalid' || status === 'failed',
  );
  // Read through a ref: the blocker registers once, and re-registering it on
  // every keystroke would drop the block mid-navigation.
  const unconfirmedRef = useRef(false);
  unconfirmedRef.current = unconfirmedDomains.length > 0;
  const blocker = useBlocker(useCallback(() => unconfirmedRef.current, []));

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    settingsAutosave.current?.flush();
    appearanceAutosave.current?.flush();
  }, [blocker.state]);
  useEffect(() => {
    // The requested navigation happens by itself the moment both domains
    // confirm; the host never has to answer the prompt twice.
    if (blocker.state === 'blocked' && unconfirmedDomains.length === 0) blocker.proceed();
  }, [blocker, unconfirmedDomains.length]);
  useEffect(() => {
    if (unconfirmedDomains.length === 0) return;
    // A browser may cancel background requests during unload, so this warns
    // rather than pretending a last-millisecond save is guaranteed.
    const warn = (unloadEvent: BeforeUnloadEvent) => { unloadEvent.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [unconfirmedDomains.length]);
```

Render the notice immediately after the existing `{actionError && …}` section:

```tsx
      {section !== 'settings' && stuckDomains.length > 0 && (
        <section className="manager-autosave-notice" aria-label="Unsaved settings">
          <p role="alert">{stuckDomains.map((domain) => domain.status === 'invalid'
            ? `${domain.label} has a change that cannot be saved yet.`
            : `${domain.label} could not save a change.`).join(' ')}</p>
          <button type="button" className="button button--secondary" onClick={() => openSection('settings')}>
            Open settings
          </button>
        </section>
      )}
```

and the prompt at the end of `<main className="manager-main">`, just before its closing tag:

```tsx
      {blocker.state === 'blocked' && <UnsavedSettingsPrompt
        domains={unconfirmedDomains}
        onLeave={() => blocker.proceed()}
        onStay={stuckDomains.length > 0
          ? () => { blocker.reset(); openSection('settings'); }
          : undefined}
      />}
```

- [ ] **Step 5: Add the styles**

Append to `src/styles.css`:

```css
.manager-autosave-notice { margin: 20px 0; padding: 15px 17px; display: grid; gap: 12px; border-left: 3px solid var(--denim); background: var(--denim-soft); }
.manager-autosave-notice p { margin: 0; }
.manager-autosave-notice .button { min-height: 44px; justify-self: start; }
.unsaved-settings-prompt { margin: 20px 0; padding: 17px; display: grid; gap: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--paper); }
.unsaved-settings-prompt h2 { margin: 0; font-size: 1.25rem; }
.unsaved-settings-prompt p { margin: 0; color: var(--muted); }
.unsaved-settings-prompt:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.unsaved-settings-prompt .button { min-height: 44px; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --config vitest.config.ts tests/ui/manager-settings-autosave.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 7: Lint, typecheck, and commit**

Run: `npm run lint && npm run typecheck && npm run test:unit`
Expected: PASS.

```bash
git add src/components/UnsavedSettingsPrompt.tsx src/pages/ManagerPage.tsx src/styles.css tests/ui/manager-settings-autosave.test.tsx
git commit -m "feat: guard route and page exits while settings are unconfirmed"
```

---

### Task 9: Cross-domain ordering, browser evidence, and documentation

**Files:**
- Modify: `tests/ui/manager-settings-autosave.test.tsx`
- Modify: `tests/e2e/fixtures/routes.ts` (`EVENT_FIXTURE` deadline; `settings` and `theme` route stubs)
- Modify: `tests/e2e/event-theming.spec.ts:452-476`
- Refresh: `tests/e2e/event-theming-visual.spec.ts-snapshots/manager-event-appearance-390-mobile-win32.png`
- Modify: `design-qa.md`, `design/fidelity-ledger.md`, `docs/superpowers/specs/2026-07-29-event-theming-design.md`, `docs/superpowers/plans/2026-07-29-event-theming.md`

**Interfaces:**
- Consumes: everything produced by Tasks 5–8. Nothing new is produced.

**Two fixture facts this task exists to fix.** `EVENT_FIXTURE` spreads `GUEST_EVENT_FIXTURE`, whose `rsvpDeadlineDate` is deliberately `null` so no guest photo baseline picks up an RSVP disclosure. The manager inherits that null, so the autosaving settings editor would start `invalid` on **every** manager browser test — no PATCH would ever be sent, and the existing appearance baseline would render a red deadline error. And neither `PATCH …/settings` nor `PUT …/theme` is stubbed in `stubManagerRoutes` at all; under autosave an unrouted write reaches the static preview server, fails to parse, and the status reads `Couldn't save.`

- [ ] **Step 0: Give the manager fixture a real deadline and stub the two writes**

In `tests/e2e/fixtures/routes.ts`, add to the `EVENT_FIXTURE` literal, below `rsvpRosterVersion`:

```ts
  // The guest fixtures keep a null deadline on purpose. The manager cannot:
  // its settings editor validates the deadline, and a null one would leave
  // every manager browser test sitting on an unsendable draft.
  rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
  rsvpDeadlineDate: '2026-09-05',
```

and add both write routes inside `stubManagerRoutes`, next to the whole-event route:

```ts
  await page.route(`${base}/settings`, (route) => route.fulfill({
    json: {
      data: { event: { ...event, ...route.request().postDataJSON() as Partial<EventView> } },
      requestId: 'request-a',
    },
  }));
  await page.route(`${base}/theme`, (route) => route.fulfill({
    json: {
      data: { event: { ...event, theme: resolveEventTheme(route.request().postDataJSON()) } },
      requestId: 'request-a',
    },
  }));
```

The settings stub echoes the payload so the editor's baseline advances to what it sent; drop `rsvpRosterVersion` from the echo only if a test needs a version conflict. Run `npx tsc -p tsconfig.e2e.json --pretty false` before going further — the echo needs a cast, not `any`.

- [ ] **Step 1: Write the failing cross-domain tests**

Append to `describe('manager settings autosave guards', …)` in `tests/ui/manager-settings-autosave.test.tsx`:

```tsx
  it('keeps three deferred mutation responses from restoring each other’s stale state', async () => {
    const gardenTheme = resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} });
    const releases: Array<() => void> = [];
    const hold = () => new Promise<void>((resolve) => { releases.push(resolve); });
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/settings') && method === 'PATCH') {
        await hold();
        // Built from a row read before the theme changed.
        return json({ event: { ...MANAGED_EVENT, moderationRequired: false, theme: MANAGED_EVENT.theme } });
      }
      if (url.endsWith('/theme') && method === 'PUT') {
        await hold();
        // Built from a row read before the moderation switch changed.
        return json({ event: { ...MANAGED_EVENT, theme: gardenTheme } });
      }
      return fetchMock(input, init);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.click(screen.getByLabelText('Review notes before sharing'));
    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await waitFor(() => expect(releases).toHaveLength(2));

    // Settle the theme first, then the older settings response.
    releases[1]!();
    releases[0]!();

    await waitFor(() => expect(screen.getByLabelText('Review notes before sharing')).not.toBeChecked());
    // The settings response carried the pre-change theme; it must not travel.
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#245c46' });
    // And the theme response carried the pre-change switch; that must not travel either.
    expect(screen.getByLabelText('Review notes before sharing')).not.toBeChecked();
  });

  it('keeps a deferred cover response from restoring stale settings or theme', async () => {
    const gardenTheme = resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} });
    let releaseCover: (() => void) | null = null;
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/cover') && method === 'POST') {
        return json({ objectKey: 'events/event-a/cover/new.jpg', url: 'https://r2.test/put' }, 201);
      }
      if (url === 'https://r2.test/put') return Promise.resolve(new Response(null, { status: 200 }));
      if (url.endsWith('/cover/finalize') && method === 'POST') {
        await new Promise<void>((resolve) => { releaseCover = resolve; });
        // Built from a row read before either later write.
        return json({
          event: {
            ...MANAGED_EVENT,
            coverObjectKey: 'events/event-a/cover/new.jpg',
            moderationRequired: true,
            theme: MANAGED_EVENT.theme,
          },
        });
      }
      if (url.endsWith('/settings') && method === 'PATCH') {
        return json({ event: { ...MANAGED_EVENT, moderationRequired: false } });
      }
      if (url.endsWith('/theme') && method === 'PUT') {
        return json({ event: { ...MANAGED_EVENT, theme: gardenTheme } });
      }
      return fetchMock(input, init);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    const file = new File([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' });
    await user.upload(document.querySelector<HTMLInputElement>('.cover-field__input')!, file);
    await waitFor(() => expect(releaseCover).not.toBeNull());

    await user.click(screen.getByLabelText('Review notes before sharing'));
    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await waitFor(() => expect(screen.getByLabelText('Review notes before sharing')).not.toBeChecked());

    releaseCover!();

    // The cover response owns the cover and nothing else.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove cover' })).toBeVisible());
    expect(screen.getByLabelText('Review notes before sharing')).not.toBeChecked();
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#245c46' });
  });
```

Import `resolveEventTheme` from `../../shared/event-theme` in that file.

Between the two cases every ordering the spec names is covered: a delayed settings response against a newer theme, a delayed theme response against newer settings, and a delayed cover response against both.

- [ ] **Step 2: Run them and make them pass**

Run: `npx vitest run --config vitest.config.ts tests/ui/manager-settings-autosave.test.tsx -t 'deferred'`
Expected: PASS, because `mergeSettingsResponse`/`mergeThemeResponse`/`mergeCoverResponse` from Task 5 already restrict each response. If one fails, the merge lists are wrong — fix `src/features/settings/event-merge.ts`, not the test.

- [ ] **Step 3: Migrate the appearance E2E case to autosave**

In `tests/e2e/event-theming.spec.ts`, replace the body of `manager appearance PUT carries the canonical config and adopts the normalized fixture response` from the preset check onward with:

```ts
  const themeRequest = page.waitForRequest(
    (request) => request.url().endsWith(`/api/manage/events/${EVENT_FIXTURE.id}/theme`),
  );
  await page.getByRole('radio', { name: /Coastal Light/u }).check();
  const request = await themeRequest;
  expect(request.method()).toBe('PUT');
  expect(request.postDataJSON()).toEqual({
    version: 1,
    presetId: 'coastal-light',
    overrides: {},
  });
  await expect(page.locator('.event-appearance-editor__status .autosave-status__chip')).toHaveText('Saved');
  await expectTheme(page.locator('.event-appearance-preview'), eventTheme('coastal-light'));
```

Also rename the test to `manager appearance autosaves the canonical config and adopts the normalized fixture response`.

- [ ] **Step 4: Add browser evidence for the removed buttons and the contained layouts**

Add to `tests/e2e/event-theming.spec.ts`, next to the case above:

```ts
test('manager Settings saves without a Save button and stays contained at 320 and 390', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await stubManagerRoutes(page, { mediaPages: { first: { media: [], nextCursor: null } } });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Event appearance' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save appearance' })).toHaveCount(0);

  const settingsRequest = page.waitForRequest(
    (request) => request.url().endsWith(`/api/manage/events/${EVENT_FIXTURE.id}/settings`),
  );
  const scrolledTo = await page.evaluate(() => {
    window.scrollTo({ top: 400, behavior: 'instant' });
    return window.scrollY;
  });
  await page.getByLabel('Show the optional shared gallery').click();
  expect((await settingsRequest).method()).toBe('PATCH');
  // Two live regions, each naming its own domain.
  await expect(page.getByText('Event settings saved')).toBeAttached();
  await expect(page.getByText('Event appearance saved')).toBeAttached();
  // Status text arriving must not shift the page under the host's hands.
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolledTo);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expectContained(page, `manager settings autosave at ${width}`);
  }
});
```

Step 0 has already added the `settings` route this needs.

- [ ] **Step 5: Run the browser gates and refresh the intentional baseline**

Run: `npx tsc -p tsconfig.e2e.json --pretty false`
Expected: no errors.

Run: `npm run build && npx playwright test tests/e2e/event-theming.spec.ts tests/e2e/event-theming-visual.spec.ts tests/e2e/manager-responsive.spec.ts tests/e2e/accessibility.spec.ts`

The screenshot assertion lives in `tests/e2e/event-theming-visual.spec.ts:143` (`manager Event appearance keeps global chrome outside the preview`), **not** in `event-theming.spec.ts`. Expect `manager-event-appearance-390-mobile-win32.png` to fail for three intended reasons: both Save buttons are gone, a status chip replaced one of them, and the RSVP deadline field now shows a real date instead of an empty required control.

Inspect the diff and confirm those are the only changes, then:

Run: `npx playwright test tests/e2e/event-theming-visual.spec.ts --update-snapshots`
Expected: only `manager-event-appearance-390-mobile-win32.png` is rewritten. Run `git status` and confirm no other baseline moved; if a manager-responsive or accessibility baseline also changed, inspect it against the same three reasons before accepting it.

- [ ] **Step 6: Update the design and process documents**

- `design-qa.md`: in the paragraph at line ~197, replace the sentence describing preset and color changes as local until Save with one stating that valid preset and color changes autosave — immediately for presets, preset-color restoration, and Reset; after 600 ms of inactivity, on blur, or on Enter for colors — while the preview still updates from the newest valid local draft and guests still receive only the last Worker-confirmed theme. In the line ~202 sentence, replace "unsaved state" with the autosave status vocabulary (`Saved`, `Saving…`, `Fix the highlighted field to save.`, `Couldn't save.` plus Retry). Add `tests/ui/event-settings-editor.test.tsx`, `tests/ui/manager-settings-autosave.test.tsx`, `tests/unit/settings-autosave-queue.test.ts`, `tests/unit/event-settings-draft.test.ts`, `tests/unit/manager-event-merge.test.ts`, and `tests/unit/autosave-status-text.test.ts` to the command at line 35.
- `design/fidelity-ledger.md` line 34: replace "preset/color changes, Reset, and preview are local until Save" with "preset/color changes, Reset, and preview are local until the Worker confirms them, and every valid change is sent without a Save button"; replace "A failed Save retains raw input, draft, preview, unsaved status, scroll position, and a retryable action" with the same guarantee stated for a failed autosave, adding that the newest draft — not the snapshot that failed — is what Retry sends.
- `docs/superpowers/specs/2026-07-29-event-theming-design.md` line 815 and the matching step in `docs/superpowers/plans/2026-07-29-event-theming.md`: mark **Save appearance** as superseded by `docs/superpowers/specs/2026-08-01-settings-autosave-design.md`, with a one-line pointer rather than deleting the history.

- [ ] **Step 7: Run every repository gate**

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:pwa-build
npx tsc -p tsconfig.e2e.json --pretty false
npm run cf-typegen
npx playwright test
```

Expected: all pass. Record the actual output; do not report completion from a partial run.

- [ ] **Step 8: Commit**

```bash
git add tests/ui/manager-settings-autosave.test.tsx tests/e2e/event-theming.spec.ts design-qa.md design/fidelity-ledger.md docs/superpowers/specs/2026-07-29-event-theming-design.md docs/superpowers/plans/2026-07-29-event-theming.md tests/e2e/**/*.png
git commit -m "test: prove cross-domain response ownership and migrate the save-button evidence"
```

---

## Acceptance Criteria Coverage

| Spec §14 criterion | Where it lands |
| --- | --- |
| 1. No Save button for ordinary changes | Tasks 6, 7; asserted in Task 9 Step 4 |
| 2. Newest valid intent reaches the Worker under the approved timing | Task 2 (debounce/flush/immediate), Task 6 Step 4, Task 7 Step 4 |
| 3. No older same-page snapshot wins | Task 2 (`settle` supersession, in-flight reversion drops pending, `intent` vs `key`, confirmed key), Task 5 (read guard + ownership merges), Tasks 6–7 (response ownership by intent) |
| 4. Invalid drafts make no request and name the field | Task 3, Task 4, Task 6 |
| 5. Failed writes keep the draft and retry the newest intent | Task 2, Task 6, Task 7 |
| 6. Leaving Settings does not discard a pending edit | Task 5 (stays mounted), Task 6 Step 5 (flush on destination change) |
| 7. Client-route and full-page exits cannot silently discard | Task 8, plus Task 2's `dispose()` — `Leave now` really does drop unsent intent |
| 8. Cover and destructive actions keep their contracts | Task 5 (callback split), Task 7 (cover-only busy state) |
| 9. Responses do not clobber unrelated state or refresh the manager | Task 5 (merges **and** the read guard), Task 9 Step 1 |
| 10. A delayed write cannot reopen intake after entry disable | Task 1 |
| 11. Manual-save docs, tests, and visual evidence migrated | Task 9 Steps 3–6 |
| 12. Full gates pass on the final head | Task 9 Step 7 |

## Notes for the implementer

- **Keep the queue's three concepts apart.** `key` is what would be stored, `intent` is what the host can see, and `AutosaveOutcome` is what a request achieved. Every ordering bug in this feature comes from letting two of them stand in for each other: comparing configs instead of intent wipes half-typed input, adopting the sent key instead of the confirmed one leaves a normalized draft permanently dirty, and treating "resolved" as "committed" announces a `Saved` no write earned.
- **The queue is the ordering guarantee, not `AbortController`.** Never add an abort to a settings or theme write: an aborted request may already have committed on the Worker, and the client would then hold a baseline the server disagrees with.
- **Ownership merges and the read guard solve different halves of the same race.** A merge stops a *mutation* response from carrying fields it did not decide. The guard stops a plain `GET` — which legitimately owns every field — from answering for a row that has since moved. Adding one without the other leaves the editor rebaseable backward.
- **`describeFailure` runs inside the queue's settle path.** It may set React state (that is how server field errors are attached), but it must not call `submit`. `apply(..., 'silent')` exists for exactly that reason.
- **`event.id` is fixed for a mounted editor.** Both editors are mounted with `key={event.id}`; if that ever changes, the `eventId` closures in `sendSettings`/`sendTheme` need refs.
- **Reconciliation is by ownership, not by recency.** A field the host has moved is theirs until it saves; everything else adopts the newest confirmed value. That is what lets an RSVP-panel mutation on the same page land without provoking a stale write.
- **A settings response that changes `rsvpRosterVersion` is not a conflict.** It is the normal path, and the reconciliation effect rebases onto it.
