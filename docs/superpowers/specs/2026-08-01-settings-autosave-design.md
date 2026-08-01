# Candidary Settings Autosave Design

- **Status:** Approved for implementation planning
- **Date:** 2026-08-01
- **Scope:** Manager Settings only

## 1. Summary

Candidary will save ordinary changes in the manager **Settings** destination without requiring the
host to press **Save settings** or **Save appearance**. General event settings and event appearance
remain separate persistence domains, but both use the same interaction contract: valid edits save in
the background, rapid edits collapse into the newest intended value, and the interface never reports
success before the server confirms it.

The first release reuses the existing complete-payload settings `PATCH` and theme `PUT`. It adds no D1
migration and no new public API. A serialized, coalescing client queue prevents requests from the same
manager page from completing out of order. The existing settings update is also hardened with an
atomic open-entry predicate so a delayed autosave cannot race the irreversible printed-entry disable
and reopen guest intake. Concurrent tabs or devices otherwise retain the existing last-writer-wins
behavior except for the RSVP roster-version guard already enforced by the Worker.

## 2. Problem

The Settings destination currently contains two explicit-save experiences:

- general event controls submit one complete settings form; and
- Event appearance keeps preset and color changes in a local preview until **Save appearance**.

This is easy to miss on a phone, and navigating away from Settings discards an unsaved form. General
settings also refresh the entire manager after a successful write, producing five reads that are not
needed to confirm one settings mutation.

Cover add, change, and removal already apply immediately. Account access, manager-link rotation, and
event deletion are distinct actions and must not be folded into autosave.

## 3. Goals

- Remove **Save settings** and **Save appearance**.
- Autosave all eight general event settings and every valid preset/color/reset appearance change.
- Preserve local editing and preview behavior while a background request is active.
- Send at most one request at a time per persistence domain and retain only the newest queued snapshot.
- Never send incomplete or invalid settings.
- Make save progress, confirmation, validation, and failure accessible and unambiguous.
- Preserve pending edits when the host switches manager destinations.
- Guard both client-side navigation and full-page exit when they could discard a dirty, pending,
  in-flight, invalid, or failed edit.
- Reuse server-confirmed mutation responses instead of refreshing the whole manager.
- Preserve all Worker authorization, irreversible-entry, RSVP-roster, theme-resolution, and contrast
  validation.
- Make the irreversible-entry check part of the atomic settings update, not a read-before-write race.

## 4. Non-goals

- No automatic account linking, manager-link rotation, entry disablement, or event deletion.
- No change to cover upload/remove semantics; those writes remain immediate and independently reported.
- No D1 settings revision, theme revision, idempotency ledger, or multi-tab merge UI in this release.
- No field-specific settings endpoints.
- No optimistic claim that a setting is saved before the Worker response succeeds.
- No production deployment as part of design or implementation planning.

## 5. Chosen approach

### 5.1 Why serialized client autosave

The existing settings endpoint accepts and atomically writes one complete settings payload. Firing a
request for every keystroke would allow a slower request containing older values to overwrite a newer
request. The client therefore gives general settings one queue and appearance one separate queue.

Each queue has at most:

- one in-flight snapshot; and
- one pending snapshot, always replaced by the newest valid draft.

When the in-flight request settles, the queue either sends the newest pending snapshot or becomes
idle. Intermediate pending snapshots are deliberately discarded. The settings and theme queues may
run at the same time because the Worker writes disjoint columns, but a whole-event response must update
only the client state owned by that response.

Client serialization is not a substitute for the irreversible-entry invariant. The settings
repository update adds a SQL predicate that allows `uploads_enabled` or `rsvp_enabled` to become true
only while an enabled `event_entry_credentials` row exists in the same atomic statement. The route
keeps its current early `requireOpenEntry()` check for useful errors and legacy-entry adoption. If the
guarded update changes no row, the route re-reads the entry and roster state so a closed entry returns
`EVENT_ENTRY_UNAVAILABLE` and a roster race retains `RSVP_ROSTER_INVALID`.

### 5.2 Alternatives not selected

**Server revision/CAS.** A settings or event revision would provide explicit multi-tab conflict
detection. It also requires a migration, mixed-version Worker compatibility, new error contracts, and
a host-facing conflict-resolution flow. That is disproportionate to the initial autosave goal.

**Field-specific writes.** Independent endpoints would reduce payload size, but deadline/time-zone and
RSVP/roster rules are cross-field invariants. Splitting them would expand the API and duplicate
validation without eliminating the need for client sequencing.

## 6. Scope of automatic and explicit actions

### 6.1 General settings that autosave

- Event name
- Welcome message
- Event time zone
- RSVP deadline
- Accept RSVPs
- Accept private photo deliveries
- Show the optional shared gallery
- Review notes before sharing

Every general-settings request remains a complete snapshot and includes the current
`rsvpRosterVersion`.

### 6.2 Appearance changes that autosave

- Theme preset
- Primary color picker and hex input
- Accent color picker and hex input
- Use preset primary
- Use preset accent
- Reset to Candidary default

Reset remains an explicit button because it expresses a deliberate choice, but the resulting default
theme saves immediately without a second confirmation.

### 6.3 Actions that remain independent

- Add, change, or remove cover
- Add the event to an account or navigate to sign-in/account creation
- Rotate the management link
- Sign out guest devices
- Disable the printed event QR
- Delete the event

## 7. Save timing

The interaction uses the approved hybrid timing:

- text, textarea, time-zone, color-picker, and hex-color changes schedule a save after **600 ms** of
  inactivity;
- blurring one of those fields flushes its newest valid draft immediately;
- RSVP deadline, checkboxes, preset selection, preset-color restoration, and Reset enqueue immediately;
- submitting either form through the keyboard prevents navigation and flushes immediately; and
- leaving Settings flushes every newest valid draft without waiting for the network response.

The Settings subtree remains mounted after its first visit and is hidden from layout and the
accessibility tree while another manager destination is active. This lets timers and in-flight queues
finish without moving all editor state into the manager page or losing it on destination changes.
If a flushed save fails while Settings is hidden, or the host leaves Settings with a current invalid
draft, the manager-level notice becomes visible in the current destination and identifies **Event
settings** or **Event appearance**, with an action that returns to Settings. The editor retains the
detailed error and Retry control where applicable.

## 8. Autosave state model

General settings and appearance each expose the same public state model:

| State | Meaning | Visible status |
| --- | --- | --- |
| `saved` | Draft is canonically equivalent to the confirmed value and no request is active. | **Saved** |
| `scheduled` | A valid changed draft is inside the 600 ms window. | **Saving…** |
| `saving` | A request is active; the current draft is valid. | **Saving…** |
| `invalid` | The latest complete domain draft cannot be sent, even if an older request remains active. | **Fix the highlighted field to save.** |
| `failed` | The newest relevant attempted save failed and no newer request is pending or active. | **Couldn’t save.** plus **Retry** when retry can help |

The status container uses `role="status"`, `aria-live="polite"`, and `aria-atomic="true"`. Visible
chips may use the short labels above, but their accessible announcements are domain-specific, such as
**Event settings saved** and **Event appearance couldn’t save**. Validation messages remain associated
with their fields through `aria-invalid` and `aria-describedby`. A newly returned server field error is
also announced through that domain’s status with the first field label and message. Autosave does not
move focus when a background validation error arrives; stealing focus while the host is editing another
field is more disruptive than the error it would announce.

The interface may render **Saved** immediately on first load. On blur, a raw value that canonicalizes to
the confirmed baseline is normalized visibly and returns to **Saved** without a request because it has
no semantic change. Any semantic change requires a successful Worker response before it returns to
**Saved**.

## 9. Queue and response semantics

### 9.1 Snapshot identity

Every domain defines a canonical serialized snapshot:

- general settings serialize trimmed/canonical form values, booleans, deadline, and roster version;
- appearance uses the existing canonical event-theme serializer.

Equivalent snapshots do not enqueue duplicate requests, but equivalence is evaluated against the
confirmed baseline, in-flight snapshot, and pending snapshot together. A response is associated with
the exact snapshot sent, not with whichever draft happens to be on screen when it resolves.

A baseline reversion has two distinct outcomes:

- if changed snapshot A is only scheduled and the host returns to confirmed baseline B, A is cancelled
  and no request is sent; and
- if A is already in flight, returning to B queues B behind A even though B equals the prior baseline,
  because A may already commit or its response may be lost after commit.

### 9.2 Edits during a request

Inputs remain enabled while autosave is active. If the host edits again:

1. the draft and preview update immediately;
2. the newest valid snapshot replaces the pending snapshot;
3. the in-flight request is allowed to finish; and
4. the newest pending snapshot starts next.

Aborting `fetch` is not used as the ordering guarantee because an aborted request may already have
committed on the Worker. Serialization is the guarantee.

Validity belongs to the latest complete domain draft. If a valid scheduled snapshot becomes invalid
before it starts, the scheduled/pending snapshot is cancelled rather than saving historical intent.
An already in-flight request may finish, but it cannot replace, validate, or clear errors on the newer
invalid draft. Because general settings is one complete atomic payload, one invalid general field
temporarily blocks every general-setting change, including otherwise valid toggles; the status names
the blocking field. Appearance follows the same rule when raw color text is invalid even though its
last-valid preview remains visible.

### 9.3 Successful responses

When a response succeeds:

- its normalized value advances the saved baseline for the snapshot it represents;
- it replaces the visible draft only if the visible draft still represents that snapshot;
- a newer visible draft remains untouched and becomes the next pending save; and
- parent event state merges only the response-owned fields.

Each editable field/config member carries an edit generation. If a newer draft exists, server
normalization from the response is rebased into members that have not changed since that request while
newer members remain untouched; the pending complete snapshot is then regenerated. This avoids both
clobbering new input and repeatedly re-sending an old unnormalized value.

The general-settings response merges name, welcome, time zone, deadline, RSVP state/version, and the
three photo/gallery/moderation switches. The theme response merges only `theme`. Cover responses merge
only cover state. No whole-event response may blindly replace newer state owned by another queue.

The general settings mutation consumes the event returned by `PATCH /settings`; it does not call the
five-request manager `refresh()`.

Parent read-only consumers, such as the manager heading, display the latest confirmed server state.
They may therefore show confirmed snapshot A while the Settings editor already displays pending draft
B. That is intentional and ends when B succeeds; an older response must never overwrite B or become
the final persisted state after B has been queued.

### 9.4 Failures and retry

A failed request never discards the draft or appearance preview.

- A response may attach validation errors only when its snapshot still represents the latest draft.
  Errors from superseded snapshot A never attach to newer snapshot B.
- A current server field-validation response moves the domain to `invalid`, attaches and announces the
  matching errors, suppresses automatic retry, and hides Retry until the draft is corrected.
- Retryable network and non-field errors produce **Couldn’t save** and a **Retry** button.
- Retry sends the newest valid draft, not the historical snapshot that originally failed.
- A newer valid edit clears a non-field failure presentation and enters the queue normally. A server
  field error remains until that field’s edit generation changes or a server-owned dependency named by
  the error changes; editing an unrelated field cannot clear it or resend the same refused state.
- Invalid drafts suppress all writes until corrected; Retry is not offered for a still-invalid draft.

If snapshot A fails while newer valid B is pending, B starts immediately. A’s retry control, field
errors, and generic failure status are suppressed because they describe superseded intent. If the
current draft is invalid, `invalid` takes visible precedence over an older in-flight or failed state. If
the current draft is valid and pending/saving, **Saving…** takes precedence over an older failure.

Credential and lifecycle failures keep the manager’s existing recovery classification. Expired or
revoked manager credentials, disabled accounts, and ended/deleted events escalate to the visible
manager recovery notice instead of offering a futile local Retry. Retry remains for transport failures,
5xx responses, and other conditions that can reasonably succeed without changing access.

`RSVP_ROSTER_INVALID` covers both roster races and deterministic roster problems. The client refreshes
the event once. It retries only when the returned `rsvpRosterVersion` differs from the version in the
failed snapshot (or the route’s stale-version field error identifies the race), then rebases dirty
local fields and retries once. A same-version refusal such as an empty, ambiguous, nameless, or
over-capacity roster is terminal and its Worker message is associated with **Accept RSVPs**. A second
race refusal becomes a visible failure so autosave cannot loop indefinitely. The host’s current draft
remains on screen throughout. If a later RSVP-panel mutation advances `rsvpRosterVersion`, the editor
clears that version-owned RSVP error, revalidates the preserved `rsvpEnabled` intent, and automatically
enqueues it when the complete draft is valid. It may be refused again at the new version, but it never
requires an artificial off/on toggle after the host repairs the roster.

### 9.5 Page and destination exits

Changing manager destinations flushes valid scheduled drafts and lets their queues continue while the
hidden Settings subtree stays mounted.

React Router navigation (including Brand, account links, and browser Back) is blocked while either
domain is unconfirmed. A valid draft is flushed and an accessible navigation prompt reports that
changes are saving; the requested navigation proceeds automatically after the queues confirm it. The
prompt always offers **Leave now** so a stalled network cannot trap the host. Its copy states that a
change already sent may still finish; the action discards only local scheduled, pending, invalid, or
failed intent and cannot revoke an in-flight Worker commit. If the draft is invalid or saving fails, the
prompt also offers **Stay and fix settings**; leaving is always explicit.

Full-document exit uses `beforeunload` while either editor differs from its confirmed baseline or has a
scheduled, in-flight, invalid, or failed write. Browsers may cancel background requests during page
exit, so the product must warn rather than claim a guaranteed last-millisecond save. The listener and
router blocker are removed as soon as both domains are confirmed saved.

## 10. General settings editor

The inline form in `ManagerPage` becomes a dedicated controlled `EventSettingsEditor`.

It owns:

- the current draft;
- the last server-confirmed settings baseline;
- dirty-field tracking;
- client and server field errors;
- the general-settings autosave queue; and
- the accessible save status.

While it remains mounted, incoming parent event changes are reconciled by ownership. Server-owned
`rsvpRosterVersion` always advances; untouched settings adopt newly confirmed parent values; dirty
fields remain local; and any pending complete payload is regenerated with the newest roster version.
This covers same-page RSVP manager mutations without forcing an avoidable stale autosave.

Client validation mirrors the Worker’s usable-input rules before enqueueing:

- trimmed event name is 1–80 characters;
- trimmed welcome message is 1–500 characters;
- time zone is a valid IANA zone and is canonicalized;
- deadline is a real `YYYY-MM-DD` local date on or before the event date; and
- all toggle values are booleans.

The Worker remains authoritative and repeats every check, including open-entry and roster rules.
Server normalization updates the confirmed baseline without overwriting a newer draft.

## 11. Event appearance editor

The existing saved/draft/preview separation remains. Manual-save behavior changes as follows:

- valid preset and color drafts enter the appearance queue;
- partial or invalid hex text retains the previous valid preview and does not enqueue;
- entering invalid raw color text cancels any not-yet-started appearance snapshot;
- contrast-invalid choices remain field errors and do not enqueue;
- theme controls remain editable during a theme save;
- cover controls use only their cover-specific busy state;
- **Save appearance** is removed; and
- copy no longer says that color changes remain preview-only until save.

The preview still updates immediately from the newest valid local draft. Guests continue to receive
only the last Worker-confirmed theme.

## 12. Accessibility and interaction requirements

- Removing submit buttons must not remove either form’s semantic grouping or keyboard behavior.
- Enter in a single-line setting or hex field flushes the valid draft and does not reload the page.
- Status changes are polite, atomic announcements and do not repeatedly announce equivalent states.
- Every field error has a stable description id and matching `aria-describedby`.
- Background errors never move focus.
- Server field errors are announced with their domain, field label, and message even when focus stays
  elsewhere.
- Retry is a real button with a minimum 44×44 CSS-pixel target.
- Hidden Settings content is excluded from tab order and the accessibility tree.
- A hidden-editor failure also appears in the visible manager notice with a route back to Settings.
- Saving, validation, failure, and Retry insertion preserve the host’s scroll position.
- The 320 px and 390 px manager layouts remain contained after both Save buttons are removed and status
  or Retry content appears.

## 13. Testing strategy

### 13.1 Autosave queue unit tests

Add deterministic fake-timer/deferred-promise tests proving:

- 600 ms debounce;
- blur and explicit flush;
- one request in flight;
- latest pending snapshot replaces intermediate snapshots;
- scheduled A cancelled by a preflight reversion to baseline B;
- in-flight A followed by baseline reversion B sends B after A;
- valid-to-invalid transitions cancel scheduled/pending historical snapshots;
- a slow older response cannot overwrite a newer draft;
- failure for superseded A cannot attach errors to or block pending B;
- normalized responses update only the matching baseline;
- canonical-equivalent raw edits normalize locally without a request;
- failures preserve the newest draft;
- Retry sends the newest valid snapshot; and
- cleanup does not discard a flushed request.

### 13.2 General settings UI tests

Cover:

- controlled initial values and removal of **Save settings**;
- immediate toggle/date saves;
- debounced text/time-zone saves;
- complete payload construction;
- invalid intermediate-value suppression;
- domain-wide blocking and field-specific feedback when one complete-payload field is invalid;
- field-error associations and status announcements;
- current server field errors becoming non-retryable invalid state while superseded errors are ignored;
- returned normalization without draft clobbering;
- roster-version rebase and bounded retry;
- deterministic roster-invalid refusal without retry;
- field-error lifetime by field/dependency generation and automatic revalidation after a later roster
  version;
- same-page parent/roster updates rebased into untouched state;
- credential and lifecycle failures escalating to existing manager recovery rather than futile Retry;
- destination-switch flush;
- React Router Brand/account/Back navigation blocking, including honest **Leave now** semantics during
  a stalled or in-flight save;
- hidden-destination invalid/failure escalation; and
- `beforeunload` registration only while unconfirmed work exists.

### 13.3 Appearance UI tests

Replace manual-save expectations with coverage for:

- preset, preset-color, and Reset immediate autosave;
- color input debounce;
- local preview before confirmation;
- invalid color suppression;
- edits made while a request is active;
- response ownership and latest-draft preservation;
- failure and Retry; and
- cover operations remaining independent.

Add cross-domain deferred-response coverage proving that a delayed general response cannot restore a
stale theme or cover, a delayed theme response cannot restore stale general settings or cover, and a
delayed cover response cannot restore stale settings or theme.

### 13.4 Integration and browser tests

- Manager Settings contains no Save buttons.
- Switching away immediately after a valid edit still persists it.
- Saving, Saved, invalid, failure, and Retry states remain axe-clean.
- Dual simultaneous statuses announce **Event settings** and **Event appearance** distinctly.
- Status/error insertion does not move focus or scroll.
- Client-route navigation cannot trap the host on a stalled request and cannot discard changes without
  explicit confirmation.
- Status and Retry fit at 320 px and 390 px.
- Existing exact visual baselines are inspected and refreshed only where button removal or new status
  copy intentionally changes the composition.
- Existing Worker settings/theme tests remain green because endpoint contracts do not change.
- Worker regression coverage proves a settings-open request cannot reopen intake after entry disable,
  including the guarded update’s error classification.
- Existing manual-save documentation and assertions are updated in `design/fidelity-ledger.md`,
  `design-qa.md`, the 2026-07-29 event-theming design and plan, `tests/ui/app.test.tsx`, appearance UI
  tests, and event-theming E2E coverage.

## 14. Acceptance criteria

The feature is complete when:

1. no ordinary general-setting or appearance change requires a Save button;
2. the newest valid semantic intent reaches the Worker under the approved timing rules, while
   deliberately coalesced intermediate edits do not need separate requests;
3. rapid edits cannot let an older same-page snapshot overwrite a newer draft or remain the final
   persisted value; read-only parent surfaces may show the last confirmed snapshot while a newer draft
   is visibly saving;
4. invalid drafts make no request and identify the blocking field accessibly;
5. failed writes preserve the draft and can retry the newest intent;
6. leaving Settings does not discard a pending valid edit;
7. client-route and full-page exits cannot silently discard an unconfirmed edit;
8. cover and explicit/destructive actions preserve their current contracts;
9. mutation responses do not clobber unrelated event state or trigger the full manager refresh;
10. a delayed settings write cannot reopen guest intake after the printed entry is disabled;
11. existing manual-save docs, tests, and intentional visual evidence are migrated to autosave; and
12. focused tests plus the repository’s complete typecheck, lint, unit/Worker, build, PWA, E2E
    TypeScript, Wrangler-types, and Playwright gates pass on the final implementation head.
