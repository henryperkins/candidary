---
target: Notes implementation and its UI / guest experience
total_score: 18
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 3
timestamp: 2026-08-09T21-05-55Z
slug: src-pages-eventpage-tsx
---
# Notes Implementation and Guest Experience Critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 1 | Notes provide no loading, sending, success, failure, or moderation feedback. |
| 2 | Match between system and real world | 2 | The warm language fits, but "for Maya & Theo" obscures that approved content is guest-visible. |
| 3 | User control and freedom | 1 | Collapsing loses a draft; there is no edit, retract, or undo after sending. |
| 4 | Consistency and standards | 3 | The visual system is consistent, but the product's normal status vocabulary disappears here. |
| 5 | Error prevention | 1 | Required and maxlength constraints help, but duplicate sends and visibility mistakes remain easy. |
| 6 | Recognition rather than recall | 2 | The composer is discoverable; item type, audience, and moderation state require inference. |
| 7 | Flexibility and efficiency | 2 | Native controls work by keyboard, but the only submission path is brittle. |
| 8 | Aesthetic and minimalist design | 4 | The panel is calm, focused, and correctly subordinate to photo delivery. |
| 9 | Error recovery | 0 | Read and write failures have no message, retry control, or announcement. |
| 10 | Help and documentation | 2 | The prompt is friendly, but consequential audience and moderation guidance is absent. |
| **Total** |  | **18/40** | **Poor** |

## Design Specificity Verdict

**LLM assessment:** Visually authored for Candidary; behaviorally under-specified. Warm parchment, chestnut and denim accents, personalized couple copy, and restrained disclosure hierarchy feel specific to this product. The interaction becomes a generic textarea and feed when it needs to explain who can read a note, whether it is awaiting approval, and whether sending succeeded.

**Deterministic scan:** The Impeccable CLI detector returned zero findings for `src/pages/EventPage.tsx`. That clean result is a false sense of safety for this surface: the material defects are async-state, data-semantics, and valid-content overflow problems that the static scan does not model.

**Visual overlays:** Mutable injection succeeded, but the application's CSP blocked the detector script from `localhost:8400`. No reliable user-visible overlay was produced. Browser network interception, DOM geometry, accessibility snapshots, computed contrast, and runtime errors were used instead.

## Overall Impression

The success-path screenshot is polished and the feature is placed correctly, but the Notes experience is not release-ready. The biggest opportunity is to make the implementation as trustworthy as the visual language: every send, load, and moderation state needs an explicit, dignified guest-facing meaning.

## Cognitive Load and Emotional Journey

The happy path has moderate cognitive load with two checklist failures: consequences must be held in working memory, and important sharing details are not progressively disclosed. No decision point exceeds four visible choices. The opening feels considerate and unpressured, but the emotional peak of writing a personal message ends in silence or an unhandled error rather than reassurance.

## What's Working

1. Notes remain below the primary photo task and preserve the One Primary Canvas rule.
2. The responsive composition is strong at 320px, 390px, and desktop widths; normal content remains contained and the desktop two-column layout feels intentional.
3. Native disclosure and form controls, a 72px summary, 48px submit button, visible focus treatment, and strong measured contrast provide a solid static accessibility baseline.

## Priority Issues

### P1 - Submission lifecycle is broken and permits duplicate notes

**Why it matters:** A delayed request leaves the button enabled, so repeated taps create repeated POSTs. After a successful `201`, `eventForm.currentTarget` is null after the await; `.reset()` throws before the feed refreshes or any confirmation appears. A guest can therefore send a note successfully, see no proof, retain the text, and send duplicates. Failure is also silent, while collapsing the disclosure destroys an unsent draft.

**Fix:** Capture the form before awaiting, move the draft into controlled state, implement explicit idle/sending/success/error states, disable and relabel the action while sending, announce outcomes in a scoped live region, clear only after confirmed success, preserve the draft across disclosure toggles, and add server-backed idempotency.

**Evidence:** `src/pages/EventPage.tsx:120-142,219-226`

**Suggested command:** `$impeccable harden`

### P1 - A valid long note can destroy the mobile layout

**Why it matters:** A 500-character unbroken note is valid server input but expanded a 305px document to 7,764px. One guest can make the Notes panel effectively unusable for every viewer on a phone.

**Fix:** Apply `overflow-wrap: anywhere` or equivalent containment to feed bodies and add a maximum-length unbroken-string browser test rather than the current shorter fixture.

**Evidence:** `worker/routes/messages.ts:34-40`, `src/styles.css:223,491-493`

**Suggested command:** `$impeccable adapt`

### P1 - Audience and moderation states are invisible

**Why it matters:** Approved notes are visible to guests, while pending and rejected notes remain visible only to their author. Photo captions use the same status mapping. The renderer ignores `kind`, `mediaId`, and `moderationStatus`, so all rows look shared and standalone. This is a privacy and trust failure, not cosmetic polish.

**Fix:** Explain the audience before submission, condition the copy on `moderationRequired`, label rows as `Shared`, `Waiting for host`, or `Hidden - only you can see this`, and keep photo captions visibly associated with their photo.

**Evidence:** `worker/routes/messages.ts:34-49`, `worker/db/messages.ts:90-114`, `src/pages/EventPage.tsx:134-142,219-226`

**Suggested command:** `$impeccable clarify`

### P2 - Loading, failure, and empty feeds are indistinguishable

**Why it matters:** The form appears immediately while the feed loads. A failed GET renders exactly like a successful empty feed, with no status or retry action. Closing and reopening happens to retry, but only a guest who guesses the implementation can recover.

**Fix:** Give Notes an isolated idle/loading/content/empty/retryable-error state, preserve prior confirmed content during retries, and keep retry scoped to this panel.

**Evidence:** `src/pages/EventPage.tsx:46-47,120-129,219-226`

**Suggested command:** `$impeccable harden`

### P2 - The disclosure hides a mixed, unbounded feed

**Why it matters:** `Leave a note` does not signal that the panel also contains other guests' notes and photo captions. The query returns the full oldest-first collection without pagination, so a large event can produce a slow, very long panel and place a newly sent note far below the composer.

**Fix:** Keep one secondary disclosure, but name the reading surface explicitly, separate composer and feed headings, return a bounded page, and provide `Load earlier`.

**Evidence:** `worker/db/messages.ts:80-114`, `src/pages/EventPage.tsx:219-226`

**Suggested command:** `$impeccable distill`

## Persona Red Flags

**First-time wedding guest:** `A few words for Maya & Theo` can reasonably be read as a private message. After sending, no confirmation explains whether the couple, the host, or all guests can see it.

**Older or low-confidence mobile guest:** Slow requests invite repeated taps, failures are silent, collapsing loses the draft, and the visible field label disappears once the placeholder is replaced by typing.

**Privacy-conscious guest:** The interface does not disclose that an approved note and remembered guest name appear to other guests. A pending or rejected note still looks public to its author.

## Minor Observations

- The approved 390px reference closely matches the live success state.
- All measured normal-state touch targets and contrast values met the intended floors.
- Existing tests cover static rendering, contrast, and backend visibility, but not guest POST success/failure, duplicate prevention, draft persistence, moderation labels, or the full 500-character unbroken input.
- A persistent visible label such as `Your note` plus a concise 500-character limit would be clearer than relying on the placeholder for sighted users.

## Questions to Consider

- Is this primarily a private message to the couple, or event content that may be shared with every guest?
- What language lets a rejected note remain visible to its author without making the moment feel punitive?
- Should photo captions remain attached to their photos rather than appearing as standalone notes?
