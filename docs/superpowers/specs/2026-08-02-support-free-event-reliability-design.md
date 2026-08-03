# Candidary Support-Free Event Reliability Design

- **Status:** Approved design; implementation planning pending written-spec review
- **Date:** 2026-08-02
- **Scope:** Product reliability from event creation through final export

## 1. Decision

Candidary will pause broad feature expansion and spend its next product cycle proving that a new host
can run a real event without operator help. The product remains a private, mobile-first household RSVP
and photo-delivery tool. It does not continue outward into seating, catering, vendors, ticketing,
payments, or a general event-planning suite.

The reliability program has five linked outcomes:

1. one canonical, identifiable release across source, Worker, assets, and D1;
2. explicit and recoverable states throughout the existing guest and host journeys;
3. a server-derived event-readiness summary in the existing Manager shell;
4. a bounded, reversible rehearsal using the event's real printed QR; and
5. physical-device and real-event evidence strong enough to decide whether feature work may resume.

This document is a product and system design. It does not authorize a merge, remote migration,
deployment, production write, or pilot enrollment.

## 2. Current-state boundary

At the time of this design, local and remote-tracking `main` point to `c3eeb247`, while
`agent/date-driven-guest-phase` points to `cdbfe343`. The histories contain two commits unique to
`main` and four unique to the lifecycle branch. Migration `0010_event_start.sql` and the complete
date-driven guest lifecycle exist only on that branch in the current source graph.

That graph proves a source split; it does not prove what is currently deployed. Live Worker, asset,
binding, and D1 state must be read again before any integration or release action. New reliability
schema must not claim a migration number until the canonical branch and remote migration ledger agree.
The lifecycle work must be reconciled through a reviewed integration rather than copied piecemeal or
assumed present because an earlier deployment report said it was present.

## 3. Product contract

### 3.1 Host promise

A host prints one event code. That code remains the entry point for household RSVP before the event
and private photo delivery at the event. The host can prepare the event, recover from ordinary
failures, run it, and retrieve the original files without understanding D1, R2, Worker deployments,
credentials, or internal lifecycle flags.

RSVP and photo contribution remain independent capabilities. A guest is never required to RSVP in
order to contribute photos when normal photo intake is open.

### 3.2 Support-free journey

The measured journey is:

1. create an event;
2. add or import the household roster when RSVP is used;
3. set the event schedule;
4. print the durable event QR;
5. review the readiness prerequisites and resolve every blocker;
6. complete an observation-only real-device rehearsal before distributing invitations;
7. confirm **Ready for guests**;
8. run RSVP and the live event;
9. recover from at least one ordinary interrupted request; and
10. prepare, download, and reconcile the complete export.

“Unassisted” means the host receives only the standard onboarding and in-product guidance. A person
may always intervene to prevent loss or exposure, but any event receiving bespoke instructions,
manual data repair, an operator-only command, or a configuration change made on the host's behalf is
recorded as assisted.

### 3.3 Success threshold

The reliability cycle graduates only when:

- at least seven of eight consecutive first-time hosts complete the journey unassisted;
- all eight can identify, from the product itself, when RSVP stops accepting changes and when the
  private photo drop opens, without an operator correcting their interpretation;
- all eight avoid a broken durable QR, incorrect lifecycle, privacy exposure, credential leak, data
  loss, unrecoverable host access, unrecoverable RSVP or photo delivery, false readiness result,
  stranded rehearsal cleanup, and unusable export;
- current physical iPhone Safari and Android Chrome evidence exists for the piloted release;
- VoiceOver and TalkBack each have a separate completed pass; and
- source, deployment, and migration evidence identify the same release.

## 4. Goals and non-goals

### 4.1 Goals

- Make release truth inspectable and repeatable.
- Make loading, empty, retryable failure, terminal failure, success, and stale evidence visibly
  distinct throughout core journeys.
- Preserve valid user input across retryable failures and conflicts.
- Give the host one compact, truthful readiness summary without adding another Manager destination.
- Exercise the production event's actual printed QR and core services safely before invitations leave
  the host's control.
- Guarantee that an expired rehearsal cannot keep early photo access open.
- Clean test data by explicit ownership and expose incomplete cleanup rather than hiding it.
- Record enough evidence to make release and expansion decisions without retaining guest data.
- Preserve Candidary's existing event-scoped theme, mobile interaction patterns, privacy boundaries,
  and attendance-only household RSVP.

### 4.2 Non-goals

- No meals, dietary requirements, accessibility questionnaires, seating, vendors, budgets, ticketing,
  payments, schedules of activities, or general planning dashboard.
- No household-specific printed QR codes.
- No requirement to RSVP before ordinary photo contribution.
- No permanent social feed, video pipeline, or offline-first synchronization system.
- No seventh Manager destination and no readiness settings duplicated from existing Manager controls.
- No claim that browser metadata proves a physical scan or a particular physical device.
- No automatic deployment or remote migration in the aggregate release command.
- No unrestricted public-creation launch as part of the controlled reliability pilot.

## 5. Strategy and sequence

The chosen strategy is a **reliability ladder**: establish lower-layer truth before adding a higher
layer that reports on it.

A polish-only pass was rejected because it could improve copy while leaving source drift, physical
evidence, cleanup, and export risk unresolved. Continuing feature expansion was rejected because every
new event-management domain would increase the number of states that must be supported before the core
journey has been proven.

Work proceeds in this order:

1. reconcile the lifecycle branch, `main`, and live release evidence;
2. add one aggregate local release gate and its evidence manifest;
3. repair misleading or unrecoverable states in existing core surfaces;
4. add the server readiness projection and persistent Manager strip;
5. add the rehearsal coordinator and cleanup reconciliation behind disabled enrollment;
6. pass automated, protected-candidate, physical, and accessibility gates and certify the runtime;
   and
7. enable enrollment and run the frozen eight-event pilot.

The readiness interface must not ship ahead of release convergence. A polished green status on top of
unknown source or migration state would be worse than having no readiness status.

## 6. Reliability architecture

Readiness reports existing truth. It is never a second source of event state.

| Unit | Responsibility | Dependencies | Must not do |
| --- | --- | --- | --- |
| Release evidence | Identify the reviewed SHA, generated assets, migrations, automated results, deployment result, and physical evidence | Git, repository scripts, Wrangler read operations, evidence ledger | Deploy, migrate, or certify a different SHA implicitly |
| Guest lifecycle resolver | Resolve guest phase and RSVP access from authoritative event configuration and server time | D1 event state, durable entry state, server clock | Trust browser time or a client-maintained lifecycle flag |
| Session-scoped rehearsal capability | Authorize pairing, synthetic RSVP, and early test upload for one paired guest session until the server lease ends | Active rehearsal, pairing proof, current fingerprint, server clock | Change the event-wide guest phase or authorize an unpaired session |
| Interaction state owners | Represent loading, content, empty, retryable failure, terminal failure, and confirmed success for one surface | Existing APIs and local draft state | Turn a failed read into an empty collection or erase a retryable draft |
| `EventReadinessService` | Build an authenticated, read-only projection of current event checks and latest rehearsal evidence | Event, roster, entry, lifecycle, rehearsal repositories | Persist a readiness boolean or mutate a setting |
| `RehearsalCoordinator` | Start, pair, observe, expire, complete, cancel, and reconcile one event rehearsal | Existing manager authorization, shared RSVP/upload validators and storage primitives, isolated rehearsal repositories | Mutate the normal roster/media namespace or delete an artifact it does not own |
| Reliability evidence ledger | Retain minimal release, device, rehearsal, cleanup, and pilot outcomes | Release output and coordinator results | Retain guest names, bodies, credentials, filenames, IPs, or device fingerprints |

The date-driven lifecycle remains the only event-wide guest-phase authority. Rehearsal access is a
separate session-scoped capability checked by both guest-event projection and upload authorization; it
does not become another input that changes the event-wide phase. Every capability check requires an
active lease, a paired guest session, the current configuration fingerprint, and server time before
allowing synthetic RSVP or early test upload. Normal entry exchange, RSVP, photo intake, delivery, and
export remain unchanged for sessions without that capability.

The guest event contract exposes rehearsal pairing/access and lease information in a separate,
explicit field. It never changes the event-wide `phase` to `photos-primary` merely because one session
is paired. The guest UI renders the guided test upload from that scoped field while the ordinary phase
continues to describe what real guests would see.

The readiness composition reuses the reconciled lifecycle branch's `resolveEventSchedule`,
`resolveGuestEventPhase`, `resolvePhotoIntake`, and `isRsvpConfigured` authorities; the existing shared
RSVP collision/capacity validators; and a read-only roster composition. Printed-entry status comes
directly from `EventEntriesRepository.getForEvent()`. Readiness must not call legacy-entry recovery,
`requireOpenEntry()`, rotation, or any service that can adopt or mutate credential state.

The Worker exposes two identifiers that do not exist in current `main`: an immutable build SHA injected
during the build and the Workers Version Metadata identifier available at runtime. A checked-in
`GUEST_JOURNEY_VERSION` constant changes only for material guest-path behavior. The redacted release
manifest records all three values. Missing runtime identifiers fail the release check closed.

## 7. Event readiness projection

### 7.1 Read model

`GET /api/manage/events/:eventId/readiness` returns a fresh projection for an authorized manager. The
shape includes:

- `evaluatedAt` from server time;
- the deployed release identifier and guest-journey contract version;
- one overall pre-event status;
- named checks with `pass`, `attention`, `not_applicable`, `running`, or `stale` state;
- a short blocker and the existing Manager destination that resolves it; and
- the latest rehearsal state and minimal evidence summary.

No route accepts a readiness status from the client. No table stores `event_is_ready`. The service
computes the result on every read from authoritative rows.

The required checks are:

1. **Certified release:** the runtime build SHA and Workers Version Metadata identifier match a
   certified, redacted deployment manifest whose migration and required physical-evidence references
   are current. Unknown or mismatched evidence fails closed.
2. **Event timing:** event start, IANA time zone, RSVP deadline when used, and photo-opening rules form
   a valid server-resolvable schedule.
3. **Guest list:** when `isRsvpConfigured(event)` is true, at least one active household exists and the
   roster satisfies the existing uniqueness, capacity, named-guest, and plus-one constraints. Pausing
   RSVP does not make this check disappear. It is not applicable only to a legacy event for which the
   authoritative lifecycle says RSVP was never configured.
4. **Printed event QR:** the durable entry exists and is enabled. Routine **Sign out guest devices**
   rotation does not fail this check because it must leave the printed credential unchanged.
5. **Rehearsal:** the latest completed evidence matches the current lifecycle fingerprint and
   guest-journey contract version.
6. **Cleanup:** no active, expired, or partially cleaned rehearsal owns residual artifacts.

### 7.2 Overall states

The pre-event state is derived in strict priority order:

1. **Cleanup required** when a rehearsal is terminalizing, expired, fingerprint/release-mismatched, or
   still owns a live write capability or artifact after completion, cancellation, or expiry.
2. **Rehearsal active** only while the one live rehearsal lease and its fingerprint/release match are
   current.
3. **Needs attention** when release, schedule, roster, or printed entry has a blocker, or prior
   evidence is stale.
4. **Ready to rehearse** when configuration checks pass but no current completed rehearsal exists.
5. **Ready for guests** only when every applicable check passes and current cleanup is confirmed.

A readiness request failure is rendered as **Couldn't check readiness** with retry. It is not mapped
to **Needs attention** and never falls back to a cached green status without marking it stale.

The five setup states stop making a pre-event claim once server time reaches authoritative
`eventStartAt`, regardless of whether photo intake is open, early, or paused. The same placement may
then show a neutral lifecycle summary and links to existing Intake and Share/export surfaces; it must
not continue telling the host that a live event is “ready for guests.”

### 7.3 Manager placement and interaction

A compact readiness strip sits directly below the event identity and remains visible across all six
existing Manager destinations during setup. It contains one status, the most important next action,
and an accessible disclosure control. Expanding it inserts the detail panel in place; it does not open
a modal or navigate away from the host's current work.

The strip replaces the current event-wide lifecycle summary row rather than stacking another banner
above it. Existing private-delivery count, storage, and purge facts remain available in their Intake,
utility, and live-lifecycle presentations; they are not duplicated in the compact setup strip.

The expanded panel lists each derived check and links repair actions to the owning surface. Schedule
opens Settings, roster opens the existing RSVP destination, printed-entry help opens Share, and export
recovery opens the export panel embedded in Share. Repair actions use the Manager's existing in-page
section owner and unsaved-work guards rather than introducing parallel routes. The panel does not
reproduce those controls. Focus remains on the disclosure when it opens or closes, async updates use a
polite live region, and failure alerts do not move focus unexpectedly.

On a phone, the strip and expanded panel remain full-column content within the current Manager shell.
Event theming does not style this global host chrome.

## 8. Rehearsal coordinator

### 8.1 Eligibility and authorization

The exact-event rehearsal is available only while:

- the event is before its start and printed entry is enabled;
- RSVP access is still editable when `isRsvpConfigured(event)` is true;
- the certified-release, timing, roster, and printed-entry checks pass, explicitly excluding the
  rehearsal check itself from start eligibility;
- no other rehearsal is active or awaiting cleanup; and
- the host confirms that invitations containing the event QR have not been distributed.

During the controlled pilot, the event must also carry a server-authoritative pilot enrollment issued
by the separate cohort-enrollment authority described in Section 15. A public client assertion or
manager checkbox cannot enroll an event.

The attestation timestamp is retained, but no free-form explanation is collected. Events whose QR is
already circulating use a dedicated disposable rehearsal event and live-safe checks. That evidence is
labelled as rehearsal-event evidence and cannot be presented as exact-event **Ready for guests**. The
first pilot therefore enrolls only new events that can complete the exact-event flow safely.

All coordinator mutations use existing event-manager authorization and an idempotency key. D1 enforces
at most one active rehearsal per event. A retry returns the prior result rather than creating another
test household or window.

### 8.2 State machine

The persisted coordinator states are:

- `active`: a bounded test window exists;
- `cleanup_required`: access is closed, but an issued write capability has not yet expired, an
  explicitly owned artifact remains, or final absence has not yet been proven; and
- `completed`: the observed steps passed and cleanup was confirmed.

No row is equivalent to not started. A cancelled rehearsal that cleans successfully contributes no
completion evidence and returns the event to **Ready to rehearse**. Completion, cancellation, expiry,
and retry all enter the same cleanup reconciler.

Before any cleanup side effect, a compare-and-swap transition closes the lease and persists
`terminalIntent = complete | discard`. `complete` is permitted only when every required observation
was already confirmed before expiry; cancellation and expiry always persist `discard`. If completion,
cancellation, and expiry race, the first valid compare-and-swap wins, except that server time at or
after expiry always refuses completion. Cleanup retries cannot change the terminal intent.

Valid transitions are:

```text
not started -> active -> cleanup succeeds + complete intent -> completed
                    \-> cleanup succeeds + discard intent -> not started
                    \-> cleanup fails -> cleanup required
cleanup required -> cleanup succeeds + complete intent -> completed
                 \-> cleanup succeeds + discard intent -> not started
```

`completed` is written only after the test passes and the cleanup reconciler proves that no owned test
artifact or live signed-write capability remains. A `discard` reconciliation deletes the rehearsal row
after recording only non-sensitive operational outcome counters; it never creates completion evidence.
A cleanup retry is safe in every non-active state.

### 8.3 Starting a rehearsal

Start re-reads every precondition in the same server operation; a readiness response viewed seconds
earlier is not authorization. It then:

1. records the event configuration fingerprint, release identifier, journey contract version, start
   time, and a server-time expiry exactly 30 minutes later;
2. creates one synthetic household in an isolated rehearsal namespace when `isRsvpConfigured(event)`
   is true;
3. creates an inactive session-scoped rehearsal window that grants no guest an exception until pairing
   succeeds; and
4. returns the generated synthetic lookup instructions, two empty device slots, and waiting state to
   the expanded readiness panel.

The host scans the actual printed QR on two phones. After ordinary credential exchange and redirect,
an authenticated guest-session POST may request an eight-character base32 pairing code only while the
inactive rehearsal window is current. The response displays the plaintext once in a clearly labelled
rehearsal notice; D1 stores a domain-separated digest bound to event, rehearsal, and guest session. The
code expires after five minutes, reissue invalidates the prior digest for that session, and successful
Manager claim consumes it once. Manager claims are authorized, idempotent, and limited to ten failed
attempts per rehearsal in fifteen minutes. The Manager never receives an enumerable list of guest
sessions.

The host enters each code into one of two Manager device slots and records a device category from a
small enumeration. Only a successfully claimed session receives the scoped rehearsal capability. This
proves that two distinct event sessions reached the real entry path without inferring a physical
platform; no user-agent string or fingerprint is retained. Pairing UI never appears outside an active
rehearsal.

The synthetic household and its answers live in rehearsal-owned D1 tables, not the normal roster. The
rehearsal RSVP path reuses the production normalization, lookup ambiguity, household response,
attendance, plus-one, validation, and idempotency contracts while writing through the isolated
repository. It therefore cannot advance the host roster version or enter normal Manager counts,
search, CSV, notification, or export queries. When `isRsvpConfigured(event)` is false, the roster and
RSVP observation are not applicable.

Rehearsal uploads likewise use rehearsal-owned reservation/media rows and an R2 key namespace derived
from the immutable rehearsal ID. They reuse production file limits, signing, transfer, signature and
dimension inspection, finalization, and manager-authorized private-read primitives without changing
normal event counters, Intake, contributions, Gallery, quota, or Export. This isolated lane is a
safety boundary, not evidence that normal storage/counter queries work; the production-like disposable
event and load gates in Section 14 provide that evidence.

Normal guests remain governed by the real lifecycle, and normal photo contribution remains independent
of RSVP. The paired capability exists only to exercise the exact event's printed entry and core guest
experience without contaminating real event data.

### 8.4 Observed completion

The coordinator marks individual evidence only after existing services confirm:

- two distinct linked guest-entry sessions;
- a successful synthetic household lookup and RSVP write when RSVP is configured;
- at least one finalized rehearsal-media row in `stored` state;
- a successful manager-authorized read or HEAD of that exact original through the shared private
  delivery service; and
- host confirmation of the physical device categories used.

The system does not treat a button press, client callback, selected file, reserved upload, or preview
as delivery evidence. A transferred object whose finalization failed is not success.

### 8.5 Expiry and cleanup

The session-capability guard compares the lease, paired session, current fingerprint, and journey
version on every guest projection, rehearsal RSVP request, upload reservation, upload finalization, and
private original read. Once the 30-minute lease expires or the fingerprint stops matching, the
exception is denied even if the manager browser is gone, a scheduled job is late, or R2 cleanup fails.
Rehearsal access never depends on a browser timer.

Every rehearsal upload reservation and signed PUT expires no later than the rehearsal lease and uses a
shorter two-minute maximum when less time remains. The reservation records the exact signed-write
`notAfter` time. Finalization rechecks the active capability and refuses after expiry; if an object
arrived after authorization ended, the reconciler deletes it rather than making it observable. Because
a still-valid signed PUT could recreate an object after an early deletion, cleanup cannot prove final
absence until the latest issued `notAfter` time has passed and R2 has been checked again.

Cleanup operates only on rows and object keys carrying the immutable rehearsal identity. It:

1. closes the exception first;
2. waits out every recorded signed-write capability horizon;
3. deletes test originals and every derived preview through one extracted, idempotent D1-plus-R2 media
   deletion primitive shared with the existing manager and scheduled cleanup paths;
4. removes synthetic RSVP receipts, sessions, invitees, and household data through explicit ownership
   or declared cascades;
5. invalidates rehearsal guest-session links without changing the durable printed credential;
6. verifies absence of owned D1 rows and R2 objects after the capability horizon; and
7. follows the persisted terminal intent, writing minimal completion evidence only for `complete`.

R2 and D1 cannot be treated as one transaction. Cleanup therefore keeps enough typed ownership data to
retry an R2 deletion before removing the last D1 reference to its key. Deleting an already absent
object is success. A partial pass records a non-sensitive error code, enters `cleanup_required`, and
retries through a dedicated scheduled reconciliation pass no less frequently than every fifteen
minutes. The host can also choose **Retry cleanup**, which calls an explicit idempotent cleanup POST.
The readiness GET remains side-effect-free and only reports the current state. None of those paths may
claim **Ready for guests** until reconciliation passes.

Concurrent legitimate host changes are not rolled back. Settings/schedule writes, manual photo-intake
actions, and printed-entry disablement that change the fingerprint must atomically expire a matching
active rehearsal in the same D1 batch before the new configuration becomes authoritative. The event
then enters cleanup reconciliation and explains that the rehearsal ended because the event changed.
Unrelated manager mutations remain allowed. Every capability-authorized request also requires the
stored fingerprint to match, so a stale exception is denied even if a new writer is added without the
atomic hook. Cleanup never restores an old event snapshot.

Manager event deletion refuses while a rehearsal is active or requires cleanup and links to the
reconciler. Scheduled retention purge invokes the same ownership-aware cleanup and must not delete the
last D1 object-key reference before R2 absence is proven.

### 8.6 Retained evidence and invalidation

After successful cleanup, retain only:

- event and rehearsal identifiers;
- start, expiry, completion, and cleanup-confirmed timestamps;
- tested release and guest-journey contract identifiers;
- configuration fingerprint;
- observed entry-session count;
- RSVP-applicable, RSVP-observed, upload-observed, delivery-observed, and cleanup-observed results; and
- host-declared device categories.

Do not retain the synthetic name, RSVP body, raw QR or management credential, guest-session token,
media filename or object key, IP address, user-agent string, or device fingerprint in completed
evidence. Rehearsal evidence follows the event's normal deletion and purge lifecycle.

The fingerprint covers event start, time zone, RSVP deadline and enablement, photo-opening rules, and
durable printed-entry identity/status. A change to any of those inputs makes the rehearsal stale.
Roster edits re-evaluate the independent roster check but do not invalidate entry/upload evidence.
Theme, cover, gallery, moderation, manager-link, and ordinary guest-session rotation changes also do
not invalidate it. A reviewed deployment that materially changes entry, lifecycle, RSVP, guest
rendering, upload, or delivery increments one explicit guest-journey contract version and makes prior
event rehearsal evidence stale. The pilot avoids this complexity by freezing that journey version.

## 9. Interaction reliability polish

Every core asynchronous surface uses an explicit state owner rather than deriving truth from an empty
array, a falsy object, or the absence of an error message. The standard states are:

- `loading`: no authoritative result has arrived;
- `content`: a successful non-empty result;
- `empty`: a successful empty result;
- `retryable_error`: the prior confirmed content or draft is preserved and retry is available;
- `terminal_error`: the reason and safe next route are explicit; and
- `confirmed_success`: the server has committed the intended operation.

The first implementation pass must cover these known gaps:

1. **Guest secondary panels.** Gallery, this-device deliveries, and notes each own their loading,
   empty, and failure state. A failed lazy read must not render the same quiet/empty copy as a
   successful empty collection. Each retry affects only its panel. Note submission preserves the text
   until the server confirms success and announces both success and failure. Direct full-screen access
   distinguishes a private gallery, a confirmed empty gallery, and a failed gallery read.
2. **Manager RSVP initial reads.** Summary, active roster, archived-history probe, filters, and
   pagination retain independent results and errors. If the first summary or list request fails, the
   panel must not present zero totals, an empty roster, or the guest-list intake launcher as confirmed
   truth. Retry does not clear a valid older page before replacement arrives.
3. **Confirmation-code resend.** Both account surfaces expose idle, sending, sent, rate-limited, and
   failed states. A rejected resend produces an alert and preserves the existing code-entry path; a
   success provides a server-confirmed message and does not rely only on a temporarily disabled link.
4. **Product promise and labels.** Landing, creation, Share, lifecycle mail, guest entry, and readiness
   use one coherent promise: the printed code handles RSVP now and private photos later. Invitation
   lookup names and optional photo bylines remain visibly different concepts. “Photo intake” and
   “guest-list intake” are not presented as the same operation.
5. **Readiness itself.** A failed projection is unknown, not green and not an event configuration
   blocker. Stale cached detail is visibly marked and never drives a rehearsal mutation.
6. **Existing write recovery.** RSVP, upload, Settings autosave, roster import, moderation, and export
   continue to preserve current drafts or confirmed content across retryable failure. This program
   fixes violations it encounters but does not redesign the separately approved Settings autosave
   contract.

All refusal and recovery copy names what happened, what remained safe, and the next action. Stable API
error codes and request IDs may be exposed for diagnostics; raw server messages and sensitive values
may not.

## 10. Support-free export completion

Complete export remains one shared component rendered in the Share destination on narrow screens and
the Manager utility rail on wide screens. It is not a seventh destination. The host-visible state
model is:

- **Not prepared:** no export snapshot exists;
- **Nothing to export:** an authoritative read confirms zero retained originals;
- **Preparing:** the existing queued or running Workflow owns one snapshot;
- **Failed:** originals remain safe and the same panel offers the existing idempotent retry;
- **Ready to save:** the server has reconciled the manifest and every numbered part;
- **Links expired:** the ready objects still exist and the host can issue fresh short-lived download
  links without rebuilding the export;
- **Export expired:** the 24-hour prepared objects are gone, while retained originals can produce a new
  snapshot; and
- **Host confirmed saved:** the host explicitly completed the download checklist for the current
  snapshot.

The server may report **Ready to save** only when part numbers are contiguous, the sum of part media
counts equals the snapshot media count, the manifest has exactly one row per snapshot original, and
every expected R2 object exists. The panel states the snapshot time, original count, part count, and
source bytes in plain language.

The download checklist contains the manifest and every numbered ZIP with its expected photo count and
source bytes. Opening a link is not treated as proof that a browser saved a complete file. The host
checks off each file after the common ZIP tool opens it and its count matches the panel, then confirms
the whole set. The resulting event-scoped receipt stores only export job ID, snapshot count, part count,
and confirmation time. It is labelled **Host confirmed saved**, never automatically verified.

If another original is finalized after the snapshot, the panel immediately marks the receipt and
prepared export as out of date and offers **Prepare updated export**. A failed attempt, expired signed
link, or expired prepared export never deletes or hides retained originals. The pilot journey is
complete only when the latest stored-media count matches the confirmed export snapshot, or when the
server confirms the event has no retained originals to export. Any later original invalidates either
terminal result.

## 11. Failure and recovery contract

| Failure | Required behavior |
| --- | --- |
| Readiness changed between display and rehearsal start | Start refuses atomically, refreshes the projection, and names the changed check |
| Duplicate start/complete/cancel request | The idempotency key returns the original result; no duplicate artifact is created |
| Manager navigates away or closes the browser | Server-time expiry still closes access; persisted progress resumes on return |
| Guest request or upload fails | The owning guest flow preserves its valid draft/queue and offers its existing safe retry; rehearsal observes only confirmed success |
| Rehearsal expires before completion | Access closes immediately; cleanup runs; successful cleanup returns to **Ready to rehearse** |
| R2 or D1 cleanup is partial | Enter **Cleanup required**, retain typed ownership, retry safely, and block readiness |
| Host changes fingerprinted event configuration during rehearsal | Commit the host's change, atomically expire the rehearsal, do not restore the old configuration, and require cleanup plus a fresh readiness read |
| Printed entry is disabled | Stop future rehearsal and readiness immediately; never offer a replacement credential |
| Material guest-journey release changes | Mark prior rehearsal stale through the journey contract version |
| Release/readiness evidence is unavailable | Report unknown and stop; never infer success from a prior green screen |
| Export Workflow, link, or prepared object expires | Preserve originals and confirmed prior state, then retry, reissue links, or prepare an updated snapshot as appropriate |
| New original arrives after export confirmation | Mark the receipt out of date and require an updated export before the pilot journey is complete |

## 12. Privacy, security, and trust boundaries

- Existing guest, RSVP, host, manager, media, and export authorization boundaries remain in force.
- Rehearsal rows are event-scoped and inaccessible across events.
- Rehearsal artifacts are excluded from normal counts, exports, notifications, gallery publication,
  and pilot outcome totals.
- Logs carry request IDs, rehearsal IDs, state transitions, duration, and stable error codes only. They
  never carry a submitted name, RSVP payload, credential, ciphertext, object key, or CSV row.
- The readiness endpoint reveals no secret and is available only through existing manager
  authorization.
- The Privacy and Terms routes must contain owner-approved, accurate descriptions of collection,
  retention, deletion, private delivery, and pilot measurement before a real-host pilot. Engineering
  must not invent legal promises or leave the current placeholder copy in a trust-critical release.
- The public event-creation endpoint remains controlled-pilot only. Cloudflare rate limiting,
  Turnstile or equivalent bot resistance, spike alerting, and a named abuse-response owner are
  required before unrestricted traffic, regardless of the reliability-pilot result.

## 13. Release evidence gate

### 13.1 Local immutable gate

Add one aggregate `npm run verify:release` entry point that runs the repository's existing gates from
an isolated immutable worktree at the reviewed SHA. Pre-existing dirty or untracked files in the
user's working checkout are irrelevant to the result and are never removed to satisfy the gate:

- TypeScript typecheck;
- ESLint with zero warnings;
- unit and Worker suites;
- production build;
- PWA build verification;
- production-like Playwright suite;
- Cloudflare generated-binding drift check;
- fresh-D1 migration application and targeted migration invariants;
- `git diff --check`; and
- a comparison against the isolated worktree's captured pre-run status proving generated verification
  introduced no unexplained tracked drift.

The command emits a machine-readable manifest with the SHA, guest-journey contract version, tool
versions, migration filenames, command results, test counts, artifact hashes, and start/end times. It
redacts environment values and credentials. The manifest is evidence for a candidate; it does not
deploy, write remote D1, configure bindings, or label a physical gate as passed.

### 13.2 Authorized post-deploy evidence

After separate deployment authorization, verify and record:

- the deployed Worker version and reviewed SHA;
- remote migration ledger and an empty `PRAGMA foreign_key_check` result;
- required D1, R2, Images, Email, Workflow, rate-limit, and scheduled-trigger bindings by name, never
  secret value;
- live manifest, assets, MIME types, CSP and security headers, and critical guest/manager routes;
- a legacy printed code when active legacy events exist; and
- absence of sensitive values in rehearsal-window logs.

Local success, merge, remote migration, deployment, and wedding readiness remain separate claims.

### 13.3 Runtime release certification

After post-deploy checks and the applicable Section 14 physical evidence pass, a separate,
explicitly authorized operator command records one redacted `release_certifications` row in D1. It
contains the build SHA, Workers Version Metadata identifier, guest-journey version, migration-manifest
digest, evidence-manifest digest, physical evidence references, and certification timestamp. It
contains no secret values or device-owner data.

This certification write is not part of `verify:release` or deployment. The readiness release check
passes only when the current runtime identifiers and migration digest exactly match a certification
row. A deploy, missing metadata binding, unknown manifest, or mismatched migration immediately makes
release readiness unknown or blocked; it cannot inherit the prior release's green result. Evidence
categories that remain valid across a non-material change may be referenced by the new manifest, but
the runtime version itself must always be certified.

## 14. Physical and accessibility evidence

Certification cannot depend on a feature that only works after certification. Before any pilot host is
enrolled, a separately authorized operator uses one disposable verification event and a single-use
candidate-verification grant. That grant bypasses only the certified-release prerequisite for that
event; it cannot produce **Ready for guests**, bypass schedule/entry/cleanup checks, or enroll a pilot
host. Its issuance and consumption are recorded in the redacted evidence manifest and it is revoked
before runtime certification.

On the exact stabilized release, a person records device model, OS, browser, network condition, date,
release identifier, and observed result for:

- the same reception-size printed QR on current iPhone Safari and Android Chrome;
- RSVP-primary, pre-start/waiting, and photos-primary behavior using server-authoritative time;
- ordinary **Sign out guest devices** rotation without changing the printed artifact;
- household lookup, ambiguity resolution, attendance/decline, plus-one naming, revision, deadline
  closure, and host correction;
- camera and library selection, including genuine HEIC and HEIF from an iPhone;
- private preview and byte-identical original delivery;
- partial upload, expired signed URL, and RSVP retry on degraded venue-like reception;
- gallery publish/hide behavior, privacy isolation, complete export, and recovery paths;
- guarded RSVP and wedding load harnesses plus the 10,000-photo paging/export case on disposable
  events;
- irreversible **Disable printed event QR** recovery-boundary rehearsal on a disposable event only;
- VoiceOver across guest RSVP, upload, and Manager navigation; and
- TalkBack across the corresponding Android journeys.

Desktop viewport emulation and automated accessibility checks remain supporting evidence. They cannot
be entered into the ledger as physical-device, native-picker, VoiceOver, or TalkBack passes. A material
change invalidates only the affected evidence categories, but every candidate still runs the complete
automated gate.

## 15. Frozen real-event pilot

The pilot deployment enforces cohort admission before event creation. A separate pilot owner issues a
single-use, high-entropy enrollment link to an eligible first-time host. Its fragment token is
exchanged for a short-lived HTTP-only creation grant and removed from the address bar; D1 stores only a
domain-separated token digest, expiry, consumption time, and cohort sequence. `POST /api/events`
requires and atomically consumes that grant, and the created event carries the server-owned cohort
enrollment required by the rehearsal start route. A manager checkbox, public request field, or client
flag cannot enroll an event.

Enrollment closes after eight sequential grants are consumed. Each admitted host has an upcoming real
event, has not distributed invitations, and agrees to the evidence boundary before receiving the
grant. Once consumed, that event remains in the denominator even if it is assisted or fails; cohort
order cannot be edited or backfilled. Existing and non-enrolled events cannot enter the exact-event
pilot flow. Removing the creation gate requires separate authorization and completion of the public
launch controls in Section 12.

The eight first-time hosts use one stabilized guest-journey release and receive the same onboarding.
Supervision means observation of consented product state only. The product team does not silently fix
an event or coach a host differently; any bespoke instruction or intervention marks the event
assisted.

No third-party behavioral analytics is added for the pilot. Its consented ledger contains only the
event identifier, milestone timestamps, lifecycle-comprehension result, assistance flag, severity,
and stable error codes, follows the event's normal deletion/purge lifecycle, and leaves only aggregate
cohort results after that lifecycle ends.

Feature work is frozen during the pilot. A reliability fix that changes the guest-journey contract
pauses enrollment, reruns affected automated and physical evidence, and requires affected upcoming
events to rehearse again.

### 15.1 Immediate stop conditions

Pause the pilot for any:

- privacy or credential exposure;
- loss or cross-event disclosure of guest data or media;
- broken durable QR or incorrect server lifecycle;
- unrecoverable manager access after the documented account/recovery journey;
- false **Ready for guests** result;
- unrecoverable RSVP, private delivery, rehearsal cleanup, or export;
- residual rehearsal artifact presented in ordinary event data; or
- same core-task blocker encountered by two events.

The incident is fixed and the affected evidence rerun before enrollment resumes. Events already near
their live date are protected first; the pilot metric is never allowed to discourage human safety
intervention.

### 15.2 Graduation and expansion rule

Graduation requires the success threshold in Section 3.3, a green physical/accessibility matrix, a
matching production evidence manifest, and no unresolved stop condition. Results are based on all
eight consecutive enrolled events; failed or assisted events are not replaced with more favorable
ones.

Passing the pilot permits one new discovery cycle. It does not approve a generic event-management
roadmap. The next candidate must come from repeated pilot friction, remain event-scoped and private,
and either reduce host effort or strengthen the RSVP/photo core. A new top-level product domain needs
its own strategy decision rather than inheriting permission from this gate.

## 16. Testing strategy

Implementation follows failing behavioral tests before production changes.

### 16.1 Unit and service tests

- Readiness truth table for every applicable/not-applicable/stale/blocking combination.
- Release-certification matching and fail-closed behavior for missing runtime identifiers.
- Fingerprint stability and invalidation for each event mutation and journey-version change.
- Rehearsal state transitions, terminal intent, compare-and-swap races, 30-minute server expiry,
  idempotency, and invalid transitions.
- Pairing issuance, digest domain separation, expiry, reissue, one-time consumption, and rate limiting.
- Signed-write capability horizons and final absence proof.
- Explicit ownership enumeration and deletion planning without name or prefix matching.
- Export reconciliation, stale-snapshot invalidation, link renewal, and host-confirmed receipt semantics.
- Interaction reducers for loading/content/empty/retryable/terminal/success states.

### 16.2 Worker and repository tests

- Additive populated-D1 migration, constraints, cascades, and one-active-rehearsal enforcement.
- Authorization and cross-event refusal for every readiness/rehearsal route.
- Side-effect-free readiness reads, including proof that legacy entry is never adopted by the GET.
- Atomic start preconditions and concurrent duplicate starts.
- Isolated rehearsal RSVP/media rows absent from normal roster versions, counts, search, quota, Intake,
  Gallery, contributions, notifications, and exports.
- Expired, unpaired, or fingerprint-mismatched capabilities denied by guest projection, reservation,
  finalization, and private delivery before cleanup runs.
- Signed PUT after early cleanup, late finalization, cancellation, timeout, partial R2 deletion,
  explicit cleanup POST, and scheduled cleanup integration.
- Atomic invalidation from schedule/settings, photo-intake, and entry-disable writers, plus event-delete
  and retention-purge boundaries.
- Pilot enrollment token exchange, single consumption, cohort ordering, and non-enrolled refusal.
- Sensitive-value logging regression coverage.

### 16.3 UI and browser tests

- Persistent strip placement across all six Manager destinations at desktop and mobile widths.
- Every readiness state, unknown-load state, stale transition, accessible disclosure, live announcement,
  repair link, and retry.
- Two-session rehearsal progress, navigation away/back, duplicate presses, timeout, cancellation, and
  cleanup-required recovery.
- Guest secondary-panel failures and retries without false empty states.
- Manager RSVP initial-read failures without false zero/empty/intake states.
- Confirmation-code resend success, rate limit, and failure.
- Export preparing/failure/ready/link-expiry/job-expiry/stale/host-confirmed states and multipart
  checklist recovery in both responsive placements.
- Existing full guest RSVP, upload, manager, export, theme, PWA, security, and responsive regressions.

### 16.4 Manual gates

The physical matrix and eight-event pilot are manual evidence by definition. Automated tests may
prepare fixtures and record structured results, but they must not mark those gates complete.

## 17. Implementation decomposition

This is a reliability program, not one undifferentiated feature branch. Planning and review should
retain these independently verifiable increments:

1. **Release convergence and evidence:** reconcile lifecycle source, establish the canonical SHA, and
   add runtime release identifiers, the aggregate local gate, and the redacted certification contract.
2. **Existing-state and export polish:** repair guest secondary panels, Manager RSVP initial reads,
   resend-code feedback, export reconciliation/recovery, and any equivalent false-success or
   false-empty state found by the audit.
3. **Readiness projection and strip:** add the pure server read model, contract, UI state model, and
   repair links without rehearsal mutations.
4. **Coordinator and cleanup foundation:** add terminal-intent state, isolated rehearsal repositories,
   typed ownership, capability-horizon cleanup, explicit retry, scheduler, and deletion boundaries,
   while leaving guest rehearsal access disabled.
5. **Secure session integration:** add pairing, the session-scoped capability, isolated RSVP and media
   adapters, upload/finalization expiry enforcement, private-delivery observation, and atomic
   invalidation writers.
6. **Guided rehearsal UI:** add the expanded two-device flow, progress, cancellation, timeout,
   completion, and cleanup-required recovery behind the controlled enrollment gate.
7. **Release and pilot operations:** publish approved legal copy, enforce cohort creation enrollment,
   complete production-like, physical, accessibility, certification, and real-event evidence, without
   adding feature scope.

Each increment receives focused tests and review. No increment may deploy or mutate remote resources
without separate user authorization, and later increments do not begin by assuming an earlier branch
was merged or deployed.

The first post-spec `writing-plans` pass covers Increment 1 only. Each later increment receives its own
reviewed implementation plan after the predecessor's evidence is available; this program is too broad
for one shared branch or one all-at-once execution checklist.

## 18. Acceptance criteria

The design is implemented when all of the following are true:

- one canonical source and migration history underlies the release;
- the aggregate local gate produces a redacted manifest for an immutable SHA;
- runtime build/version metadata and D1 certification must match before readiness can pass;
- known core async states never represent failure as empty content or success;
- readiness is a pure authenticated projection with the approved five pre-event states and no
  credential adoption or cleanup side effect;
- the compact strip appears across the existing Manager destinations and duplicates no setting;
- exact-event rehearsal uses the real printed QR, two one-time-paired sessions, shared production
  validators/storage primitives, a server-expiring scoped capability, and isolated synthetic data;
- timeout or browser loss cannot leave early photo access open;
- every signed rehearsal write expires by the lease, late finalization is refused, and final cleanup
  waits until object recreation is impossible;
- partial cleanup blocks readiness and recovers through explicit or scheduled idempotent work without
  touching real data;
- active/unclean rehearsal state blocks event deletion, while retention purge preserves cleanup keys;
- completed evidence contains no guest PII, credentials, filenames, IPs, or device fingerprints;
- configuration and material journey changes invalidate the correct evidence;
- complete export has explicit recovery, server reconciliation, stale-snapshot handling, and an honest
  host-confirmed saved receipt;
- owner-approved Privacy and Terms copy replaces the placeholders before a real-host pilot;
- server-enforced single-use enrollment fixes the eight-event cohort and prevents non-enrolled
  rehearsal starts;
- automated, live, physical, and accessibility claims remain distinct;
- the controlled pilot is measured against all eight consecutive events; and
- feature expansion remains frozen until the graduation rule passes.
