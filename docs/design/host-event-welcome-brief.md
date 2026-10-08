# Host event welcome and guided tour — shape brief

Status: Approved by the user on 2026-10-08. Composition, primary outcome, automatic first-visit launch, tour coverage, account-level replay behavior, and entry boundary are confirmed. Implemented and verified locally on feat/host-event-welcome while preserving the existing design system. See the implementation plan for focused evidence and limitations; no production release is claimed.

## Job and audience

After signing in and choosing an event, a host needs to recognize the event, understand its current phase, and see one recommended next task. First-time hosts also need a guided explanation of the tools. Returning hosts need direct access to their work. The visitor mode is **Operate**.

Add a persistent **Overview** destination inside the existing Manager. Its composition is **Choose your next task**: an explained workflow launcher led by current phase and one recommended action. First-time guidance is an anchored modal tour.

## Outcome and proof

The opening phone viewport shows the event name, its server-confirmed phase, and a useful action with a short reason. Below it, explained workflows connect preparing invitations and RSVPs, sharing the permanent QR, collecting photos, optional sharing, and retrieving originals.

The product-specific truth remains visible: the same printed QR serves RSVP and photo delivery; originals reach the host privately; RSVP is optional for photo delivery; Album and Guest gallery sharing are separate choices. Do not imply that Candidary sends invitations.

Recommendations use confirmed states and counts. Unknown summaries never become zero or imply unfinished setup. No existing field proves invitations sent, QR printed, previews checked, or originals downloaded; do not describe those actions as complete.

## Selected direction

Keep the current `DESIGN.md` identity: warm paper, Manrope/DM Sans, Chestnut actions, Denim selection, Moss completion, and labelled Manager navigation. The selected composition changes entry hierarchy, not the design system.

Reading order:

1. Existing Manager header and event identity, including the zoned event date.
2. Current phase and one recommended action, with a short explanation.
3. Explained workflow choices using familiar labels and existing destinations.
4. Confirmed review/export information when useful, plus **Take a tour** for replay.

The action policy follows server-confirmed state:

| State | Recommended task |
| --- | --- |
| RSVP phase with no named guests | Add guests in RSVP. |
| RSVP phase with a guest list | Review RSVPs, with confirmed response information when available. |
| Before the event starts | Prepare the invitation or venue QR through Share. |
| Photo delivery open, no delivered photos | Get the QR ready for guests through Share. |
| Photo delivery open, photos available | Open Library to view delivered originals. |
| Photo delivery paused | Review delivery settings without treating an intentional pause as a failure. |
| Guest access ended, management remains available | Retrieve originals; use the server's access-window rules rather than inventing an event end time. |

Original retrieval stays available regardless of Album or Guest gallery publication. A ready export may have a direct download action; it is not proof that the host has downloaded it.

## Scope and boundaries

The requested entry is an event chosen from **Your events**. Make that link open an explicit Overview location, and add Overview to Manager navigation.

Preserve bare Manager URLs as Gallery → Library and preserve explicit workspace, login-return, recovery, management-link, and PWA launch destinations. A direct link to active work must not become a forced welcome detour. Creation's existing manager entry remains outside this first pass.

Keep the existing RSVP, Gallery, Guestbook, Share, and Settings tools and their responsibilities. Gallery retains Library, Album, and Guest gallery. Every welcome action and tour transition uses existing guarded navigation.

The tour explains real controls. Next never changes settings, submits a guest list, uploads photos, publishes a gallery, or starts an export.

## Guided tour

Start automatically on the signed-in host's first Overview visit. Provide **Back**, **Next**, **Skip tour**, and **Finish**, with a visible step count. Closing or pressing Escape exits. **Take a tour** remains available for replay.

Proposed sequence:

| Step | Destination and anchor | What the host learns |
| --- | --- | --- |
| 1. Your next task | Overview's phase and recommended-action region | What is happening now and where to go next. |
| 2. Your guest list | RSVP's visible heading or available Add guests control | Named invitations and household attendance live here; RSVP is optional. |
| 3. One QR for your event | Share's guest QR / print-pack region | The same QR goes on invitations and venue signs; its guest task changes with the event. |
| 4. Your delivered photos | Gallery's Library region and mode switch | Originals arrive in Library; Album and Guest gallery are distinct, optional sharing choices. |
| 5. Keep your originals | Library's Exports control | Retrieve originals through exports; preparation does not prove download. |
| 6. Event details and access | Settings' visible details / delivery region | Adjust details and availability here; the tour itself edits nothing. |

Finish returns to Overview and focuses its recommended action. Back visits the previous step through guarded navigation rather than issuing an unqualified browser Back.

On desktop, dialogs point to visible controls. On phones, use a reachable anchored panel or bottom sheet when a floating bubble would obscure its target or leave the viewport. Placement follows actual target bounds, scrolling, and text enlargement. Never anchor to a hidden mobile navigation item.

Persist first-visit status per signed-in host account and tour version, rather than per event or inferred from setup activity. Completion and dismissal suppress automatic replay across devices. Exiting is not event setup completion. Existing accounts with no record are eligible for the new tour. Link-only hosts can replay it manually without registering. The current application has no tour record; this requires an explicit addition.

## States, interaction, and accessibility

Only event identity gates the Manager shell. Counts, entry data, phase, and exports retain independent loading/error/retry states. Start the automatic tour after authorization, first-visit status, and the opening target are confirmed. A failed first-visit lookup must not reopen the tour repeatedly.

Each step waits for the committed destination, settled scroll, and a visible anchor. Prevent repeated Next activation while transitioning. An unavailable target keeps an understandable explanation and retry/exit path, rather than an arrow pointing at empty coordinates.

The existing modal surface makes Manager inert. Highlighted controls are explanatory targets, not interactive holes in the focus trap. Focus each new step, label the dialog, retain keyboard operation, and restore focus on exit. Keep 44px minimum targets, standard 48px controls, existing focus treatments, and reduced-motion behavior.

Only one modal owns the screen. Suspend the tour before an existing save, upload, viewer, or confirmation dialog takes focus. If navigation is refused, retain the current step. Preserve autosave, guest-list drafts, Album leave preparation, uploads, rotated-link warnings, Gallery anchors, and browser history.

Support empty/populated events, optional RSVP, long names, localized dates, summary failures, counts through existing limits, and enlarged text at 320px. Keep the first task in the opening phone viewport. Desktop retains the labelled rail and open canvas; phones keep the same reading order in one column. Host chrome stays on the global palette.

## Data and implementation constraints

`src/pages/HostEventsPage.tsx` currently links to the bare Manager path; `src/app/manager-location.ts` resolves it to Gallery → Library. Add an explicit Overview location without changing that meaning. `src/pages/ManagerPage.tsx` owns resources and guarded destinations; `src/features/manager/ManagerNavigation.tsx` owns the responsive shell.

Manager exposes photo-delivery state but not the complete guest phase. Add a host-safe server phase projection using the existing resolver in `shared/rsvp.ts`, server access-window rules, and a relative lifecycle refresh delay. Preserve legacy-event behavior. Do not reconstruct phase from the browser clock or a bearer guest route.

There is no event end time or defined Manager “event finished” phase. Do not invent one. Distinguish the existing RSVP / before-start / photos / waiting semantics from guest-access expiry. A later post-event phase needs an agreed rule.

Use the existing RSVP summary endpoint without mounting its editor and full roster. Add explicit tour first-visit/dismissal/completion state. `src/components/ModalSurface.tsx` supplies modal semantics and focus containment; anchored positioning, step-specific focus, and coordination with guarded navigation are new requirements.

Confirm the assembled hierarchy, six-step tour, account-level replay behavior, and entry boundary before writing an implementation plan.
