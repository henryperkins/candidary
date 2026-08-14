---
target: Candidary Notes guest and host guestbook experience
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-08-11T15-26-51Z
slug: src-pages-eventpage-tsx
---
Method: dual-agent (A: notes_design_review · B: notes_detector_evidence)

# Candidary Notes → Guestbook review

## Verdict

The feature is technically stronger than it feels. Guest submission is private, resilient, clearly labelled, and already combines approved notes with published photo captions. But the experience is still framed as optional utility and moderation plumbing. Guests encounter a feed; hosts encounter a queue; neither receives a durable keepsake.

The best direction is a **curated private guestbook**: preserve photo delivery as the primary task, elevate Notes into a warm secondary contribution, give hosts a pending-first curation workspace and guest preview, and make standalone notes part of a downloadable event record. Do not add replies, reactions, profiles, or public social mechanics.

## Captured flow

### 1. Guest entry — healthy primary task, low guestbook discoverability

![Guest event first viewport](</C:/Users/htper/candidary/output/design-audit/notes-guestbook/01-guest-entry-mobile-viewport.png>)

The first viewport correctly gives photo delivery the whole stage. The trade-off is that Guest notes is not visible or teased here at all, so a guest who came primarily to leave a message may never discover it.

### 2. Guest composer and shared stream — strong form, weak keepsake framing

![Open guest note composer and stream](</C:/Users/htper/candidary/output/design-audit/notes-guestbook/03-guest-note-form-mobile.png>)

The form is calm and direct, with a useful privacy sentence. The heading `Guest notes and photo captions`, taxonomy labels, and status pills make the emotional content read like a system feed. The exact outgoing signature is not repeated at the point of submission.

### 3. Submission receipt — trustworthy, but the new entry is out of sight

![Guest note submission confirmation](</C:/Users/htper/candidary/output/design-audit/notes-guestbook/04-guest-note-submitted-mobile.png>)

The success message is specific and honest. Because the feed is chronological and the new entry is appended beneath existing items, the guest is told they can see it “here” without seeing the submitted entry in the current viewport.

### 4. Host moderation on desktop — functional but queue-like

![Host Notes desktop](</C:/Users/htper/candidary/output/design-audit/notes-guestbook/05-host-notes-desktop.png>)

The Notes badge counts all messages, not work awaiting review. Approved, pending, and rejected rows all show Approve, Hide, and Delete; timestamps and a guest-facing preview are absent. The nearby “Keep every original” export covers media rather than standalone notes.

### 5. Host moderation on mobile — usable controls, inefficient at volume

![Host Notes mobile](</C:/Users/htper/candidary/output/design-audit/notes-guestbook/06-host-notes-mobile.png>)

Targets are comfortably sized, but three full-width actions per row create a very long moderation surface. A pending-first view and state-specific primary action would remove most of this repetition.

## Design health score

| # | Heuristic | Score | Main gap |
|---|---|---:|---|
| 1 | Visibility of system status | 3 | Guest feedback is strong; host actions lack row-level progress and confirmation. |
| 2 | Match system / real world | 3 | Warm guest language gives way to raw host statuses. |
| 3 | User control and freedom | 2 | Permanent deletion has no confirmation or undo. |
| 4 | Consistency and standards | 2 | Guest and host use different language and expose different content sets. |
| 5 | Error prevention | 2 | Idempotent guest sends are strong; deletion and abuse safeguards are incomplete. |
| 6 | Recognition rather than recall | 3 | Host must infer chronology and translate states. |
| 7 | Flexibility and efficiency | 1 | No pending-first view, pagination, batch path, or live Notes refresh. |
| 8 | Aesthetic and minimalist design | 3 | Guest surface is restrained; host rows are repetitive. |
| 9 | Error recovery | 3 | Guest retry preserves the draft; deleted host content has no recovery. |
| 10 | Help and documentation | 2 | Caption ownership and moderation semantics are not explained to hosts. |
| **Total** |  | **24/40** | **Acceptable — a strong guest foundation with an incomplete host workflow.** |

The guest flow has low cognitive load. The host mock has four rows with three actions each—12 moderation controls at once—so chunking, hierarchy, minimal choices, efficiency, and progressive disclosure break down as volume grows.

## What already works

- Guest notes stay secondary to private photo delivery and use the event theme rather than expanding the global Manager design language.
- Submission is unusually robust: labelled input, 500-character validation, idempotent retry, preserved failed draft, explicit pending visibility, and author-only access to unapproved content.
- Accessibility foundations are good: native disclosure, text labels, visible focus, live success/error regions, textual state—not color alone—and 44–48px controls.
- The database read already projects standalone notes and photo captions into one chronological guest feed, which is a useful foundation for a guestbook read model.

## Priority issues

### P1 — There is no durable guestbook artifact

Standalone guest notes are absent from the export workflow, which snapshots only media. Guest access expires after 30 days and the event is purged after 120 days. A sentimental feature that disappears unless a host manually copies it cannot fulfill the guestbook promise.

**Fix:** add a separately named `candidary-guestbook.html` plus CSV or JSON to the event export, include the snapshot time and visibility state, and show the download deadline. Keep the existing media manifest semantically separate.

### P1 — The host badge and queue do not represent actionable work

The badge counts all notes. The UI loads an unbounded oldest-first list at Manager startup, does not poll while Notes is open, and refreshes the whole Manager after every action. Every status exposes the same three actions.

**Fix:** default to `Needs review`, make the badge pending-only, add `Shared` and `Hidden` filters, paginate, refresh while visible, show timestamps, and render only state-relevant actions. Update the row in place and announce the new state. The API already accepts a status filter.

### P1 — Sentimental content lacks deletion and abuse guardrails

Delete is immediate and has no undo or restore route. The guest POST validates length and CSRF but has no message-specific rate limit or event/session cap, while the host list is unbounded.

**Fix:** make Hide the ordinary reversible action; move permanent Delete behind confirmation or a timed Undo. Add a per-session submission rate limit, an event-level capacity, and bounded manager pagination before promoting the feature.

### P2 — The emotional moment is framed as system status

`Guest notes`, `photo caption`, `approved`, and `awaiting review` are accurate but operational. The new entry appears below the viewport, and the signature shown near the photo flow is not repeated at the composer.

**Fix:** rename the guest surface `Guestbook`; use the receipt `Safely sent to Maya & Theo` with review detail underneath; show `Signed as Taylor Morgan · Change`; separate `Your entry` from `Shared guestbook`; and place the newly submitted card beside the receipt.

### P2 — Guest and host ownership of photo captions is split

Guests see notes and published captions together. Hosts see standalone notes in Notes and control captions indirectly through Gallery. That makes one surface feel unified to guests but fragmented to the person curating it.

**Fix:** introduce a shared `GuestbookItem` read model over existing message and media records. In the host guestbook, linked captions should show the photo and say exactly when sharing the item also shares or hides its photo. Avoid duplicating bodies or media in a new canonical table.

## Three product directions

| Direction | What changes | Trade-off |
|---|---|---|
| **Curated private guestbook — recommended** | Guestbook naming, host prompt, signature, combined preview, pending-first curation, safe deletion, rate limits, and exportable keepsake. | Medium scope; delivers the emotional and durable product promise without social-network creep. |
| **Polished Notes** | Rename the surface, fix the host queue/actions, repeat the signature, and export standalone notes. | Fastest and lower risk, but captions and the final keepsake remain only loosely unified. |
| **Social event wall** | Replies, reactions, live display, profiles, threads, and notifications. | Highest moderation/privacy cost and conflicts with Candidary’s calm, private, task-led product boundary. Do not pursue now. |

## Recommended implementation slice

1. **Make the existing flow coherent:** Guestbook naming; `Safely sent` receipt; signature at the composer; pending-only host badge; Needs review/Shared/Hidden filters; state-specific actions; timestamps; per-row feedback; undoable deletion.
2. **Make it safe at real-event volume:** bounded pagination, visible-section refresh, per-session rate limiting, an event cap, and explicit empty/error states for each host filter.
3. **Make it a keepsake:** host-authored prompt, combined guestbook preview over notes and eligible captions, and guestbook HTML plus machine-readable export before retention expiry.

Keep replies, likes, public profiles, guest search, notifications, and a new social graph out of scope. The guestbook should strengthen `contribute → retrieve`, not create another planning or community product.

## Persona and accessibility notes

- **Distracted guest on a phone:** submission is easy once found, but the feature is below the photo-first fold and the sent entry is not immediately visible.
- **Post-event host:** needs a pending-first queue, timestamps, bulk-safe review, preview, and a download that actually preserves the words.
- **Keyboard/screen-reader user:** source and DOM evidence confirm labels, live regions, status text, and large controls. Focus after moderation/delete, 200–400% reflow, VoiceOver, TalkBack, and actual screen-reader announcement order still require dedicated testing.

## Evidence limits

- Screenshots were captured in the current primary in-app-browser audit run at 390×844 and 1280×900 against a local mocked route set and inspected after saving.
- The independent design assessment could not obtain its own in-app-browser binding and therefore remained source-grounded. The independent detector completed cleanly with zero findings; its lack of findings does not evaluate product hierarchy, durability, or curation.
- The mock included multiple pending guest identities in one feed for visual stress. Production filtering shows only approved items plus the current session’s own unapproved items.
- This is not physical-device, VoiceOver, TalkBack, production-data, or full WCAG conformance proof.

## Source anchors

- Guest composer/feed: `src/pages/EventPage.tsx:343`
- Host queue/actions: `src/pages/ManagerPage.tsx:571`, `src/pages/ManagerPage.tsx:782`, `src/pages/ManagerPage.tsx:902`
- Guest/manager message routes: `worker/routes/messages.ts:40`, `worker/routes/messages.ts:82`
- Combined guest feed and unbounded manager list: `worker/db/messages.ts:114`, `worker/db/messages.ts:127`
- Media-only export snapshot: `worker/workflows/export.ts:29`
- Retention lifecycle: `worker/security/lifecycle.ts:19`

## Questions to choose the next design step

Which scope should become a design spec next: **Curated private guestbook** (recommended), **Polished Notes**, or **no expansion beyond queue hardening**?
