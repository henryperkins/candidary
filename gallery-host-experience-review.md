# Host Gallery Experience Review — Candidary

**Date:** 23 August 2026 · **Branch:** `claude/album-workspace` (`9a55a9e`) · **Reviewer:** senior product design / UX research / content design / QA pass

**Method.** The running application was the primary source of evidence: a local Cloudflare Worker (`npm run dev`) with
real D1 and R2 state, migrations `0001`–`0018` applied, driven with Playwright across desktop (1440×900), phone
(390×844) and small phone (320×844). Three disposable events were used — one populated (12 guest photos from three
guests, eight guest captions, past-dated so uploads were open), two empty (one attached to a verified host account) —
plus a throwaway event for link rotation. 114 screenshots and 28 accessibility snapshots were captured. The codebase was
read in parallel to find conditional states, permission gates and routes the UI does not advertise.

**Evidence labels used throughout:**

| Label | Meaning |
| --- | --- |
| **LIVE** | Reproduced in the running application this session |
| **API** | Verified with authenticated HTTP against the running Worker |
| **D1** | Verified in the database |
| **CODE** | Source-verified only; not independently re-run in a browser |

---

## A. Executive summary

### Overall assessment

Candidary's host gallery is a **strong, opinionated product with an unusually careful mental model and unusually weak
guardrails around the actions that can hurt someone.** The core idea — photos are delivered privately first, and
publication, album membership, and sharing are three independent axes the host controls separately — is genuinely
better than the "upload and it's public" default of the category, and the copy explaining it is the best writing in the
product ("Publication is a separate axis from the album. A photo is delivered privately whether or not it is published,
and an album pick never publishes anything.").

The problem is that this careful model has one hole, and the hole is in the highest-privacy surface. **Once an album
share link exists, the album stops being a private working document and becomes a live publication — but every other
surface goes on talking as though it were still private.** Picking a photo in the Library, directly beneath the sentence
"it does not publish it", puts that photo in front of everyone holding the link within one request. Hiding a photo — the
one control whose entire purpose is "guests must not see this" — does not remove it from the link.

Alongside that, the destructive-action design is inverted: the most consequential actions have the least friction.
Permanently deleting a guest's photo is one click on an unlabelled trash icon with no confirmation, no toast, and no
undo. Killing a public album link that relatives may already be using is one click with no confirmation. Meanwhile,
signing guest devices out — reversible, and far less consequential — requires typing the full event name.

### Most serious risks

1. **A live album link silently republishes as the host works.** Every Library pick reaches link holders immediately;
   hidden photos stay visible; guest-written captions are published verbatim. Nothing outside the Album tab shows a
   share is live. *(G-01, G-02, G-03)*
2. **Permanent photo deletion is one unconfirmed icon click.** Soft-deleted in the database, but the manager has no
   deleted view, no restore and no undo — while the guestbook, for text, has all three. *(G-04)*
3. **The complete export is a one-shot.** After the first "Download all", the prepare control never returns and "Retry
   export" re-runs the original frozen snapshot. Photos arriving later can never be exported. *(G-05)*
4. **The guest gallery API hands every guest the full internal media row** — uploader session identifiers, R2 object
   keys, and `favoritedAt`, which exposes the host's private album picks. *(G-06)*
5. **Every event setting silently fails to save in development and preview builds**, while the UI shows a permanent
   "Saved" chip. Production is very likely unaffected, but every local validation of settings is invisibly broken.
   *(G-07)*
6. **"Pause photo delivery" removes the entire guest experience** — shared gallery and guestbook included — and says
   nothing about it. *(G-08)*
7. **Host accounts promise "you can do this later" and then do not exist** until the emailed code is entered; the
   sign-in that follows blames the password. *(G-09)*

### Strongest aspects worth preserving

- **The three-axis model and the copy that teaches it.** Delivery / publication / album membership are genuinely
  independent and the interface says so repeatedly and accurately.
- **The photo viewer is a reference-quality modal**: `aria-modal`, focus lands on Close, focus trapped, arrow-key
  paging, Escape restores focus to the photo you ended on, and it announces "Photo 2 of 11. Sparkler send-off, from
  Priya Raman." It should be the pattern every other dialog copies.
- **Responsive hygiene is excellent.** No horizontal overflow anywhere at 390×844 or 320×844, including the album
  editor and the selection tray, and no sub-44px touch targets in Gallery or Album.
- **Live-region announcements are specific and reassuring** rather than generic: "photo-11.png added to the album. This
  does not publish it.", "Sparkler send-off is back in the album."
- **Cover Studio's async-safety copy** is exactly right: "Your current cover stays live until the new one is completely
  ready. If anything fails, nothing changes."
- **Album autosave** shows honest state transitions and names its blocking field: "Album can't save. Album title: Give
  this album a title."
- **Export artifacts are labelled for a human**, including "Private entry archive — Contains entries guests cannot see".
- **Duplicate submission is handled**: double-clicking "Share album" produced exactly one POST.

### Ten highest-priority improvements

| # | Improvement | Addresses |
| --- | --- | --- |
| 1 | Make "a share is live" a global, persistent state in the manager, and gate every album mutation behind it | G-01, G-02, G-03 |
| 2 | Exclude `hidden` photos from the public album projection, or state on screen that hiding does not reach the link | G-02 |
| 3 | Add a confirmation and a 30-second undo to photo deletion; add a "Recently deleted" view | G-04 |
| 4 | Restore the "Download all" entry point after a job reaches `ready`, and re-snapshot on retry | G-05 |
| 5 | Project the guest gallery payload down to the fields guests need | G-06 |
| 6 | Guard the settings/appearance autosave queues against effect replay, as `ManagerAlbum` already does | G-07 |
| 7 | Confirm "Stop sharing album", and say that the link can never be revived | G-10 |
| 8 | Rename "Pause photo delivery" and state its full guest consequence | G-08 |
| 9 | Put manager destinations in the URL so reload, Back and bookmarks work | G-11 |
| 10 | Adopt one destructive-confirmation ladder across all seven destructive actions | G-12 |

---

## B. Coverage inventory

| # | Feature / workflow | Entry point | States and devices tested | Result |
| --- | --- | --- | --- | --- |
| 1 | Discover gallery features | `/manage/:token` → left nav | populated, empty; 1440/390/320 | **Friction** — no onboarding on an empty event |
| 2 | Create first event | `/create` | signed out, signed in; 1440 | **Clear** |
| 3 | Create from template / duplicate | — | — | **Not applicable** — no templates, no duplication |
| 4 | Host adds own photos | — | searched all `type=file` inputs | **Not applicable** — no host intake path (G-19) |
| 5 | Guest upload → host intake | `/join#…` → Intake | 12 photos, 3 guests; paused/open | **Clear** |
| 6 | Live intake review | Intake | 0 and 12 photos; 1440/390/320 | **Friction** — empty state wrong (G-24) |
| 7 | Delete a photo | Intake card trash icon | populated; 1440 | **Broken** — G-04 |
| 8 | Download a single original | Intake card | populated | **Clear** |
| 9 | Filter intake by guest name | Intake search | populated | **Friction** — filter leaks to Shared (CODE, G-20) |
| 10 | Library browse / search / sort | Gallery › Library | 0 and 12 photos; 1440/390/320 | **Clear** |
| 11 | Bulk selection | Gallery › Library › Select photos | 1, 12, select-all; 1440/390 | **Clear** |
| 12 | Add / remove album picks | Library card, tray, album editor | 0→5→4→5 picks | **Friction** — undo only on one of two paths (G-15) |
| 13 | Album: start from favorites gate | Gallery › Album | new event with 5 picks | **Friction** — G-13 |
| 14 | Album: title / description | Album editor | valid, empty (invalid) | **Clear** |
| 15 | Album: reorder | Album editor arrows, drag | keyboard; 1440/390 | **Friction** — focus lost after move (G-21) |
| 16 | Album: sections | Album editor | add, rename, remove + undo | **Friction** — empty section ships (G-16) |
| 17 | Album: cover selection | Album editor star | implicit and explicit | **Clear** |
| 18 | Album: preview | Album › Preview album | 5 photos, 1 section | **Friction** — preview ≠ recipient view (G-22) |
| 19 | Album: share link | Album › Share album | create, re-display, copy, stop, re-share | **Broken** — G-01, G-02, G-03, G-10 |
| 20 | Album: recipient experience | `/album#…` | fresh context, revoked link | **Clear** for the happy path |
| 21 | Publish / hide to shared gallery | Gallery › Shared | single, bulk, gallery off then on | **Friction** — no feedback (G-14) |
| 22 | Shared gallery visibility toggle | Settings | off → on | **Broken in dev** — G-07 |
| 23 | Guest-visible result | `/event/:slug`, `/fullscreen` | gallery off/on, paused | **Friction** — G-08 |
| 24 | Guestbook moderation | Guestbook | 8 captions, 4 published | **Clear**, but tab labelling confuses (G-25) |
| 25 | Complete export | Gallery › Library › Download all | queued → ready → links | **Broken** — G-05 |
| 26 | Album export | Album › Download album photos | ready; concurrent with complete | **Friction** — stale count (G-17) |
| 27 | Export retry / expiry | — | code path only | **Not tested** — needs a 24h wait or a forced failure |
| 28 | Cover: preset | Settings › Change cover | 3-step flow, publish | **Clear** |
| 29 | Cover: upload + framing + style | Settings › Change cover | 4-step flow, 2400×1600 PNG | **Friction** — G-23, no upload progress |
| 30 | Cover: focus trap | Cover Studio dialog | keyboard | **Broken** — G-18 |
| 31 | Event theme / colours | Settings › Event appearance | preset switch | **Broken in dev** — G-07 |
| 32 | Event settings (name, dates, prompt) | Settings | valid edits | **Clear** (text fields flush and persist) |
| 33 | Pause / reopen photo delivery | Settings | pause, reopen, guest check | **Friction** — G-08 |
| 34 | Sign out guest devices | Share | confirm + cancel | **Clear** confirmation; no success receipt (CODE) |
| 35 | Disable printed event QR | Share | confirm + cancel | **Clear** confirmation |
| 36 | Rotate manager link | Settings | link-only event, claim window open | **Broken** — G-09b |
| 37 | Delete event | Settings | opened, cancelled | **Friction** — fires a rejected DELETE (G-12) |
| 38 | Host account register / verify | `/host/register` | pending, code, confirmed | **Broken** — G-09 |
| 39 | Host sign-in | `/host/login` | before and after verification | **Broken** before verification — G-09 |
| 40 | Multiple galleries | `/host/events` | 2 events | **Friction** — flat list, no actions (G-26) |
| 41 | Manager navigation / deep links | left nav, reload, Back | all destinations | **Broken** — G-11 |
| 42 | Unsaved changes on navigation | Settings → home mid-edit | text edit | **Clear** — the edit flushed and persisted |
| 43 | Offline failure and recovery | Album editor, Shared | `setOffline(true)` | **Friction** — raw error text (G-27) |
| 44 | Duplicate submission | Share album | double click | **Clear** — one POST |
| 45 | Keyboard: photo viewer | Library card → Enter | Tab, arrows, Escape | **Clear** — exemplary |
| 46 | Mobile layout | all destinations | 390×844, 320×844 | **Clear** for overflow; **Friction** for density (G-28) |
| 47 | Collaborators / roles / ownership | — | code search | **Not applicable** — no roles; `event_hosts` membership only |
| 48 | Analytics / activity feed | — | code search | **Not applicable** |
| 49 | Search / folders / collections across events | — | `/host/events` | **Not applicable** |
| 50 | Archive / restore / retention | Settings, `/host/events` | retention dates shown | **Partial** — retention shown, no archive/restore |
| 51 | Plan limits / upgrade prompts | — | code search | **Not applicable** — fixed limits, no plans |
| 52 | Scheduled / unpublish / republish gallery | — | code search | **Not applicable** — no scheduling |

---

## C. Host lifecycle journey

| Stage | Host goal | Current workflow | Friction and uncertainty | Guest-facing consequence | Improvement opportunity |
| --- | --- | --- | --- | --- | --- |
| 1. Discover | "Where do my photos go?" | `/create` → manager opens on Intake | Empty Intake says "No matching photos." and offers no next step | None yet | First-run panel: print the QR, then wait |
| 2. Create | Set up the event | One form: name, date, time, zone, RSVP deadline, welcome, theme, optional cover | Clear and short | Cover and theme are immediately live | Keep |
| 3. Add content | Get photos in | Guests scan the QR; the host cannot add photos at all | Host has no intake path (G-19) | Guests do all the work | Add host upload into Intake |
| 4. Organise | Triage what arrived | Intake (delete/download) and Library (pick/search/sort) are two different cards for the same photo | Neither shows publication state next to album state | None | One card, one action set |
| 5. Customise | Make it feel like the event | Settings › Event appearance → Cover Studio | Cover changes are async and well explained; theme changes are instant | Guests see the cover at the top of RSVP and delivery | Keep; add upload progress |
| 6. Configure access | Decide what guests see | Settings toggles + Gallery › Shared | The toggle and the publish surface are in different destinations | Publishing does nothing visible until the toggle is on | Put the toggle in the Shared header |
| 7. Preview | "What will they see?" | Album has a preview; the shared gallery has none | The album preview omits the cover and captions the recipient sees | Host guesses | Real preview for both |
| 8. Publish / share | Get it in front of people | Gallery › Shared for guests; Gallery › Album › Share album for a link | Sharing lives in Gallery while a destination named **Share** holds only the QR | Link holders see the album instantly | Move album sharing into Share, or cross-link |
| 9. Manage activity | Moderate notes and captions | Guestbook: Needs review / Shared / Hidden / Deleted | Publishing a photo in Gallery silently resolves its caption here | Captions become guest-visible | Say so at the point of publishing |
| 10. Update live | Change a shared album | Edit the album; every change is live | Nothing on screen says the album is live | Recipients see edits instantly | Live-share banner + "publish changes" |
| 11. Review | "Did it work?" | Counts in the header; no analytics | No view count, no "N photos guests can see" | — | Add a guest-visible count |
| 12. Retire | Wind down | Pause delivery, disable QR, stop sharing, delete event | Four different confirmation patterns, inverted by severity | Pausing hides everything guests had | One ladder; state guest impact |

---

## D. Prioritized findings

Severity: **P0** data loss / privacy / complete blocker · **P1** prevents or seriously jeopardizes a core task ·
**P2** significant friction or inconsistency · **P3** minor.

| ID | Sev | Kind | Workflow / location | Observed | Expected | Evidence | Host impact | Root cause | Confidence | Recommendation | Acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G-01** | P0 | functional | Gallery › Library, with a share live | Picking a photo puts it on the public link within one request | A pick is private until the host publishes the change | **API**: pick `photo-12` → `/api/album-share` count 4→5 immediately. On-screen copy: "Picking a photo adds it to the album for every host on this event — it does not publish it." | A host tidying the album exposes photos they never meant to send | Album membership is `favorited_at`; the public projection is derived live | High | Show a persistent "This album is shared" state in Library and Album; either stage edits behind an explicit **Publish changes**, or change the Library sentence to "it does not add it to the shared gallery — it is visible to anyone holding your album link" | Given a live share, when a photo is picked in Library, then the host is told the link now includes it before or as it happens |
| **G-02** | P0 | functional | Gallery › Shared "Hide", with a share live | Hiding a photo leaves it fully visible on the album link, caption included | Hide means guests cannot see it anywhere | **API**: `PATCH {action:'hide'}` on an album photo → `publicationStatus:"hidden"`, `/api/album-share` still lists it | The one control meant to retract a photo does not retract it | The album-share reader authorizes on album membership only and never reads `publication_status` | High | Exclude `hidden` (and ideally `unpublished`) from the public album projection; if that is deliberate, say it on the Hide control | Given a photo in a shared album, when it is hidden, then the public album no longer returns it |
| **G-03** | P0 | content | Public album | Guest-written captions are published verbatim to link holders | The host reviews captions before recipients see them | **API**: public album returns `caption:"Cousins before the ceremony"` etc. Guestbook has a whole moderation queue for the same strings | Captions the host never approved reach outsiders | Two moderation models for one string | High | Either run album captions through the Guestbook queue, or state on the Album that captions travel with the photo | Given an unreviewed caption, when the album is shared, then it is either withheld or the host was told it would be published |
| **G-04** | P0 | functional | Intake › photo card trash icon | One click permanently removes a guest's photo — no confirm, no toast, no undo, no restore | Destructive, irreversible actions are confirmed and recoverable | **LIVE**: count 12→11, no dialog, no live-region text. **D1**: `deleted_at` set. No "Deleted" view exists for photos, while the Guestbook has one | A mis-tap destroys a guest's only copy of a moment | Delete shares the ordinary publication action path | High | Add a confirmation naming the photo and contributor, a 30-second undo, and a "Recently deleted" view for the retention window | Given a delete, when the host acts within 30 s, then the photo returns; a deleted photo is listed and restorable until purge |
| **G-05** | P1 | functional | Gallery › Library › Download all | After one export the prepare control never returns; "Retry export" re-runs the original frozen snapshot | The host can export everything, at any time | **LIVE**: "Download all" replaced by "Get download links", no prepare control. **CODE**: prepare renders only in the `!job` branch; retry reuses the same row and `snapshot_at` | Photos arriving after the first export can never be delivered in bulk | Export is modelled as one job per event rather than one archive per request | High | Always offer "Prepare a new download"; make retry re-snapshot; label each job with its snapshot time | Given a ready export and new photos, when the host prepares again, then the new export contains them |
| **G-06** | P1 | privacy | `GET /api/event/:slug/gallery` | Returns the complete internal media row to any guest | Guests receive only what the gallery renders | **API**: keys include `uploaderSessionId`, `objectKey`, `objectBucketGeneration`, `idempotencyKey`, `previewObjectKey`, `reservationExpiresAt`, `favoritedAt`, `deletedAt` | Guests can correlate which photos came from the same device, and can read the host's private album picks | The route serializes `MediaRecord[]` unfiltered | High | Project to a guest view (`id`, `caption`, `guestName`, `width`, `height`, `timelineAt`) | Given a guest session, when the gallery is read, then the payload contains no session id, object key or favourite marker |
| **G-07** | P1 | functional | Settings — all fields and appearance | No request is issued; the value reverts on reload; the chip says "Saved / Event settings saved" throughout | Changes save, or the failure is visible | **LIVE**: zero network calls for name and all three toggles; **D1**: `gallery_visible` stayed 0. Removing `React.StrictMode` makes the PATCH fire and persist | Every local or preview validation of settings is invisibly wrong, and the status actively lies | `EventSettingsEditor.tsx:316` / `EventAppearanceEditor.tsx:356` dispose a ref-held queue in an unguarded cleanup; StrictMode replays effects; `autosave-queue.ts` `submit()` returns early when disposed. `ManagerAlbum.tsx:723-735` already guards this | High | Copy the `queueMicrotask` generation guard into both editors; make "Saved" mean "a write was confirmed", never the initial state | Given StrictMode, when a setting changes, then a PATCH is sent and the status reflects it |
| **G-08** | P1 | missing-state | Settings › Pause photo delivery | Pausing removes the shared gallery, Guestbook and My deliveries from the guest page entirely | Pausing uploads pauses uploads | **LIVE**: guest page reduced to "Photo delivery is paused…"; reopening restored everything. `/event/:slug/fullscreen` still served the gallery while paused (`EventPage.tsx:82` gates on `galleryVisible` only) | The host silently takes down everything guests had | One flag gates the whole guest surface | High | Rename to "Pause guest access", state the full consequence in the control, and gate `/fullscreen` on the same rule | Given a paused event, when a guest opens either route, then both behave identically and the host was told which surfaces stop |
| **G-09** | P1 | content | `/host/register` | "You can do this later. Confirming only gates the emails we send you." — but no account exists until the code is entered | The promise matches the system | **LIVE + D1**: `host_accounts` empty after registration; sign-in returned 401 "Check your email address and password."; entering the code created the account | A host believes they have an account, cannot sign in, and is told their password is wrong | Account creation is deferred to confirmation | High | Say "Your account is created once you enter the code."; on sign-in for a pending registration, offer "Finish creating your account" instead of a credentials error | Given an unconfirmed registration, when the host signs in, then they are routed back to confirmation |
| **G-09b** | P1 | functional | Settings › Rotate manager link | On a link-only event the action always fails with 409, and the notice renders three times far below the fold | Either the action works or it is not offered | **LIVE**: native `confirm()` accepted → `409 OWNER_CLAIM_REQUIRED`, notice "Save this event from its original creator session before rotating its management link." shown ×3 at scroll y≈2596; the old link still resolves. **CODE**: for an owned event, `rotateManagerLink()` discards the returned link into `window.location.assign(...)`, so the new link is never shown or copyable | A host who fears their link leaked cannot rotate it, and when they can, they never receive the replacement | Ownership guard added without adjusting the control; success path drops the payload | High | Disable the control with the reason inline and link to the Sign in / Create account controls above it; on success, show the new link with Copy and require acknowledgement before navigating | Given rotation is unavailable, then the button is disabled and explains why; given success, then the new link is displayed and copyable |
| **G-10** | P1 | usability | Album › Share album / Stop sharing album | Both are single unconfirmed clicks on the same secondary button; stopping is permanent | Publishing and revoking a public link are deliberate | **LIVE**: one click created a live link; the warning appears only afterwards; one click stopped it; the old link then returned 410 and re-sharing minted a different secret | A mis-click either exposes an album or breaks a link relatives are already using | The share control is a plain toggle | High | Show the consequence before creating; confirm stopping with "Anyone using the old link will lose access, and it cannot be restored"; style stop as destructive | Given a live share, when Stop is pressed, then a confirmation states the permanence and the action only proceeds on confirm |
| **G-11** | P2 | usability | Manager navigation | The URL never changes; reload returns to Intake; Back leaves the app | Destinations are addressable | **LIVE**: from Gallery › Album, reload → Intake; Back → `about:blank`. **CODE**: only `?section=rsvp` is honoured | A host who reloads mid-curation loses their place every time | Section is local state | High | Put destination and gallery mode in the URL and honour them on load | Given `?section=gallery&mode=album`, when the page loads, then that view is shown and reload preserves it |
| **G-12** | P2 | consistency | All destructive actions | Five patterns: none (delete photo), none (stop sharing), native `confirm()` (rotate link), typed event name (sign out guests, disable QR, delete event) — and severity is inverted | One ladder, ordered by consequence | **LIVE**: all five observed. "Delete event" also fires a `DELETE` that returns 422 before the client validates | Hosts cannot learn what a confirmation means | No shared destructive-action component | High | Define three rungs — toast+undo, in-context confirm, typed-name — and map every action to one; validate before sending | Given any destructive action, then its friction matches its rung, and no request is sent until the client gate passes |
| **G-13** | P2 | usability | Gallery › Album, new event with picks | "5 photos were favorited before this album existed" on an event created minutes ago, with a forced Start-from / Start-empty choice | New albums start empty and quietly | **LIVE**: shown after five picks made in the same session; an album with zero picks skips it | The more work a host has done, the more obstructed they are | The gate keys on "album row not saved yet AND picks exist" | High | Show it only when picks predate the album feature; otherwise adopt the picks silently | Given picks made after the album existed, when Album opens, then the editor is shown directly |
| **G-14** | P2 | missing-state | Gallery › Shared | A per-photo Publish gives no confirmation; the card simply vanishes. Bulk announces only "Publishing finished." | Every write confirms what changed | **LIVE**: no live-region text on single publish; bulk text carries no count | The host cannot tell a publish from a filter refresh | Only the bulk path emits announcements | High | Announce "Published *name*. Guests can see it now." with an undo; give bulk a count | Given a publish, then a message names the photo and its guest visibility |
| **G-15** | P2 | consistency | Album pick removal | Undo in the album editor, none for the same removal from a Library card | Same action, same recovery | **LIVE**: album editor showed "Undo / Dismiss"; Library announced removal only | Recovery depends on which screen you used | Undo is wired per surface | High | Route both through the same undo controller | Given a pick removal on either surface, then the same undo offer appears |
| **G-16** | P2 | usability | Album sections | An empty section publishes to recipients as a bare heading; new sections always append to the end | Empty sections are not published | **LIVE**: `/album` rendered "New section" with nothing under it | Recipients see an unfinished album | Sections are entries with no emptiness rule | High | Omit empty sections from the public projection and flag them in the editor; insert new sections after the current selection | Given an empty section, then recipients do not see it and the editor marks it |
| **G-17** | P2 | missing-state | Album export panel | Shows "Ready. 5 photos · 107 KB" beside a four-photo album, never saying the export is frozen | Snapshot semantics are visible | **LIVE**: album reduced to 4; panel unchanged | The host mistrusts the count or the album | `snapshotAt` is on the wire and unused | High | Label the job "Frozen at 3:14 PM — 5 photos" and offer a fresh export when the album has moved | Given the album changed after an export, then the panel says so and offers a new one |
| **G-18** | P2 | accessibility | Cover Studio dialog | Tab leaves the dialog into the page behind it | Modals trap focus | **LIVE**: `DLG:upload → DLG:Choose photo → OUT:(page) → DLG:Cancel` | Keyboard and screen-reader hosts fall out of the flow | No focus trap; the photo viewer has one | High | Apply the photo viewer's trap and `aria-modal` to Cover Studio | Given the dialog is open, then Tab and Shift+Tab cycle only within it |
| **G-19** | P1 | missing-state | Host photo intake | The host cannot add a photo to their own event anywhere | A host can contribute | **CODE**: the only `type=file` inputs are the guest drop, the create-form cover and Cover Studio | The host's own camera roll can never join the gallery | No host intake route | Medium | Add host upload to Intake, attributed to the host | Given a host with a photo, then they can add it without using a guest link |
| **G-20** | P2 | functional | Intake filter → Shared | The guest-name filter follows the host into Shared with no indicator and no way to clear it | Filters are scoped to their surface | **CODE**: `guestFilter` feeds every `/media` request; `transitionToSection` does not reset it | "No unpublished photos." can be false | Shared shell state | Medium | Reset on destination change, or show and offer to clear it | Given a filter set in Intake, when Shared opens, then it is cleared or visibly shown |
| **G-21** | P2 | accessibility | Album reorder | After a keyboard move, focus jumps to the opposite arrow; the move itself is not announced | Focus follows the moved item; the move is announced | **LIVE**: focus landed on "Move … later"; only "Album saved" was announced | Keyboard hosts cannot walk a photo in one direction | Focus is not restored after re-render | High | Keep focus on the pressed control and announce "*name* moved to position 2 of 5" | Given repeated Enter on "Move earlier", then the photo walks to position 1 and each move is announced |
| **G-22** | P2 | consistency | Album › Preview album | Headed "What a guest opening the link sees" but omits the hero cover and the captions recipients get | Preview matches the recipient view | **LIVE**: preview showed five equal thumbnails; `/album` showed a large cover, a "5 PHOTOS" count and captions | The host approves something they have not seen | Two renderers | High | Render the public component in the preview, or retitle it "Album summary" | Given a preview, then it is visually equivalent to the public album |
| **G-23** | P2 | missing-state | Cover Studio › Choose a style | Four of five styles read "Preview not ready" on arrival, with no explanation or retry | Styles are previewable or the wait is explained | **LIVE**: only "Natural" had a preview. **CODE**: previews are fetched on selection only | The host picks a look blind | Lazy per-selection fetch | High | Pre-fetch all five on entering the step and show a spinner per tile | Given the style step, then every tile shows a preview or a labelled loading state |
| **G-24** | P3 | content | Intake, empty event | "No matching photos." with nothing filtered | "No photos yet." | **LIVE** on a 0-photo event | A new host reads it as a failed search | One empty state for two situations | High | Split the empty and no-results states | Given zero photos and no filter, then the copy is "No photos yet." |
| **G-25** | P3 | content | Guestbook tabs | A published caption with the gallery off is filed under "Hidden" | The label matches the state | **LIVE**: publishing 4 photos moved 4 captions to "Hidden"; turning the gallery on moved them to "Shared". The per-entry chip does say "Published · gallery off" | The host thinks publishing hid the caption | View mapping folds two states | High | Rename to "Not visible to guests" or add the qualifier to the tab | Given the gallery is off, then the tab explains why published entries sit there |
| **G-26** | P3 | usability | `/host/events` | A flat list with only Sign out and an email checkbox — no create, search, sort or archive | Managing several events scales | **LIVE**: 2 events listed with name, date, "0 photos", retention date | A host with a season of events cannot organise them | Dashboard is a list | High | Add "Create event", search, and sort by date | Given ten events, then the host can find one without scrolling the whole list |
| **G-27** | P2 | content | Offline album save | Raw `Failed to fetch` in three phrasings plus a page banner; nothing retries on reconnect | One human message and one retry | **LIVE**: "Album could not save a change." + "Failed to fetch" + "Couldn't save. Failed to fetch" + "Album couldn't save. Failed to fetch / Retry" | The host sees developer text at the worst moment | Raw `error.message` is rendered | High | Map network failures to "Your changes could not be saved — you may be offline."; show one message; retry automatically on reconnect | Given an offline save, then exactly one human message and one Retry appear |
| **G-28** | P2 | usability | Gallery on a phone | The first photo in Library sits **1,304 px** down the document — about 1.5 screens | Content is near the top | **LIVE** at 390×844: Library 1,304 px, Album 804 px, Intake 696 px | Every visit to the gallery starts with scrolling past chrome | Header, stats, tabs, description, export card, search, sort and select all precede the grid | High | Collapse the export card and the mode description on small screens; move search and sort into a sticky bar | Given 390×844, then at least one photo is visible within the first viewport |
| **G-29** | P2 | consistency | Vocabulary | One concept, many names: Guest uploads / Photo delivery / private deliveries / Live intake / Library / photos stored | One name per concept | **LIVE** across header chip, Settings, Intake and Gallery | Hosts cannot map words to places | No terminology source of truth | High | Pick one term per concept and apply it everywhere | Given any destination, then arriving photos are called the same thing |
| **G-30** | P2 | consistency | Publication vocabulary | Four vocabularies for guest visibility across four destinations; "optional shared gallery" appears in two variants | One vocabulary | **LIVE**: "Show the optional shared gallery", "the optional gallery", "Shared", "Published" | The host cannot tell whether they mean the same thing | Same as G-29 | High | Standardise on "Shared gallery" and "Published / Not published / Hidden" | Given the four surfaces, then they use one set of terms |
| **G-31** | P2 | usability | Gallery › Shared cards | Every card offers both Publish and Hide at equal weight, including inside the Unpublished filter where Hide is near-meaningless | The relevant action leads | **LIVE**: 8 cards × 2 buttons in the Unpublished tab | Sixteen equal choices where three matter | Cards ignore the active filter | High | Show the state-appropriate primary and demote the other to an overflow | Given the Unpublished filter, then each card leads with Publish |
| **G-32** | P2 | usability | Album share link display | The full credential is rendered permanently in plain text with no hide control | Secrets are masked by default | **LIVE**: `http://localhost:5173/album#39gbe…` on screen and in the mobile layout | Shoulder-surfing and screenshots leak the link | Re-display is always-on | Medium | Mask with a Reveal control, as printed credentials use | Given a live share, then the link is masked until revealed |
| **G-33** | P3 | content | Album title | Defaults to the literal value "Album" and is required | A blank field with a placeholder | **LIVE**: `textbox "Album title": Album`; clearing it blocks saving | A host ships an album called "Album" | Default value instead of placeholder | High | Default to the event name; make the field a placeholder | Given an untouched album, then its title is the event name |
| **G-34** | P3 | usability | Library, empty event | "Download all" is enabled with "0 photos" | Disabled with a reason | **LIVE** on a 0-photo event | An empty export can be created | No zero guard | High | Disable and explain | Given zero photos, then the control is disabled |
| **G-35** | P3 | content | Guestbook default tab | "Shared 0" on an empty event, "Needs review" on a populated one | One deterministic default | **LIVE** on both | The host lands somewhere different each time | Default derived from counts | High | Always default to "Needs review" | Given any event, then Guestbook opens on Needs review |
| **G-36** | P3 | content | Gallery date headings | "Sunday, August 23 · 10:00–10:00 AM" | A single time when the range collapses | **LIVE** with 12 same-minute uploads | Reads like a bug | Range formatter has no equality case | High | Collapse equal endpoints | Given identical endpoints, then one time is rendered |
| **G-37** | P3 | missing-state | Cover upload | No progress or status while a 19 MB photo transfers | Progress is visible | **LIVE**: no status change during a 2400×1600 upload | On a phone the host cannot tell it is working | No progress wiring on the raw PUT | High | Show determinate progress and a cancel | Given an upload, then progress and cancel are available |
| **G-38** | P3 | content | Delivery control | "Pause photo delivery" ↔ "Reopen photo delivery" | Pause ↔ Resume | **LIVE** on both states | Small but avoidable | — | High | Use Resume | — |
| **G-39** | P3 | content | Registration success | Ends on `/host/register?pending=1` with no route onward | A route to the events dashboard | **LIVE** after confirming | A dead end at the moment of success | No post-success navigation | High | Redirect to `/host/events` or offer a button | Given confirmation, then the host reaches their events in one step |
| **G-40** | P3 | consistency | Library card state | Renders both "In the album" and an "In album" chip | One label | **LIVE** on picked cards | Visual noise | Duplicate label | High | Keep the chip | — |
| **G-41** | P2 | missing-state | Export failures | `error_code` is recorded in D1 and documented as host-visible but stripped from the API view; a failed export shows only "Attempt N failed." | The host is told why | **CODE**: `managerExport()` omits `errorCode`; `ExportView` has no field | The host cannot tell a transient failure from a permanent one | View projection | Medium | Carry `errorCode` and map each `EXPORT_*` to host copy | Given a failed export, then the reason is named |
| **G-42** | P2 | missing-state | Long exports | `queued` and `running` both render as "Preparing" with no progress or elapsed time, and polling stops when the host leaves Gallery | Long operations show progress | **CODE**; **LIVE** only for a sub-second export | On a 100 GB event the host cannot tell it is alive | Two states, one label | Medium | Distinguish queued from running, show parts completed, keep polling across destinations | Given a running export, then progress is visible from any destination |
| **G-43** | P2 | functional | Bulk publish across mixed states | One request per status group in sequence; a mid-loop failure leaves earlier groups written while the UI claims nothing happened | Bulk is atomic or honestly partial | **CODE**: `bulk()` in `ManagerPage.tsx` | The host retries and re-applies work already done | Client-side grouping | Medium | One request, or report per-group outcomes | Given a partial failure, then the host is told what succeeded |
| **G-44** | P2 | missing-state | Manager first load | One failing background read replaces the whole manager with an error page | A failed panel degrades locally | **CODE**: `refresh()` awaits `Promise.all` over five reads, two defended | A transient blip locks the host out of everything | Unguarded `Promise.all` | Medium | Settle independently and fail per panel | Given one failed read, then the rest of the manager still renders |
| **G-45** | P2 | accessibility | Undo bar | Rendered last in the DOM behind the whole grid, so keyboard hosts cannot reach it inside its nine-second window; in the album it is `live={false}` | Undo is reachable and announced | **CODE**: `UndoBar` is the last child of both surfaces | Undo exists but not for keyboard or screen-reader hosts | DOM order and a disabled live region | Medium | Move it into the live region and focus it on appearance | Given an undo offer, then one Tab reaches it and it is announced |
| **G-46** | P2 | accessibility | Automated coverage | The album workspace, Shared mode, selection mode, the tray and album sharing are absent from the axe suite | Host surfaces are scanned | **CODE**: `tests/e2e/accessibility.spec.ts` | Regressions land unnoticed | Suite predates the workspace | High | Extend axe to every host destination | Given the suite, then each host destination is scanned |
| **G-47** | P2 | usability | Publishing at scale | 24 per page, 50 per batch, no select-all in Shared, and the list resets to page one after each write | Publishing hundreds is possible | **CODE**: `MANAGER_MEDIA_PAGE_SIZE = 24`, `MANAGER_BULK_SELECTION_MAX = 50` | On a 1,000-photo event publishing is impractical | Shared mode lacks Library's selection model | Medium | Give Shared the Library tray, select-all-results, and preserved position | Given 1,000 photos, then all can be published in a bounded number of actions |
| **G-48** | P2 | consistency | Library card | Never shows publication state, so the review surface cannot answer "can guests see this?" | State is visible where photos are reviewed | **CODE**: `publicationStatus` is on the wire and unused in `GalleryMoment` | The host switches destinations to answer one question | Card omits the field | High | Show the publication chip on Library cards | Given a Library card, then its publication state is visible |
| **G-49** | P3 | consistency | Icons | Eye / EyeOff / Check each carry several meanings across Gallery and Guestbook | One icon, one meaning | **CODE** + **LIVE** | Icons stop being learnable | No icon registry | High | Fix one meaning per icon and always pair with a label | — |
| **G-50** | P3 | consistency | Dates | The retention date renders in the browser locale beside a long en-US event date | One date format | **CODE** + **LIVE**: "Files delete 12/21/2026" beside "August 21, 2026" | Reads as two systems | Two formatters | High | Use one formatter in the event's zone | — |

---

## E. Workflow deep dives

### E1. Curate and share an album

**Current steps.** Gallery › Library → *Select photos* or per-card **+** → picks accumulate → Gallery › Album →
(first time) choose *Start the album from them* / *Start empty* → title, description → reorder with arrows or drag →
optionally *Add a section* → *Preview album* → *Share album* → link appears with *Copy album link*.

**Success path.** Works, and the autosave is honest: "Saving album" → "Album saved", with the blocking field named when
the title is emptied. Reordering is keyboard-operable. Removing an entry offers a nine-second undo.

**Failure paths.** Offline produces a page banner, an inline error and a Retry — but shows raw `Failed to fetch` three
times (G-27). An album that cannot save blocks Preview, Share and Export silently (CODE).

**Unnecessary decisions.** The favourites gate (G-13) inserts a two-button choice into a brand-new album. The album
title arrives pre-filled with "Album" (G-33). "Preview album" is offered as a step but does not show what recipients see
(G-22).

**Inconsistent behaviour.** Undo on one removal path but not the other (G-15). The preview's primary button is
"Download album photos" while the step is headed "When the album is right", where sharing is the likely goal.

**Recommendations.** Skip the gate for albums created after the feature; default the title to the event name as a
placeholder; render the real public component in the preview; unify undo; make "Share album" the primary in the preview
footer.

### E2. Publish photos to the shared gallery

**Current steps.** Gallery › Shared → filter tab (Unpublished / Published / Hidden) → per-card *Publish* / *Hide*, or
checkboxes → *Publish selected*. If the gallery is off, a notice explains and links to Settings.

**What works.** The notice — "The optional shared gallery is off. Publishing choices are saved until you turn it on. /
Open settings" — is exactly the right kind of just-in-time explanation. The separation-of-axes copy is excellent.

**What does not.** No feedback on a single publish (G-14); "Publishing finished." carries no count; every card offers
Publish and Hide at equal weight regardless of the active filter (G-31); the Library — where the host actually reviews —
never shows publication state (G-48); scale is impractical past a few dozen photos (G-47). Publishing a photo also
resolves its guest caption in the Guestbook, which nothing at the point of action says.

**Recommendations.** Announce every publish with the guest consequence and an undo; lead each card with the action its
filter implies; add the publication chip to Library cards; give Shared the Library selection tray; say "This also shares
the guest's caption" on the Publish control.

### E3. Deliver the archive

**Current steps.** Gallery › Library → *Download all* → "Preparing your download…" → "Ready. 12 photos · 259 KB · 8
guestbook entries. Download links last 24 hours." → *Get download links* → four labelled links.

**What works.** The artifact labelling is genuinely good, including "Private entry archive — Contains entries guests
cannot see". Album and complete exports share one vocabulary.

**What does not.** The archive is frozen at the first click and the prepare control never returns (G-05). Failure
reasons never reach the host (G-41). Long runs show one static "Preparing" (G-42). Nothing says the export is a
snapshot (G-17).

**Recommendations.** Always offer a fresh export; re-snapshot on retry; label jobs with their snapshot time; surface
`EXPORT_*` reasons; distinguish queued from running with parts completed.

### E4. Decide what guests can see

**Current steps.** Settings › *Show the optional shared gallery* → Gallery › Shared to publish → guests open
`/event/:slug` and expand *Shared gallery*.

**Friction.** The switch and the publishing surface live in different destinations, with different names for the same
thing (G-30). There is no guest preview of the shared gallery at all, though the album has one. Turning the switch on
never reaches an already-open guest page (CODE). Pausing delivery silently removes the gallery entirely (G-08).

**Recommendations.** Put the switch in the Shared header with a live count of what guests can see; add a "View as a
guest" preview; rename the pause control and state its full effect.

### E5. Retire the gallery

**Current steps.** Settings › *Pause photo delivery*; Share › *Sign out guest devices* / *Disable printed event QR*
(typed name); Settings › *Rotate manager link* (native confirm); Settings › *Delete event* (typed name); Album ›
*Stop sharing album* (nothing).

**Friction.** Five patterns with friction inverted against consequence (G-12). Rotation is unavailable on link-only
events and explains itself three times far below the fold (G-09b). Delete event fires a rejected request before
validating. Entry disable is irreversible; the manager afterwards still shows "Scan to join" (CODE).

**Recommendations.** One three-rung ladder; validate client-side first; disable unavailable actions with the reason
inline; reflect irreversible state in the shell.

### E6. First run

**Current steps.** `/create` → manager opens on Intake with an empty grid reading "No matching photos." Nothing points
at the QR in Share; nothing explains what happens next.

**Recommendations.** Replace the empty Intake with a first-run panel: the QR, "Print this and put it where guests will
see it", and a line about private delivery. Time-to-first-success is otherwise good — creation is one short form.

---

## F. Consistency matrix

| Dimension | Intake | Gallery › Library | Gallery › Album | Gallery › Shared | Guestbook | Settings | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Name for arriving photos | "Live intake", "private deliveries" | "Library", "photos" | "album photos" | "photos" | "photo captions" | "Photo delivery" | ✗ six names (G-29) |
| Guest-visibility vocabulary | `unpublished` chip | none shown | "guests will see" | Published/Hidden/Unpublished | Shared/Hidden | "optional shared gallery" | ✗ four vocabularies (G-30) |
| Primary vs secondary hierarchy | icon-only pair | tray verbs | Preview / Share / Download | equal-weight pair | Publish / Hide | text buttons | ✗ inverted in Shared (G-31) |
| Save model | immediate | immediate | autosave + status | immediate | immediate | autosave + status | ~ two models, both stated |
| Validation timing | — | on submit | live, field-named | — | — | live, field-named | ✓ where present |
| Success feedback | none (G-04) | live region, specific | live region + undo | none / generic (G-14) | live region | status chip (false at rest) | ✗ |
| Failure feedback | notice | notice | banner + inline + retry | notice | notice | banner | ✗ six retry vocabularies (CODE) |
| Destructive confirmation | none | n/a | none (share) | none | none | typed name / native confirm | ✗ five patterns (G-12) |
| Undo | none | none (G-15) | 9 s toast | none | none | none | ✗ |
| Icons without labels | trash, download | + / − | arrows, star, × | eye, eye-off | — | — | ✗ overloaded (G-49) |
| Back / cancel / close | — | Done selecting | Back to editing | — | — | Cancel in dialogs | ✓ within surfaces |
| Deep-linkable | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ (only `?section=rsvp`) | ✗ (G-11) |
| Guest consequence stated | ✗ | ✓ ("does not publish it") — incomplete once shared (G-01) | partial | ✓ | ✓ | ✗ for pause (G-08) | ~ |
| Counts / dates | "12 private deliveries" | "12 photos" | "4 photos in the album" | tab counts | tab counts | retention in browser locale | ✗ (G-50) |
| Desktop ↔ mobile parity | ✓ | ✓ | ✓ (stacked) | ✓ | ✓ | ✓ | ✓ — no overflow at 320 |

---

## G. Simplified target workflows

### G1. Sharing an album

**Current:** Library picks → Album → gate → title → order → Preview → **Share album** (instant live link) → warning
appears afterwards → later edits publish silently.

**Proposed:**
1. Library picks (unchanged).
2. Album opens directly in the editor — no favourites gate.
3. Title pre-filled with the event name as a *placeholder*.
4. **Preview** renders the real public page.
5. **Share album** opens a short confirm: *"This creates a link anyone can open. They will see 4 photos, their captions,
   and your album title. You can stop sharing later, but the link cannot be restored."* → **Create link**.
6. Once live, a persistent banner appears in **Library, Album and Shared**: *"This album is shared. Changes go live
   immediately."*

**Removed:** the favourites gate; the after-the-fact warning. **Added:** one confirm, one global state.
**Defaults:** title = event name; hidden photos excluded from the public projection.
**Why safer:** the host learns the consequence before the link exists, and can never edit a live album believing it is
private.

### G2. Deleting a photo

**Current:** trash icon → gone.

**Proposed:** trash icon → inline confirm naming the photo and contributor (*"Delete 'Sparkler send-off' from Priya
Raman? Guests and the album lose it immediately."*) → **Delete** → toast *"Deleted 'Sparkler send-off'. Undo"* for 30
seconds → afterwards recoverable from **Recently deleted** until the retention date.
**Why safer:** three independent chances to catch a mis-tap on the only irreversible content action in the product.

### G3. Publishing to the shared gallery

**Current:** Settings toggle in one destination; publishing in another; no confirmation; no count.

**Proposed:** move the switch into the Shared header — *"Shared gallery: **On** · 4 of 12 photos visible to guests"* —
lead each card with the action its filter implies, and announce *"Published 'Ring exchange'. Guests can see it now.
Undo."* Add **View as a guest**.

### G4. Exporting

**Current:** one job forever; no reason on failure; one "Preparing" label.

**Proposed:** **Prepare download** always available; each job listed as *"Frozen 3:14 PM · 12 photos · Ready · links
expire in 23 h"*; when the album or library has changed since, *"3 photos have arrived since this export. Prepare a new
one."*; failures name their cause with a matching action.

---

## H. Improvement roadmap

### Quick wins — days, low risk

| Change | Impact | Effort | Depends on |
| --- | --- | --- | --- |
| Guard the settings and appearance autosave queues (G-07) | Unblocks all local settings QA | XS | — |
| Confirm "Stop sharing album" and state permanence (G-10) | Prevents irreversible mis-clicks | XS | — |
| Announce single publish/hide with guest consequence + undo (G-14) | Removes the biggest feedback gap | S | — |
| Fix the empty-intake and album-title defaults (G-24, G-33) | First-run clarity | XS | — |
| Collapse degenerate time ranges, unify date formatting (G-36, G-50) | Polish | XS | — |
| Disable "Download all" at zero photos (G-34) | Prevents empty exports | XS | — |
| Trap focus in Cover Studio (G-18) | Accessibility | S | — |
| Pre-fetch style previews (G-23) | Removes a blind choice | S | — |
| Restore focus and announce album reorders (G-21) | Accessibility | S | — |

### Medium — one to three weeks

| Change | Impact | Effort | Depends on |
| --- | --- | --- | --- |
| Exclude hidden photos from the public album; publish-changes model (G-01, G-02) | Closes the privacy gap | M | Live-share state |
| Global "this album is shared" state (G-01) | Makes the consequence continuously visible | M | — |
| Confirmation + undo + Recently deleted for photos (G-04) | Ends the only unrecoverable content action | M | Undo controller |
| Always allow a new export; re-snapshot on retry; surface `EXPORT_*` (G-05, G-41) | Restores the core delivery promise | M | — |
| Project the guest gallery payload (G-06) | Closes metadata exposure | S | Contract change |
| Destination and mode in the URL (G-11) | Reload, Back, bookmarks | M | — |
| One destructive-confirmation ladder (G-12) | Learnable safety | M | Shared component |
| Rename and re-scope "Pause photo delivery"; gate `/fullscreen` (G-08) | Removes a hidden guest outage | S | — |
| Publication chip on Library cards; Shared gets the Library tray (G-47, G-48) | Publishing at real scale | M | — |
| Registration copy and pending sign-in route (G-09) | Recovers stranded hosts | S | — |

### Larger — structural

| Change | Impact | Effort | Depends on |
| --- | --- | --- | --- |
| One photo card with one action set across Intake / Library / Shared (G-31, G-48) | Removes four competing designs | L | Vocabulary decision |
| A terminology source of truth applied everywhere (G-29, G-30, G-49) | Makes the product learnable | L | Design-system update |
| Host photo intake (G-19) | Hosts can contribute | L | Upload pipeline reuse |
| Real "View as a guest" for gallery and album (G-22) | Ends guessing about guest impact | L | Shared renderer |
| Panel-level resilience on manager load (G-44) | One failure stops blanking the manager | M | — |
| Extend axe to every host destination (G-46) | Prevents regressions | M | — |

---

## I. Regression checklist

**Privacy and sharing**
1. With a live album share, picking a photo in Library warns the host before it reaches link holders.
2. A hidden photo is not returned by the public album projection.
3. Stopping a share requires confirmation and states that the link cannot be restored.
4. A revoked album link returns `ALBUM_SHARE_UNAVAILABLE` and the recipient copy names the remedy.
5. `GET /api/event/:slug/gallery` contains no session id, object key, idempotency key or favourite marker.
6. Album-share state is visible from Library, Album and Shared — not only from Album.

**Destructive actions**
7. Every destructive action maps to one of three rungs, and friction increases with consequence.
8. Deleting a photo is confirmed, undoable for 30 s, and listed in Recently deleted until purge.
9. No destructive request is sent before its client-side gate passes.
10. Actions that are unavailable are disabled with the reason inline, not offered and then refused.

**Feedback and state**
11. A "Saved" indicator only appears after a confirmed write, never at rest.
12. Every write announces what changed and its guest consequence.
13. Failures show one human message and one retry; no raw `Failed to fetch`.
14. Exports name their snapshot time and their failure reason.
15. Long-running operations show progress from any destination.

**Navigation**
16. Destination and gallery mode survive reload and are reachable by URL.
17. Back moves between destinations before leaving the manager.
18. A filter set in one destination does not silently apply in another.

**Accessibility**
19. Every modal traps focus, sets `aria-modal`, and returns focus on close.
20. Reordering announces the move and keeps focus on the pressed control.
21. Undo offers are reachable within one Tab and announced.
22. Icon-only controls have accessible names, and visible text is contained in the accessible name.
23. axe passes on Intake, Library, Album, Shared, selection mode, Guestbook, Share and Settings.

**Responsive**
24. No horizontal overflow at 390×844 or 320×844 on any destination.
25. At 390×844, at least one photo is visible in the first viewport of Library and Album.
26. Every host control is reachable by touch, including reordering.

**Lifecycle**
27. Pausing guest access states which surfaces stop, and every guest route obeys it identically.
28. An unconfirmed registration routes the host back to confirmation rather than a credentials error.
29. A new export can always be prepared and contains photos that arrived since the last one.

---

## J. Limitations and open questions

**Tested under a substitution.** React StrictMode was temporarily removed to isolate G-07 and then to exercise settings,
appearance and Cover Studio at all — under StrictMode those writes never reach the Worker in a dev build. `src/main.tsx`
has been restored to its committed state. Everything else was tested with the repository as committed.

**Environment.** A local Worker with miniflare D1/R2 and the emulated `IMAGES` binding. Cover style previews and image
transforms may behave differently against real Cloudflare Images; "Preview not ready" (G-23) was confirmed as a designed
state in source, but its frequency in production is unverified.

**Two local-config changes were required to run the app at all.** `.dev.vars` was missing `ALBUM_SHARE_HMAC_KEY` and
`ALBUM_SHARE_ENCRYPTION_KEY` — without them album sharing cannot start. Test values were appended locally (the file is
gitignored); `.dev.vars.example` already lists both.

**Not tested**
- Export expiry, retry after failure, and multi-part downloads at the 2 GiB partition boundary — these need a 24-hour
  wait or an induced failure.
- Real scale: 1,000+ photos, a 500-entry album, a 100 GiB event. G-47 and the pagination findings are reasoned from
  constants and code, not observed.
- The `ExportWorkflow`, `CoverRenderWorkflow` and scheduled cleanup paths.
- RSVP beyond its entry points; it was out of scope for a gallery review.
- Manager link rotation on an event that *does* have an owner — the only path where the discarded-link defect in G-09b
  is reachable. Rotation on a link-only event is refused with 409 before reaching it.
- Screen-reader verification with an actual screen reader; accessibility findings come from accessibility-tree
  snapshots, focus traces and source.

**Open questions for the team**
1. Is it intentional that a hidden photo remains on a live album link? If so, "Hide" needs to say what it does not do.
2. Should album captions be moderated like guestbook notes, or is publishing them with the photo deliberate?
3. Is the one-export-per-event model deliberate, or an unintended consequence of rendering the prepare control only when
   no job exists?
4. Should `?section=` support every destination, or is `rsvp` special?
5. Is the favourites reconciliation gate still needed, or can it be limited to events that predate the album feature?
6. What is the intended recovery for a link-only host who believes their management link has leaked, given rotation is
   refused until the event is saved to an account?
