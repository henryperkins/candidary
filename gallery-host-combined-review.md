# Combined Host Gallery Experience Review — Candidary

**Date:** 23 August 2026 · **Reviewed branch:** `claude/album-workspace` at `9a55a9e` · **Status:** canonical synthesis

This report combines `gallery-host-experience-review.md` and `gallery-host-review-report.md`. It removes duplicate
findings, preserves the strongest evidence from both passes, and resolves their differing recommendations. The two
source reports remain unchanged as evidence records.

## Evidence and method

The combined evidence comes from two complementary review passes:

- A local Cloudflare Worker with real Miniflare D1/R2 state and migrations 0001–0018, exercised at 1440×900, 390×844,
  and 320×844. That pass used three disposable events plus a rotation event and captured 114 screenshots and 28
  accessibility snapshots.
- A production Vite preview exercised at 1440×1000, 390×844, and 320×844, including the public album. Targeted
  Playwright coverage for the album workspace and album sharing passed 8/8 on desktop and mobile.
- Authenticated API calls, direct D1 inspection, source review, accessibility-tree inspection, focus traces, and
  targeted code/test review filled states that were difficult or expensive to create through the interface.

Evidence labels:

| Label | Meaning |
| --- | --- |
| **LIVE** | Reproduced in a running browser |
| **API** | Verified against the running Worker |
| **D1** | Verified in the database |
| **TEST** | Covered by an executed automated test |
| **CODE** | Directly established from source or existing tests, but not independently reproduced |
| **INFERRED** | Strongly implied by the implementation; still needs a focused runtime test |
| **NEEDS RUN** | Open runtime or device question |

Source references use **G-xx** for `gallery-host-experience-review.md` and **S1.1–S4.20** for the numbered findings in
`gallery-host-review-report.md`.

---

## A. Executive summary

### Overall assessment

Candidary’s host gallery has a strong product foundation: delivered originals are private by default, album
membership is distinct from shared-gallery publication, and an album link is a separate audience boundary. The three
Gallery modes are the right structural decomposition. Album autosave, the private viewer, focused empty states, and
the copy explaining that picking does not publish to the shared gallery are all unusually careful.

The experience is not yet safe or simple enough for a low-frequency, phone-first host. The product makes its three
audiences legible only after the host opens multiple modes and reads explanatory prose. Its most permanent action,
deleting a guest original, has the least friction. Once an album link is live, album membership edits change the next
link read immediately, but Library continues to describe picking only in terms of the shared gallery. “Hide” affects
the optional shared gallery but not the album link, and no surface clearly contrasts those scopes. A host can therefore
make a privacy-affecting change while holding the wrong mental model.

Two workflow boundaries also block completion. A terminal export card never offers a new snapshot of the current
collection, and rapid or failed Album navigation can leave the host stranded without a reliable discard-and-leave
path. These are not cosmetic problems: they interrupt the core promises to curate, share, retrieve, and safely retire
an event.

The mobile implementation has two simultaneous truths. It avoids horizontal overflow and generally preserves 44 px
targets, including at 320 px. It is also too vertically dense at 390 px—the first Library photo can begin 1,304 px down
the page—and the six Manager labels visibly collide at 320 px.

### Reconciled product interpretation

The source reviews differed on three points. This combined report adopts the following interpretation:

1. **Album membership and link publication.** The current link is a request-time projection of the current album, not a
   frozen release. That can remain a deliberate model, but the interface must show “Link live—album changes affect the
   link” wherever membership changes. A staged “Publish changes” model remains an open product alternative, not a
   prerequisite for fixing the misleading state.
2. **Hide semantics.** Publish/Hide belongs to the optional shared gallery; album membership belongs to the album link.
   Hiding need not silently change album membership. The mandatory fix is to distinguish event guests from link holders
   and provide an explicit whole-product withdrawal path. Excluding hidden photos from the album link is a possible
   policy change that must be chosen deliberately.
3. **Deletion recovery.** Current deletion has no truthful recovery path. The immediate fix is pre-action confirmation,
   exact cascade copy, stable post-delete focus, and a success announcement. A 30-second Undo and Recently deleted view
   should be added only with a storage-retention contract that can actually restore the original.

### Highest risks

1. **Permanent original deletion is one unconfirmed icon tap.** It removes the photo from Intake and every readable
   Library, Album, shared-gallery, and live-link projection without stating that cascade. *(C-04)*
2. **A live album changes while the host thinks they are privately curating.** Picks reach the next link request
   immediately; the live state is visible only inside Album. *(C-01)*
3. **Hide does not retract a photo from an album link.** That is compatible with separate axes but not legible to an
   unbriefed host trying to withdraw content. *(C-02)*
4. **Guest captions can reach link holders without the Guestbook moderation model being applied or disclosed.**
   *(C-03)*
5. **Terminal exports block fresh snapshots.** Later deliveries or album edits cannot be included through the current
   interface. *(C-05)*
6. **The guest gallery response exposes internal media fields**, including uploader-session and storage metadata plus
   the host’s pick state. *(C-06)*
7. **Blocked Album navigation can stall or become inescapable** when destinations change quickly or a save remains
   failed. *(C-13, C-14)*
8. **“Pause photo delivery” removes more than delivery**, including major guest surfaces, while fullscreen behavior is
   inconsistent. *(C-08)*
9. **Settings can falsely report Saved in StrictMode development/preview validation** because the autosave queue is
   disposed during effect replay. *(C-07)*
10. **Account creation and manager-link recovery contain dead ends** at precisely the moments a host needs durable
    access. *(C-09, C-10)*

### Strong aspects to preserve

- Keep **Library, Album, and Guest gallery** as three separate modes; improve naming and orientation rather than merging
  their responsibilities.
- Keep Library as the safe default on a genuinely fresh Gallery visit.
- Keep deletion and original-file retrieval owned by Intake, with proportionate guardrails added there.
- Keep picking, publication, and link availability as independent axes.
- Keep the viewer’s focus trap, arrow navigation, Escape behavior, fallback states, and focus restoration as the dialog
  reference implementation.
- Keep Album’s honest autosave states, conflict handling, and field-specific validation.
- Keep one persistent Gallery live region, but give sighted hosts equivalent visible feedback.
- Keep the 48-row page and 50-action cap; fix their hidden and inaccurate scope copy.
- Keep complete and album exports as separate entry points with a shared snapshot lifecycle.
- Keep the public album’s narrow field allowlist: contributor names and originals should not be added merely to make
  Preview easier to implement.
- Keep Cover Studio’s promise that the old cover remains live until its replacement is complete.

### Ten highest-priority changes

| Rank | Change | Why |
| ---: | --- | --- |
| 1 | Guard permanent Intake deletion with exact cascade copy, stable focus, and success feedback; add recovery only when the original is durably restorable. | Removes the least-guarded irreversible action. |
| 2 | Show Album count, link state, and guest-gallery state persistently; state that live Album edits affect the link. | Closes the largest privacy and memory gap. |
| 3 | On terminal export cards, retain the old snapshot and add Prepare current collection / Prepare current album. | Restores both core export workflows. |
| 4 | Project the guest gallery API to its public allowlist. | Removes unnecessary private metadata exposure. |
| 5 | Key blocked-navigation preparation by destination and add an explicit discard-unsent-changes exit after failed preparation. | Prevents silent route stranding. |
| 6 | Confirm Stop sharing album and name immediate, irreversible URL invalidation. | Protects a distributed credential. |
| 7 | Make Album Preview render the actual public header, cover, count, ordering, captions, and public-safe labels. | Makes the explicit guest-preview promise true. |
| 8 | Fix StrictMode autosave disposal and make Saved mean a confirmed write. | Restores trustworthy settings validation. |
| 9 | Rename/re-scope Pause photo delivery and make every guest route obey the same paused rule. | Prevents an undisclosed guest outage. |
| 10 | Make navigation addressable and preserve task intent, per-mode scroll, and return focus. | Removes repeated phone backtracking. |

---

## B. Combined coverage inventory

| Area | Workflows and states covered | Devices / evidence | Combined result |
| --- | --- | --- | --- |
| Event creation and first run | Create signed out/in, empty Intake, first route after creation | 1440, 390; LIVE | Creation is short; empty Intake gives no useful next step. |
| Host accounts | Register, pending verification, confirm, sign in before/after confirmation, events list | 1440; LIVE + D1 | Pending account copy and routing are broken; multi-event dashboard does not scale. |
| Guest intake | Guest upload, paused/open delivery, 0/12 photos, contributor filter | 1440/390/320; LIVE | Delivery works; host upload is absent and the empty copy is wrong. |
| Original management | Single-original download, permanent deletion, deletion cascade | 1440; LIVE + D1 + CODE | Download is clear; deletion is critically under-guarded. |
| Library browse | Search, clear, order, album-picks filter, pagination, no results, image failure | 1440/390/320; LIVE + CODE | Strong states; filtered totals and loaded scope are unclear. |
| Viewer | Open/close, focus trap, arrows, Escape, focus return, page boundary | desktop/mobile; LIVE | Exemplary within one loaded page; cannot cross the page boundary. |
| Library selection | Single, moment, all loaded, cap 50, add/remove/clear | desktop/mobile; LIVE + CODE | Core flow works; visible cap and loaded-only scope are missing. |
| Album reconcile | Empty album, current-session picks, historical picks, 501-pick boundary | desktop/mobile; LIVE + TEST | Ordinary gate tells a false historical story; 501 picks block Start empty. |
| Album editing | Title, description, cover, sections, drag/arrows, reset, conflicts | desktop/mobile; LIVE + TEST | Autosave is robust; reset consequence, reorder focus, and empty sections need work. |
| Album recovery | Offline save, retry, mode/section leave, router blocker, Undo lifetime | desktop; LIVE + CODE | Duplicate raw errors and no reliable discard exit; Undo can disappear early. |
| Album preview | Nonempty preview, image fallback, public comparison | desktop/mobile; LIVE | Preview does not match the recipient view it claims to show. |
| Album sharing | Create, double-submit, redisplay, copy, stop, reshare, revoked link | desktop/mobile; LIVE + API + TEST | Happy path works; live-edit scope, stop confirmation, and secret display are weak. |
| Public album | Fragment exchange, cookie reload, cover, captions, sections, revoked URL | 390; LIVE + API + TEST | Narrow projection is good; query stripping and stale cover-failure state remain. |
| Shared gallery | Off/on, three filters, single/bulk Publish/Hide, cap 50, mixed states | desktop/mobile; LIVE + CODE | Axis model is sound; feedback, scale, and off-state language are inconsistent. |
| Guest-visible surfaces | Event gallery, fullscreen, captions, paused event | desktop/mobile; LIVE + API | Pause has broader and inconsistent consequences than its label. |
| Guestbook | Needs review / Shared / Hidden / Deleted, caption-publication coupling | desktop; LIVE | Moderation is strong; labels and Album-caption boundary are unclear. |
| Complete export | Idle, queued, ready, links, changed collection, cross-kind lock | desktop/mobile; LIVE + CODE | Artifact copy is strong; fresh-snapshot path is missing. |
| Album export | Empty, ready, changed album, immutable snapshot, cross-kind lock | desktop/mobile; LIVE + TEST | Same lifecycle strengths and same fresh-snapshot defect. |
| Export failure / scale | Failure and expiry source paths, progress, 2 GiB advice, 100 GiB reasoning | CODE | Failure, expiry, multipart scale, and real long runs still need runtime exercise. |
| Settings and appearance | Text, toggles, theme, preset/upload cover, style previews | desktop/mobile; LIVE + CODE | Production-style pass works; StrictMode validation fails and Cover Studio has gaps. |
| Event retirement | Pause/resume, sign out guests, disable QR, rotate link, delete event, stop album link | desktop; LIVE + CODE | Five mismatched confirmation patterns; severity and friction are inverted. |
| Navigation and continuity | Six destinations, three Gallery modes, reload, Back, deep scroll, purpose-bearing returns | 390/320; LIVE + CODE | URL state, scroll, focus, and route intent are not preserved; 320 labels collide. |
| Accessibility | Viewer, Cover Studio, reorder, Undo, live regions, current axe scope | desktop/mobile; LIVE + CODE | Viewer leads; modal/reorder/Undo and automated coverage lag. |
| Responsive layout | All Manager destinations and public Album | 1440/390/320; LIVE | No horizontal overflow; excessive vertical density at 390 and nav collision at 320. |

Not applicable in the reviewed product: templates, duplication, roles beyond event membership, analytics/activity feeds,
cross-event collections, plan upgrades, and scheduled publication.

---

## C. Host lifecycle journey

| Stage | Host goal | Current path | Main uncertainty or failure | Target |
| --- | --- | --- | --- | --- |
| 1. Discover | Understand where photos go | Create → Manager opens on Intake | “No matching photos” and no QR/next-step orientation | Show the QR, private-delivery promise, and first action. |
| 2. Create | Set up the event | One compact form | Clear | Preserve. |
| 3. Add | Receive or contribute photos | Guests use QR; host has no intake path | Host cannot add their own camera-roll photo | Reuse guest upload pipeline with host attribution. |
| 4. Review | Find and inspect arrivals | Intake for originals; Library for browsing | Same item has different cards and incomplete state visibility | Preserve ownership, unify state language and cross-links. |
| 5. Select | Build an album | Pick in Library, then open Album | A live link is not visible at the pick point; cap scope is hidden | Show live-link consequence and loaded/cap scope. |
| 6. Arrange | Title, cover, sections, order | Album autosave | Reset deletes sections; focus/Undo continuity is fragile | State consequences before action and preserve recovery. |
| 7. Preview | Verify recipient result | Preview album | Preview omits the public cover/count and uses different labels | Render the public component with the same projection. |
| 8. Share | Give access | Share album → copy URL | Link becomes live immediately; Stop is unconfirmed | Confirm lifecycle boundaries and show link state globally. |
| 9. Publish | Choose event-guest visibility | Shared plus a Settings toggle | Two audiences use overlapping “share” words; off state still says “right now” | Rename mode Guest gallery and show both audience states. |
| 10. Moderate | Review captions and notes | Guestbook | Album captions bypass or obscure the Guestbook moderation model | Choose and disclose one caption policy. |
| 11. Deliver | Retrieve complete or curated archive | Library / Album export | Old terminal job owns the card forever | Preserve dated old job; add current-snapshot action. |
| 12. Return | Resume work later | Fresh Gallery opens Library | Mode, URL, scroll, link state, and task intent are lost | Addressable state plus bounded return intents. |
| 13. Recover | Leave failed work safely | Retry or remain in Album | No explicit discard after failed preparation; rapid route requests can stall | Destination-keyed blocker plus honest discard path. |
| 14. Retire | Pause, revoke, delete | Settings, Share, Album | Five confirmation models and undisclosed cascades | One severity ladder with exact audience consequences. |

---

## D. Consolidated findings

Severity: **P0** privacy/data-loss risk or complete blocker · **P1** core task seriously jeopardized · **P2** significant
friction/inconsistency · **P3** localized polish with a concrete cost.

### D1. Critical and core-task findings

| ID | Sev | Consolidated finding | Evidence | Required response | Sources |
| --- | :---: | --- | --- | --- | --- |
| **C-01** | P0 | With a live Album link, a Library pick changes the next public Album read immediately, while Library says only that picking “does not publish it.” Link state is absent at the action point. | LIVE + API | Persistently show Link live and state that membership edits affect it; decide separately whether to add staged publication. | G-01; S2.6; §3.6 M→S |
| **C-02** | P0 | Hide changes shared-gallery publication but leaves an Album-link photo visible. The separate-axis behavior is not explained where a host tries to withdraw content. | API | Contrast Guest gallery with Album link; provide a whole-product withdrawal action. Change link filtering only as an explicit policy decision. | G-02; S3.16; §3.6 P→S |
| **C-03** | P0 | Guest-written captions are returned to Album link holders without the Guestbook moderation model being applied or disclosed. | API | Withhold unreviewed captions or tell the host before sharing that captions travel with photos. | G-03 |
| **C-04** | P0 | Intake permanently deletes a guest original in one icon tap with no consequence copy, confirmation, success message, stable focus, or current recovery path. It disappears from every readable projection. | LIVE + D1 + CODE | Add focused confirmation with exact cascade copy and deterministic post-action feedback. Add Undo/Recently deleted only with durable object recovery. | G-04; S1.1 |
| **C-05** | P1 | A Ready, Failed, or Expired export owns its card forever; Retry reuses its immutable snapshot and no action can prepare the current collection or Album. | LIVE + CODE | Date the retained snapshot, rename retry to Retry this prepared export, and add Prepare current… when no job is active. | G-05, G-17; S1.2 |
| **C-06** | P1 | The event gallery endpoint serializes internal media fields to guests, including uploader-session identifiers, object metadata, idempotency data, and host pick state. | API | Return a purpose-built guest projection only. | G-06 |
| **C-07** | P1 | In StrictMode development/preview validation, Settings and Appearance autosave queues can be disposed during effect replay while the interface continues to show Saved. | LIVE + D1 + CODE | Apply the generation guard already used by Album; never show Saved before a confirmed write. | G-07 |
| **C-08** | P1 | Pause photo delivery removes the shared gallery, Guestbook, and My deliveries on the main guest page, while fullscreen follows a different rule. | LIVE + CODE | Rename the control to match its scope or narrow its effect; state all affected surfaces and unify guest routes. | G-08 |
| **C-09** | P1 | Registration says confirmation can happen later, but the account does not exist until the code is entered; sign-in then reports a credential error. | LIVE + D1 | State when the account is created and route pending users back to confirmation. | G-09 |
| **C-10** | P1 | Manager-link rotation is offered where ownership makes it impossible; the error repeats below the fold, and the successful owned-event path discards the replacement link. | LIVE + CODE | Disable unavailable rotation with an inline account path; on success require copying/acknowledging the new link before navigation. | G-09b |
| **C-11** | P1 | Stop sharing album invalidates a distributed URL immediately and irreversibly without warning; already-rendered pages may retain only previously loaded content. | LIVE + CODE | Confirm with immediate/irreversible URL consequences and announce that the old link no longer works. | G-10; S1.5 |
| **C-12** | P1 | A host cannot upload a photo to their own event anywhere in Manager. | CODE | Add host upload to Intake using the existing validation pipeline and explicit host attribution. | G-19 |
| **C-13** | P1 | A second destination requested while Album navigation is blocked can be stranded behind the first preparation result. | INFERRED | Key preparation by destination/navigation generation and proceed only on an exact current match. | S1.3 |
| **C-14** | P1 | A failed or invalid Album save can indefinitely prevent leaving even though the generic prompt implies unsent work can be discarded. | LIVE + CODE | After failed preparation, offer Discard unsent Album changes and leave; retain the warning that an already-sent request may finish. | S1.4; G-27 |

### D2. Significant usability, state, and accessibility findings

| ID | Sev | Consolidated finding | Required response | Sources |
| --- | :---: | --- | --- | --- |
| **C-15** | P2 | Manager destinations and Gallery modes are local state; reload loses place and Back exits instead of traversing work. | Put destination/mode in the URL and honor them on load. | G-11 |
| **C-16** | P2 | Seven destructive actions use five unrelated confirmation patterns, with more friction on some reversible actions than permanent ones. | Define one consequence-based three-rung pattern and validate before sending. | G-12 |
| **C-17** | P2 | A new Album with picks made moments earlier tells a false “before albums” story and forces a legacy reconciliation choice. | Restrict the gate to genuinely historical picks; adopt current-era picks directly. | G-13 |
| **C-18** | P2 | Single Publish/Hide has no named confirmation; bulk feedback gives no count or precise guest consequence. | Announce item/count, resulting visibility, and recovery. | G-14 |
| **C-19** | P2 | Equivalent Album removals have different Undo behavior, and a visible nine-second Album Undo disappears on mode/section leave. | Use one persistent Manager-owned Undo controller and one recovery contract. | G-15; S2.8 |
| **C-20** | P2 | Empty Album sections are published as bare headings, and new sections always append. | Omit empty sections publicly, flag them in editor, and insert relative to context. | G-16 |
| **C-21** | P2 | Cover Studio lets Tab leave the modal. | Reuse the viewer’s trap, aria-modal, and focus-return pattern. | G-18 |
| **C-22** | P2 | Intake’s contributor filter can silently constrain Shared with no visible filter or clear action. | Scope/reset the filter or show it at the destination. | G-20 |
| **C-23** | P2 | Keyboard reordering can move focus to the opposite arrow and gives inadequate positional feedback. | Restore the invoked control and announce the new position. | G-21 |
| **C-24** | P2 | Album Preview claims to be the link-holder view but omits the public cover/count, differs in captions/layout, and can include labels derived from contributor names. | Render the public component/projection in Preview. | G-22; S2.7 |
| **C-25** | P2 | Four of five Cover styles may initially show Preview not ready with no loading explanation or direct retry. | Prefetch or expose per-tile loading/retry. | G-23 |
| **C-26** | P2 | Offline Album save surfaces raw Failed to fetch in several competing banners and has no reconnect retry. | Show one human message, one Retry, and retry on reconnect. | G-27 |
| **C-27** | P2 | On a 390×844 phone, Gallery chrome can push the first Library photo 1,304 px down the page. | Collapse secondary copy/export chrome and use a compact sticky control row. | G-28 |
| **C-28** | P2 | Arriving photos are called Guest uploads, Photo delivery, private deliveries, Live intake, Library, and photos stored. | Establish one terminology ledger and apply it across Manager. | G-29 |
| **C-29** | P2 | Shared, optional shared gallery, Share, Share album, Published, and guests describe two audiences and three actions without an at-a-glance state. | Rename the mode Guest gallery and show Album count, Link state, and Guest-gallery state under the switch. | G-30; S2.6; S3.16 |
| **C-30** | P2 | Shared cards show Publish and Hide at equal weight regardless of filter/context. | Lead with the state-appropriate action and demote the alternative. | G-31 |
| **C-31** | P2 | A full Album credential remains visible in plain text after sharing. | Mask by default with Reveal and Copy. | G-32 |
| **C-32** | P2 | Export error codes are retained in D1 but omitted from the Manager view, leaving only Attempt N failed. | Carry safe codes and map each to actionable host copy. | G-41 |
| **C-33** | P2 | Queued and running exports share one static Preparing state; progress stops being polled outside Gallery. | Distinguish queue/run, show elapsed or parts, and keep status globally available. | G-42 |
| **C-34** | P2 | Mixed-state bulk publication performs sequential grouped requests; a mid-loop failure can partially write while reporting overall failure. | Make the operation atomic or report exact partial outcomes. | G-43 |
| **C-35** | P2 | One failed background read in Manager’s initial Promise.all can replace every usable panel with an error page. | Settle reads independently and degrade only the affected panel. | G-44 |
| **C-36** | P2 | Undo is late in DOM order, hard to reach before expiry, and not consistently announced. | Place/focus it within the persistent live/recovery region. | G-45 |
| **C-37** | P2 | Axe coverage omits Album, Shared, selection mode, the tray, and Album sharing. | Scan every Manager destination and transient mode. | G-46 |
| **C-38** | P2 | Shared publication does not scale: 24-row pages, 50-action cap, no all-results workflow, and position resets after writes. | Reuse Library’s bounded selection model and preserve position. | G-47 |
| **C-39** | P2 | Library does not show publication state, so the primary review surface cannot answer whether event guests can see a photo. | Add a compact Guest-gallery status chip. | G-48 |
| **C-40** | P2 | Library says Select all results although it selects loaded rows, and its visible tray hides the 50 cap. | Say Select all N loaded photos and N of 50 selected. | S2.9 |
| **C-41** | P2 | A running export of one kind silently disables the other kind’s apparently valid Prepare/Retry control. | Name the active kind and explain when this action becomes available. | S2.10 |
| **C-42** | P2 | Reset to timeline order deletes every section but discloses that structural consequence only after the tap. | State the section loss and Undo window beside the control before action. | S2.11 |
| **C-43** | P2 | The six Manager destination labels visually collide at 320 px despite no page-level overflow. | Allow safe wrapping, increase narrow-screen nav height, and test label-box intersection. | S2.12 |
| **C-44** | P2 | Deep Library scroll is lost after visiting a shorter Gallery mode; the tested return moved from scrollY 2860 to 188. | Store and restore an anchor/scroll value per Gallery mode. | S2.13 |
| **C-45** | P2 | Purpose-bearing routes—Share → export and Shared → Settings → return—remount generic Library and lose mode, target focus, selection, and scroll. | Carry a one-use destination/mode/focus intent while keeping fresh visits in Library. | S2.14 |
| **C-46** | P2 | Viewer Next disables at the last loaded photo even when more pages exist. | Let Next load the next page in-dialog, retain current content on failure, and expose Try again. | S2.15 |
| **C-47** | P2 | Local Album count, lifted badge count, and frozen export count can disagree without naming trust or snapshot freshness. | Lift one trusted live count and label exports Prepared date · N photos. | G-17; S3.17 |
| **C-48** | P2 | Shared says What guests can see right now and Published while the Guest gallery is off. | Use dynamic off-state copy that distinguishes saved publication choice from present visibility. | G-25; S3.16 |
| **C-49** | P2 | At 501 historical picks, the Worker rejects Start empty before it can clear picks. | Apply the 500-entry check only to Start from picks and add the boundary regression. | report appendix |

### D3. Localized polish findings

| ID | Sev | Finding | Response | Sources |
| --- | :---: | --- | --- | --- |
| **C-50** | P3 | Empty Intake says No matching photos when no filter exists. | Split true-empty from no-results copy. | G-24 |
| **C-51** | P3 | Guestbook files published captions under Hidden while the Guest gallery is off. | Rename to Not visible to guests or qualify the reason. | G-25 |
| **C-52** | P3 | The events dashboard has no create, search, sort, or archive affordance. | Add Create event plus date sorting/search before larger archive features. | G-26 |
| **C-53** | P3 | Album title defaults to literal Album and becomes invalid if cleared. | Use the event name as the default or placeholder. | G-33 |
| **C-54** | P3 | Download all is enabled at zero photos. | Disable with a local reason. | G-34 |
| **C-55** | P3 | Guestbook’s default tab changes with counts. | Choose one deterministic default, preferably Needs review. | G-35 |
| **C-56** | P3 | Equal upload endpoints render as a duplicated time range. | Collapse equal endpoints to one time. | G-36 |
| **C-57** | P3 | A large Cover upload has no progress or cancel state. | Show determinate progress and Cancel. | G-37 |
| **C-58** | P3 | Pause pairs with Reopen rather than Resume. | Use Pause / Resume after resolving the larger scope issue. | G-38 |
| **C-59** | P3 | Registration confirmation ends without a route to the events dashboard. | Redirect or offer Continue to events. | G-39 |
| **C-60** | P3 | Picked Library cards duplicate In the album and In album. | Keep one compact state chip. | G-40 |
| **C-61** | P3 | Retention and event dates use two formatters/locales. | Use one event-zone formatter. | G-50 |
| **C-62** | P3 | Row actions remain enabled during Shared bulk writes, and filter changes clear selection without visible feedback. | Lock conflicting writes and visibly announce selection clearing. | report §2.20–2.22 |
| **C-63** | P3 | Secret-fragment cleanup rewrites every public Album URL to /album and drops legitimate query parameters, including cookie-only loads. | Scrub only a present token fragment and preserve path/query. | S4.19 |
| **C-64** | P3 | A failed public cover retains local failure state when coverMediaId changes, so a later valid cover can remain unavailable. | Key/reset image failure state by media ID. | S4.20 |
| **C-65** | P3 | Remove selected from Album uses a completion checkmark instead of a subtraction glyph. | Use Minus while retaining the literal label. | S4.18; G-49 |
| **C-66** | P3 | Clipboard fallback tells the host to select the URL, but the rendered code does not select itself. | Put the value in a selectable field with Select/Copy behavior. | report §2.17 |

### D4. Technical boundary outside the host-UI ranking

- **Export/delete retention race — CODE/INFERRED.** An export snapshots an object key, while Intake deletion can remove
  the stored object before a queued Workflow reads it. Existing tests mark a database row deleted but do not exercise
  the real route plus object deletion. Define a Worker-level snapshot-retention contract and add the end-to-end race
  test before relying on accepted exports as durable.

---


## E. Workflow deep dives

### E1. Curate and share an Album

**Current path:** Gallery → Library → pick individually or enter selection mode → Album → possibly answer the legacy
reconcile gate → edit title, description, cover, sections, and order → Preview album → Share album → Copy album link.

The happy path is mechanically strong. Picking is reversible, the editor autosaves with honest field errors, conflicts
reload canonical state, keyboard order controls exist, share double-submission is suppressed, and the public holder sees
a narrow projection without Manager chrome or originals.

The mental model fails at the live boundary. Album sharing is not a frozen publish event: current membership and
metadata are projected on the next public request. Once a link exists, a pick in Library therefore changes public
content even though the action point displays only “does not publish it.” That sentence is technically about the Guest
gallery, but the host has no persistent reminder that a different audience is already live. Preview then compounds the
problem by omitting the public hero/count and using different labels.

**Target:** keep request-time sharing if desired, but show “Album link live—changes affect the link” in Library and
Album; render the public projection in Preview; confirm link creation/revocation; keep the link masked; and expose one
deliberate whole-product withdrawal action. If the team instead wants a frozen publish revision, treat that as a larger
product change rather than silently implying it through copy.

### E2. Publish to the Guest gallery

**Current path:** Gallery → Shared → choose Unpublished, Published, or Hidden → use a row action or select up to 50 →
Publish/Hide. If the Guest gallery is off, follow Open settings, change the event setting, then manually return.

The underlying axis is sound: delivery, Album membership, and event-guest publication are independent. The off-state
notice is good just-in-time explanation. Shared also explains its 50-item cap more clearly than Library.

The flow is nonetheless hard to predict. “Shared” does not name its audience; “What guests can see right now” remains
when the gallery is off; Publish and Hide have equal visual weight in every filter; single writes have weak feedback;
the primary Library review card omits publication state; and returning from Settings loses the intended mode and target.
At scale, pagination, selection resets, and sequential grouped writes make bulk publication fragile.

**Target:** rename the mode Guest gallery, put its on/off state in the Gallery summary, use dynamic off-state copy,
lead cards with the relevant action, add a compact publication chip to Library, retain bounded selection with accurate
loaded/cap copy, and return from Settings to the exact status and notice.

### E3. Delete or withdraw a photo

There are currently three different verbs with three legitimate scopes:

- **Remove from Album** changes membership/order and preserves the delivered original.
- **Hide from Guest gallery** changes event-guest publication and preserves delivery/Album membership.
- **Delete original** removes the delivered source from every readable projection and may affect an in-progress export.

The first two actions receive more explanation and recovery than the third. This is the most important hierarchy
inversion in the product.

**Target:** retain those three verbs, but state audience and permanence at every boundary. Intake deletion should open a
focused confirmation: “Permanently delete this guest’s original? It will disappear from Library, the Album, the Guest
gallery, and any live Album link. This cannot be undone.” After success, focus the next card or Intake heading and
announce the named photo. If backend retention is added, replace “cannot be undone” with a truthful recovery window and
surface Recently deleted.

### E4. Deliver an archive

**Complete scope:** every delivered original plus manifest and printable/private Guestbook artifacts.

**Album scope:** the ordered Album snapshot and manifest, without Guestbook artifacts.

Keeping two entry points is correct. Their shared lifecycle—Preparing, Ready, Failed, Expired, links, attempt—is also
good, and the artifact names are unusually clear. The defect is treating the latest retained job as the only job the
host may act on. Retry correctly retries that immutable snapshot; it is not a substitute for preparing the current
collection. Cross-kind exclusion is reasonable but invisible.

**Target terminal card:**

> Prepared 3:14 PM · 12 photos · Ready
>
> Get download links · Retry this prepared export
>
> 3 photos have arrived since this snapshot. Prepare current collection.

While either kind is queued/running, name it and explain why the other action waits. Show safe failure reasons and keep
progress available outside Gallery.

### E5. Navigate, leave, and recover

Gallery keeps Library mounted between its three modes, while Album intentionally unmounts when inactive. Manager
destinations themselves are local state. That creates four different continuity behaviors:

- Library query/rows survive a mode switch, but deep document position does not.
- Album attempts to settle before leaving, but a failed settle has no honest discard route.
- Album Undo disappears on successful unmount before its promised timeout.
- Leaving Gallery and later returning always creates a fresh Library visit, even when a control explicitly sent the
  host to Gallery for an export or to Settings for the Guest-gallery toggle.

Router blocking adds a correctness risk: a second requested destination can supersede the first without causing a new
preparation generation.

**Target:** encode durable destination/mode in the URL; store per-mode scroll anchors; use one-use internal intents for
cross-destination tasks; key blocker results to the current destination generation; and offer discard only after
preparation genuinely fails. Keep Album unmounted when inactive, but lift a live Undo to persistent Manager scope.

### E6. First run and retirement

Creation itself is compact, but the first Manager screen reads like an empty search result and never points to the QR.
Registration separately claims confirmation can happen later even though durable account creation depends on it.

At retirement, the host encounters Pause photo delivery, Sign out guest devices, Disable printed QR, Rotate manager
link, Stop sharing album, and Delete event. Their confirmation friction is unrelated to consequence, and “Pause”
removes more guest capability than its label promises.

**Target:** orient first run around the QR and private-delivery promise; route pending accounts back to confirmation;
then apply one safety ladder:

| Rung | Use | Pattern |
| --- | --- | --- |
| Reversible | Pick, Publish/Hide, temporary removal with real Undo | Immediate action + precise feedback + Undo/opposite action |
| Consequential | Stop Album link, rotate manager link, permanent original delete | In-context confirm naming audiences and reversibility |
| Catastrophic / broad | Disable permanent entry, sign out all guest devices, delete event | Typed event name after client validation |

---

## F. Consistency and state matrices

### F1. Terminology and audience ledger

| Concept | Current words | Consolidated judgment | Canonical direction |
| --- | --- | --- | --- |
| Delivered source | Guest uploads, Photo delivery, private deliveries, Live intake, Library, original | The model is learnable only through prose. | **Delivered photos** for the collection; **original** only for file retrieval/deletion. |
| Album membership | Pick, Add to Album, In Album, historical favorite/heart | Pick/Add/In Album are compatible; favorite leaks beyond its legacy gate. | **Pick / In Album / Remove from Album**. |
| Transient selection | Select, selected, Select all results | Correctly distinct from membership, but scope is overstated. | **Select all N loaded photos · N of 50 selected**. |
| Event-guest publication | Shared, optional shared gallery, Published, Hidden, Unpublished | State vocabulary is usable; the mode and audience are opaque. | **Guest gallery · Published / Unpublished / Hidden**. |
| Link availability | Share Album, Copy Album link, Stop sharing | Coherent within Album, overloaded against Share/Shared globally. | **Album link: Off / Live** plus literal actions. |
| Recipient actor | Guests, guest opening the link, privately | “Guest” conflates event credential holders and link holders. | **Event guests** and **people with the Album link**. |
| Export lifecycle | Download, Preparing, Ready, Retry, Get links | State names are strong; immutable snapshot is unnamed. | **Prepare**, then **Prepared date**, **Get links**, **Retry this prepared export**. |
| Save/recovery | Saved, Saving, Couldn’t save, Leave now, settings | Plain states, but the generic leave prompt names the wrong domain. | Name **Album** or **Settings** and the exact pending/failed state. |
| Cover choice | Cover, Use as cover, star another | One stray metaphor. | **Cover / Use as cover / Use first photo**. |
| Reorder/reset | Move earlier/later, Reset to timeline order | Reset hides its section-deletion effect. | Keep label; add explicit pre-action consequence. |

### F2. Four-axis independence test

Legend: **D** delivered source existence · **M** Album membership/order · **P** Guest-gallery publication · **S** Album
link availability. “Legible” asks whether an unbriefed host can predict the effect, including effects on a live
projection.

| Change | Effect on other axes | Legibility |
| --- | --- | --- |
| D added | Does not automatically change M, P, or S | **Mostly legible** after reading Library/Shared notes. |
| D deleted | Removes the readable item from M, P, and live S projections without changing the conceptual settings | **Not legible**; deletion copy names none of the cascade. |
| M changed | Preserves D and P; changes the next read through live S | **Partial**; D/P independence is taught, live-S consequence is not. |
| P changed | Preserves D, M, and S availability/content | **Partial**; the Shared lede helps, but event guests vs link holders are not contrasted. |
| S started/stopped | Preserves D, M, and P; toggles only Album-link access | **Partial**; same-screen placement helps, but pre-action copy does not say what remains. |
| Album metadata/order changed while S live | Changes subsequent link reads; already-rendered holder pages remain as loaded until another request | **Not stated**; hosts can infer either frozen or real-time behavior. |

The central design task is not to collapse these axes. It is to make every cross-axis effect—and every preserved
axis—predictable at the point of action.

### F3. State-display matrix

| State | Current source of truth | Failure mode | Target |
| --- | --- | --- | --- |
| Delivered-photo total | Adopted Manager event | Search result count is absent; frozen exports look conflicting | Keep total; add filtered/loaded scope where relevant. |
| Album count | Server read in workspace plus local editor draft | Failed refresh preserves a stale badge while editor advances | Lift one trusted live count; suppress untrusted decoration. |
| Guest-gallery visibility | Publication status plus event toggle | Published can mean not visible while gallery is off | Display publication choice and gallery availability separately. |
| Album-link state | Read only when Album mounts | Library/Shared cannot show whether edits are live | Lift Link Off/Live to Gallery/Manager summary. |
| Album save | Local queue and canonical revision | Duplicate raw failures; no failed-state discard path | One human error, Retry, then explicit discard exit. |
| Undo | Mounted surface provider | Unmount and DOM order defeat the advertised window | Persistent Manager provider with announced/focused bar. |
| Complete export | Latest retained complete job | Snapshot looks current; no new prepare action | Prepared date/count plus current-collection delta/action. |
| Album export | Latest retained Album job | Same, plus local Album count disagreement | Same dated snapshot model. |
| Public Album count | Current request-time projection | Preview has no matching count | Use the same header in Preview and public Album. |

### F4. Transition and continuity matrix

| Transition | Correctly preserved | Lost or blocked today | Required behavior |
| --- | --- | --- | --- |
| Library ↔ Shared | Library query/loaded rows remain mounted | Selection and deep scroll; no visible reset | Announce selection clear and restore per-mode anchor. |
| Library → Album | Private state remains; Album loads canonical data | Link consequence is not surfaced at pick point | Carry persistent link state into both modes. |
| Album → another Gallery mode | Confirmed work is flushed | Failed work blocks; live Undo unmounts | Failed-state discard path; persistent Undo. |
| Gallery → another Manager destination | Manager event state remains | Gallery mode/query/scroll reset | Encode durable route; preserve bounded visit state where useful. |
| Share → Gallery export | Export state remains | Purpose and focus target disappear | One-use intent to Library export control. |
| Shared → Settings → Gallery | Event toggle/filter remain | Return mode, selection, scroll, target disappear | Return to prior Shared status and off/on notice. |
| Browser Back/client route from Album | Requested route is held during settle | Newer destination can outgrow stale result | Destination-keyed generation and exact-match proceed. |
| Public fragment/cookie load | Secret fragment should be scrubbed | Legitimate query is also removed | Scrub only the fragment; retain path/query. |

### F5. Responsive and accessibility reconciliation

| Dimension | 390 px | 320 px | Verdict |
| --- | --- | --- | --- |
| Horizontal overflow | None observed | None observed | Preserve. |
| Touch targets | Gallery/Album controls met the intended size | Same in reviewed controls | Preserve and keep automated checks. |
| Content density | First Library photo can begin 1,304 px down | Gallery modes stack safely | Reduce vertical chrome at 390 without cramping controls. |
| Manager navigation | Labels remain distinguishable | Gallery / Guestbook / Share collide | Add narrow-screen wrapping and collision regression. |
| Modals | Viewer is exemplary | Viewer remains usable | Apply its focus pattern to Cover Studio. |
| Keyboard recovery | Reorder and Undo have gaps | Not independently device-tested | Restore focus, announce position, focus Undo. |

---

## G. Simplified target workflows

### G1. Curate and share an Album

1. Gallery opens in Library with: **Album: 4 photos · Link: Off · Guest gallery: On**.
2. The host picks photos. Selection says **12 of 50 selected** and **Select all 48 loaded photos**.
3. Album opens directly for current-era picks; historical-only events receive the reconcile choice.
4. Title defaults to the event name; cover, sections, and order autosave.
5. Reset states before action that it removes every section and offers nine-second Undo.
6. Preview uses the public projection and exact public header/layout.
7. Share album confirms audience, current photo/caption count, and request-time update behavior.
8. Once live, Library and Album say: **Album link live—membership and Album edits affect the link**.
9. Stop sharing confirms that the current URL stops immediately and cannot be restored.

### G2. Permanently delete an original

1. Keep Delete in Intake.
2. First tap opens a focused in-context confirmation naming photo, contributor, every affected projection, and actual
   recoverability.
3. Keep photo is the safe default; Delete original is the danger action.
4. On success, announce the named photo and focus the next card or Intake heading.
5. If the storage contract retains restorable bytes, show Undo and Recently deleted through the stated purge date.

### G3. Publish or withdraw from guest audiences

1. Guest gallery header shows **On/Off · N of total visible to event guests**.
2. Library cards show a compact Guest-gallery state but keep picking as the primary action.
3. Unpublished leads with Publish; Published leads with Hide; alternate actions move to overflow.
4. Feedback names the photo/count and says whether event guests can see it.
5. A separate **Withdraw from all guest views** flow explains and coordinates Guest-gallery state plus Album membership;
   it does not silently redefine Hide.
6. View as event guest and View Album link use the same production projection components.

### G4. Prepare and retrieve exports

1. Idle control says Prepare complete collection or Prepare current Album.
2. Active job names kind, queued/running state, elapsed/progress, and why the other kind waits.
3. Terminal job remains available as **Prepared date · N photos · status**.
4. Retry is explicitly tied to that prepared snapshot.
5. When current state differs, a separate Prepare current… action creates a new snapshot.
6. Failure copy maps safe error code to one action; progress remains visible outside Gallery.

### G5. Leave and return safely

1. URL encodes Manager destination and Gallery mode.
2. Gallery remembers per-mode scroll anchor within the visit.
3. Album settles before leave; temporary checks say why Leave is not yet available.
4. A failed/invalid settle offers Retry or Discard unsent Album changes and leave with the sent-request caveat.
5. Blocker result must match current navigation key and generation.
6. A live Undo survives Gallery mode and Manager-section switches for its remaining time.
7. Cross-destination controls carry one-use mode/focus intent and restore the originating task on return.

### G6. First run

1. After creation, Intake shows the printable QR and “Guests’ photos arrive privately here.”
2. Primary action opens/prints Share; secondary action explains that the host can also add photos when host upload ships.
3. Empty copy becomes No photos yet, not No matching photos.
4. Pending registration states that the account is created after code confirmation and always offers Resume confirmation.

---

## H. Improvement roadmap

### Immediate — days, bounded risk

| Change | Impact | Effort |
| --- | --- | :---: |
| Confirm Stop sharing Album with irreversible URL copy (C-11). | Prevents an accidental distributed-link break. | S |
| Fix public URL query preservation and cover failure reset (C-63, C-64). | Removes two contained public-holder defects. | XS |
| Make Library selection scope/cap visible and use Minus for Remove (C-40, C-65). | Aligns two selection models. | XS |
| Explain cross-kind export lock (C-41). | Makes a valid disabled state understandable. | XS |
| State reset’s section deletion before action (C-42). | Prevents surprising structure loss. | XS |
| Use dynamic Guest-gallery-off copy (C-48). | Removes a direct visibility contradiction. | XS |
| Fix empty Intake, Album title, zero export, equal times, dates, and duplicate badge (C-50, C-53, C-54, C-56, C-60, C-61). | Removes common first-run/polish defects. | S |
| Add 320 px nav wrapping/collision test (C-43). | Restores narrow-phone destination recognition. | S |
| Trap focus in Cover Studio and restore reorder focus/announcement (C-21, C-23). | Closes high-confidence accessibility gaps. | S |
| Guard StrictMode autosave lifecycle (C-07). | Restores trustworthy local/preview validation. | S |

### Near term — one to three weeks

| Change | Impact | Effort | Dependency |
| --- | --- | :---: | --- |
| Intake delete confirmation, cascade copy, focus, and success announcement (C-04). | Protects the original source. | M | Recovery policy decision only for Undo phase |
| Global Album/link/Guest-gallery state summary and live-edit copy (C-01, C-02, C-29). | Makes both audiences legible. | M | Terminology decision |
| Terminal export plus Prepare current path for both kinds (C-05, C-47). | Restores repeat export. | M | Job-history/API contract |
| Guest gallery API projection (C-06). | Removes private metadata. | S | Contract/test updates |
| Destination-keyed blocker and failed-state discard path (C-13, C-14). | Prevents navigation dead ends. | M | Queue discard contract |
| True public Album Preview (C-24). | Ends recipient-view guessing. | M | Shared public renderer |
| Persistent Manager Undo (C-19, C-36). | Makes recovery promise reliable. | M/L | Lift inverse ownership |
| URL destination/mode plus return intents and per-mode scroll (C-15, C-44, C-45). | Preserves phone continuity. | M | Routing decision |
| Rename/re-scope Pause and unify guest routes (C-08). | Prevents hidden guest outage. | M | Product scope decision |
| Registration and rotation recovery (C-09, C-10, C-59). | Protects durable host access. | M | Account/ownership flows |
| Shared feedback, action hierarchy, and publication chip (C-18, C-30, C-39). | Makes routine publication predictable. | M | Terminology/state component |
| Export error/progress projection (C-32, C-33). | Makes long/failed work actionable. | M | Workflow progress data |

### Structural

| Change | Impact | Effort | Dependency |
| --- | --- | :---: | --- |
| Durable Recently deleted and truthful Undo (C-04). | Makes original deletion recoverable. | L | Object-retention contract |
| Host photo intake (C-12). | Lets hosts contribute without guest credentials. | L | Authenticated upload reuse |
| Canonical terminology and action/state component set (C-16, C-28, C-29). | Makes the product learnable across destinations. | L | Design-system update |
| Shared publication at large-event scale and atomic/partial result handling (C-34, C-38). | Supports hundreds/thousands of photos. | L | API/bulk-operation design |
| Panel-level Manager data resilience (C-35). | Keeps unaffected tasks usable during partial failure. | M | Refresh ownership split |
| Complete accessibility matrix and axe coverage (C-37). | Prevents workspace regressions. | M | Stable fixtures for all states |
| Guest-view and whole-product withdrawal flows (C-02, C-03). | Makes audience consequences reviewable and controllable. | L | Caption and Hide policy |

---

## I. Unified regression checklist

### Privacy, audiences, and deletion

1. With an Album link live, Library and Album both state that membership edits affect the link.
2. Picking changes only Album membership and the live Album projection; it never changes Guest-gallery publication.
3. Publish/Hide changes only Guest-gallery publication unless a separately specified withdrawal action is used.
4. Every surface distinguishes event guests from people with the Album link.
5. The chosen Album-caption moderation policy is enforced in API and Preview.
6. The guest gallery API returns only its documented public allowlist.
7. Permanent original deletion sends no request before confirmation.
8. Delete confirmation names the item and Library, Album, Guest gallery, and live-link consequences.
9. Delete success moves focus deterministically and announces the named item.
10. If Undo/Recently deleted is offered, restoring also restores the original bytes and all promised projections.

### Album editing, sharing, and recovery

11. Current-era picks do not trigger the historical reconcile story.
12. With 501 historical picks, Start empty succeeds while Start from picks reports the limit.
13. Empty sections are absent from the public projection and visibly flagged in editor.
14. Reset states section deletion before action and remains undoable for the full advertised window.
15. Keyboard reordering retains the invoked direction control and announces position.
16. Preview and public Album match in cover, title, description, count, order, sections, captions, and public-safe labels.
17. Share double-submit creates one credential.
18. Stop sharing requires confirmation and invalidates the prior URL/session on later reads.
19. Album credentials are masked until Reveal; Copy works without manual text selection.
20. A failed cover does not poison a later cover ID in the same mounted holder.
21. Fragment cleanup preserves path and query and does not rewrite cookie-only loads.
22. Album Undo remains available across Gallery modes and Manager sections for its stated time.
23. Offline save shows exactly one human failure message and one Retry.
24. After failed preparation, Discard unsent Album changes and leave reaches the requested destination.
25. Rapidly requesting two destinations proceeds only to the latest matching navigation generation.

### Guest gallery and bulk work

26. Off-state copy says publication choices are saved but not currently visible.
27. Library displays each photo’s Guest-gallery state.
28. Single and bulk Publish/Hide name item/count and resulting event-guest visibility.
29. The active Shared filter determines the primary row action.
30. Library and Shared both show N of 50 and disable further selection with the same explanation.
31. Select all explicitly means loaded photos.
32. A partial bulk failure reports exactly which groups/items succeeded.
33. Conflicting row writes are unavailable during a bulk write.
34. A filter/mode transition that clears selection announces the reset.

### Exports

35. Complete and Album exports retain separate scopes and shared state vocabulary.
36. Every terminal job shows prepared time and frozen count.
37. Retry is explicitly tied to that prepared snapshot.
38. Prepare current collection/Album is available after a terminal job and includes later changes.
39. A running job names its kind and explains why the other kind waits.
40. Queued and running states differ; long jobs expose progress outside Gallery.
41. Failed jobs show safe mapped reasons and matching recovery actions.
42. Zero-photo complete export is disabled with a reason.
43. Accepted export snapshots survive or explicitly coordinate later original deletion.

### Navigation and continuity

44. Every Manager destination and Gallery mode is addressable and survives reload.
45. Back traverses Manager history before leaving the app.
46. Deep Library → Shared → Library returns the same anchor tile to view.
47. Share → Open Gallery focuses the complete-export control.
48. Shared → Settings → return restores Shared, its status filter, and the availability notice.
49. Filters never silently constrain a different destination.
50. Manager destinations remain distinguishable at 320 px; adjacent label boxes do not intersect.
51. At 390 px, a Library photo appears within the first viewport after compact-chrome changes.
52. Viewer Next loads the next page at a loaded boundary and keeps current content on failure.

### Accounts, settings, and lifecycle

53. StrictMode effect replay does not dispose active Settings/Appearance autosave queues.
54. Saved appears only after a confirmed write.
55. Pending registration routes to confirmation, not a password error.
56. Confirmation success reaches the events dashboard in one step.
57. Unavailable manager-link rotation is disabled with an inline account path.
58. Successful rotation displays/copies the replacement before leaving.
59. Pause/Resume copy names every affected guest surface.
60. Main guest page and fullscreen obey the same paused rule.
61. Every destructive action maps to the documented safety rung and validates before sending.
62. True-empty Intake says No photos yet and points to the QR/next step.

### Accessibility and resilience

63. Every modal traps focus, sets aria-modal, and restores focus.
64. Undo is announced, focused/reachable, and pauses expiry while used.
65. Every icon-only control has a complete accessible name; visible text is included in the accessible name.
66. One failed initial Manager read degrades only its panel.
67. Intake preview failure has a usable fallback while original actions remain available.
68. Axe covers Intake, Library, Album, Preview, Shared, selection/tray, Guestbook, Share, Settings, and public Album.
69. No reviewed destination has horizontal overflow at 390×844 or 320×844.
70. All touch targets remain at least 44 px after compact and narrow-nav changes.

---

## J. Limitations, decisions, and open questions

### Limitations

- The evidence combines two local modes: a development Worker pass and a production Vite-preview pass. The
  StrictMode autosave failure is specifically a development/preview-validation defect; no production-user claim is
  made without a production reproduction.
- The Browser plugin was unavailable in the second pass, so the approved Playwright/Vite fallback supplied its visual
  evidence. Temporary evidence under `/tmp/candidary-gallery-evidence/` is not a durable repository artifact.
- Local Miniflare D1/R2 and the emulated Images binding may differ from production Cloudflare Images, especially for
  style-preview timing and large cover uploads.
- Export expiry, failed Workflow retry, multipart boundaries at 2 GiB, 100 GiB progress, and post-acceptance deletion
  were not exercised end to end.
- Real scale at 1,000+ photos and practical use of a 500-entry Preview were not run.
- Physical Safari/Android, VoiceOver, and TalkBack were not used. Accessibility conclusions come from tree snapshots,
  focus traces, automated checks, and source review.
- Manager-link rotation was not run through the successful owned-event path.
- The review did not exercise scheduled cleanup, Cover backfill, RSVP beyond its entry points, or analytics because
  they are outside the host-gallery task.

### Deliberate decisions to retain

| Decision | Reason |
| --- | --- |
| Three Gallery modes | Their actions have different consequence axes; orientation is the defect, not decomposition. |
| Library as fresh-entry default | It is the safest private source. One-use return intent does not change a fresh visit. |
| Original delete/download in Intake | Intake owns source-file operations; safety belongs at that action, not through duplicated delete buttons. |
| Album unmounted while inactive | Hidden autosave/editor state should not age invisibly; only the promised Undo must outlive it. |
| One Gallery live region | It can persist outside modal/inert content; visible parity should improve without multiplying announcers. |
| Stacked Gallery modes on narrow phones | Full-width 44 px controls are preferable to three cramped columns. |
| No confirmation for ordinary Pick and Publish/Hide | They have immediate same-control/opposite-action reversal; improve feedback rather than adding dialog friction. |
| 48-row pagination and 50-action cap | They bound very large events; scope copy and viewer continuity are the defects. |
| Two export entry points | Complete and Album archives have materially different scopes. |
| Contributor names and originals excluded from public Album | The public allowlist is a deliberate privacy boundary; Preview must conform to it. |
| Historical favorite transport fields | Compatibility naming may remain below the host-facing layer; only leaked product copy needs correction. |
| 2 GiB computer advisory | The known size makes this a useful non-blocking warning. |

### Open product questions

1. **Live Album model:** keep request-time projection with explicit live-state copy, or introduce an explicit frozen
   publish revision?
2. **Hide scope:** keep Hide limited to the Guest gallery and add Withdraw from all guest views, or make hidden media
   ineligible for the Album link as policy?
3. **Captions:** must every Album caption pass Guestbook moderation, or does sharing the photo deliberately share its
   caption?
4. **Deletion retention:** can original bytes be retained safely enough to promise Undo/Recently deleted, and for how
   long relative to the event purge date?
5. **A live but empty Album:** preserve URL continuity with a zero-photo page, or require/confirm Stop sharing when the
   final photo is removed?
6. **Shared-gallery setting ownership:** keep the toggle in Settings with strong return intent, or expose the same
   control in Guest gallery?
7. **Single-original retrieval:** keep it exclusively in Intake, or add a labelled Library-viewer exit without adding
   deletion there?
8. **Export history:** show only the latest dated job plus Prepare current, or expose a fuller audit/history?
9. **URL state:** should every Manager destination use query parameters, nested routes, or a hybrid that preserves old
   management links?
10. **Pause scope:** is the intended product action Pause uploads or Pause all guest access?
11. **Ownerless recovery:** what safe path should a link-only host have when they believe the management link leaked?
12. **Visibility summary governance:** approve one dynamic state line as an exception to the current above-fold design
    contract, or revise that contract more broadly?

---

## Canonical conclusion

Candidary should preserve its separate delivery, Album, Guest-gallery, and link concepts. The repair is to make those
concepts continuously visible, make cross-axis consequences explicit at the action point, and give irreversible or
blocking boundaries proportionate recovery. The first release slice should protect original deletion, disclose live
Album behavior, restore current-snapshot exports, narrow the guest payload, and make failed Album navigation escapable.
Those changes address the largest privacy, data-loss, and completion risks without dismantling the product model that
already works.
