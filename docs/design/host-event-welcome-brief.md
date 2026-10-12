# Host event welcome and guided tour — shape brief

Status: Original direction approved on 2026-10-08. The 2026-10-11 remediation is committed locally as `c55ac5e`, followed by test typing correction `31d87aa`. The current review follow-up adds the single-event sign-in shortcut and corrects direct-workspace test coverage and reader-evidence wording. See [the remediation checklist](../superpowers/plans/2026-10-11-onboarding-remediation-checklist.md) for focused evidence and remaining verification gaps. No production release is claimed by this brief.

Historical release checkpoint (original implementation `39f16cc`): Migration `0027_host_tours.sql` is applied in preview and production. Production application deployment has not been verified.

## Job and audience

When a host enters an event, they need to recognize it, understand its current phase, and see one recommended next task. First-time hosts need a short introduction that hands off to their current task; a separate tools tour is optional. Returning hosts need direct access to their work. The visitor mode is **Operate**.

Add a persistent **Overview** destination inside the existing Manager. Its composition is **Choose your next task**: an explained workflow launcher led by current phase and one recommended action. First-time guidance is a one-screen anchored modal introduction, with a separate six-step tools tour.

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
4. Confirmed review/export information when useful. **Show me how to collect photos** sits beside the recommended task; **Tour event tools** sits beside the workflow heading.

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

Events chosen from **Your events** open explicit Overview. Creation now also enters `?section=overview` through **Continue to your event** and the account-registration return. Overview remains a labelled Manager destination.

After sign-in or a completed password reset without an explicit return destination, a matching authenticated account with exactly one saved event opens that event's Overview. A one-use navigation intent lets **Your events** confirm the account and event list through its existing session lookup. Zero-event and multiple-event accounts remain on **Your events**. A failed lookup retains the dashboard's error and retry path; an account mismatch cannot select an event for the previous account. Explicit validated return destinations, including **Your events**, take precedence, and event adoption still completes before returning to an event.

Opening **Your events** directly keeps the account dashboard available for event selection, preferences and sign-out, including single-event accounts. A response that arrives after the host navigates away must not redirect them. The sign-in shortcut does not change tour eligibility, dismissal or completion.

Preserve bare Manager URLs as Gallery → Library and preserve explicit workspace, login-return, recovery, management-link, and PWA launch destinations. A direct link to active work must not become a forced welcome detour. Creation was outside the original October 8 scope; the approved October 11 remediation adds these two explicit entry paths.

Keep the existing RSVP, Gallery, Guestbook, Share, and Settings tools and their responsibilities. Gallery retains Library, Album, and Guest gallery. Every welcome action and tour transition uses existing guarded navigation.

The tour explains real controls. Next never changes settings, submits a guest list, uploads photos, publishes a gallery, or starts an export.

## Guided tour

An unseen signed-in account receives the short **Introduction** after event identity, lifecycle and account eligibility are confirmed. It explains private, account-free photo delivery, the confirmed phase/reason, and one exact task. **Go to Share / RSVP / Library / Exports / Settings** uses the same guarded recommendation dispatcher as Overview. Completion waits for the intended destination and useful focus; it never activates the highlighted control.

**Tour event tools** explicitly starts six steps, with **Back**, **Next**, **Skip tour**, **Close tour**, and **Finish**. Closing or pressing Escape exits either mode. Manual replay starts again; reload closes guidance at the committed workspace and does not promise resume. Optional details live beside RSVP, Share, Library modes and Exports controls.

Tools sequence:

| Step | Destination and anchor | What the host learns |
| --- | --- | --- |
| 1. Your next task | Overview's phase and recommended-action region | What is happening now and where to go next. |
| 2. Your guest list | RSVP's real Add guests control, with neutral wording for existing/unknown rosters | Named invitations and household attendance live here; RSVP is optional. |
| 3. One QR for your event | Share's actual guest-link/QR region, or compact link controls with a truthful close-to-inspect-QR note | The same QR goes on invitations and venue signs; its guest task changes with the event. |
| 4. Your delivered photos | Gallery's Library region and mode switch | Originals arrive in Library; Album and Guest gallery are distinct, optional sharing choices. |
| 5. Keep your originals | Library's Exports control | Retrieve originals through exports; preparation does not prove download. |
| 6. Event details and access | Settings' Guest uploads status/actions; disabled access uses status | Adjust details and availability here; the tour itself edits nothing. |

Tools **Finish** returns to Overview and focuses its recommended action. Back visits the previous step through guarded navigation rather than issuing an unqualified browser Back.

On desktop, dialogs point to visible controls. On phones, use a reachable anchored panel or bottom sheet when a floating bubble would obscure its target or leave the viewport. Placement follows actual target bounds, scrolling, and text enlargement. Never anchor to a hidden mobile navigation item.

Persist first-visit status per signed-in host account and tour version, rather than per event or inferred from setup activity. Completion and dismissal suppress automatic replay across devices. Exiting is not event setup completion. Existing accounts with no record are eligible for the new tour. Link-only hosts can replay it manually without registering. The original proposal had no tour record; migration `0027_host_tours.sql` subsequently added account-level state. Both current modes reuse `host-event-welcome`, version `1`, with terminal completion precedence, confirmed/pending saves, retry and identity isolation. This remediation adds no migration or version bump.

## States, interaction, and accessibility

Only event identity gates the Manager shell. Counts, entry data, phase, and exports retain independent loading/error/retry states. Start the automatic tour after authorization, first-visit status, and the opening target are confirmed. A failed first-visit lookup must not reopen the tour repeatedly.

Each step waits for the committed destination, settled scroll, and a visible anchor. Prevent repeated Next activation while transitioning. An unavailable target keeps an understandable explanation and retry/exit path, rather than an arrow pointing at empty coordinates.

Recovery messages update a persistent polite, atomic status region without moving focus. Both the region and its message paragraph exist before recovery text arrives; the empty paragraph stays visually hidden. This preserves spontaneous announcements when a target disappears or a preference save fails, with one live owner inside the active guide.

The existing modal surface makes Manager inert. Highlighted controls are explanatory targets, not interactive holes in the focus trap. Focus each new step, label the dialog, retain keyboard operation, and restore focus on exit. The dialog describes the full phase/task body; its focused heading describes only Introduction or Step N of 6 to avoid repeating long instructions in native readers. Keep 44px minimum targets, standard 48px controls, existing focus treatments, and reduced-motion behavior.

Only one modal owns the screen. Suspend the tour before an existing save, upload, viewer, or confirmation dialog takes focus. If navigation is refused, retain the current step. Preserve autosave, guest-list drafts, Album leave preparation, uploads, rotated-link warnings, Gallery anchors, and browser history.

Support empty/populated events, optional RSVP, long names, localized dates, summary failures, counts through existing limits, and enlarged text at 320px. Keep the first task in the opening phone viewport. Desktop retains the labelled rail and open canvas; phones keep the same reading order in one column. Host chrome stays on the global palette.

## Data and implementation constraints

Historically, `HostEventsPage` linked to bare Manager. Its event links now select Overview explicitly; `src/app/manager-location.ts` still resolves bare Manager to Gallery → Library. `src/pages/ManagerPage.tsx` owns resources and guarded destinations; `src/features/manager/ManagerNavigation.tsx` owns the responsive shell.

Manager uses the host-safe server phase projection using the existing resolver in `shared/rsvp.ts`, server access-window rules, and a relative lifecycle refresh delay. Preserve legacy-event behavior. Do not reconstruct phase from the browser clock or a bearer guest route.

There is no event end time or defined Manager “event finished” phase. Do not invent one. Distinguish the existing RSVP / before-start / photos / waiting semantics from guest-access expiry. A later post-event phase needs an agreed rule.

Use the existing RSVP summary endpoint without mounting its editor and full roster. Retain the existing explicit account tour first-visit/dismissal/completion state. `src/components/ModalSurface.tsx` supplies modal semantics and focus containment; anchored positioning, step-specific focus and coordinated guarded navigation are implemented. Actual platform evidence and limitations are recorded in the remediation checklist. The [reader verification guide](host-welcome-accessibility-verification.md) separates observed speech and focus behavior from remaining platform and human-listening checks.

The approved remediation preserves mounted Settings drafts and normal autosave. Valid drafts can save during navigation; invalid/failed drafts retain the existing Router refusal, including the exercised internal Overview and external Home intents, until the host chooses how to proceed. The guide does not introduce a separate saving policy. No automatic sharing, mutation, invitation sending or export preparation is part of either guide mode.
