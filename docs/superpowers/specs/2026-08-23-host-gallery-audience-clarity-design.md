# Host Gallery Audience Clarity Design

**Program:** [Host Gallery Roadmap](2026-08-23-host-gallery-roadmap-program-design.md)

**Slice:** 2 of 6

**Findings:** C-01, C-02, C-18, C-20, C-24, C-28, C-29, C-30, C-31, C-39, C-40, C-48, C-51, C-60, C-65, C-66

## Goal

Make delivered photos, Album membership, Guest-gallery publication, and Album-link availability predictable at every action point without merging those independent concepts or adding another publishing workflow.

## Existing systems retained

- `ManagerGalleryWorkspace` remains the owner of Library, Album, and the third Gallery mode.
- `ManagerPrivateGallery`, `ManagerAlbum`, and `ManagerSharedGallery` retain their existing responsibilities.
- `selection-state.ts`, `SelectionTray`, and the 50-action cap remain the one selection model.
- `PublicAlbum` becomes the shared Preview/live renderer; no second recipient mockup is built.
- Settings remains the only Guest-gallery availability editor.

## Canonical language

Host-facing copy uses:

- **Delivered photos** for the retained collection;
- **original** only for source download or deletion;
- **Pick / In Album / Remove from Album** for Album membership;
- **Guest gallery · Published / Unpublished / Hidden** for event-guest publication;
- **Album link · Off / Live** for link availability;
- **event guests** and **people with the Album link** for the two audiences;
- **Prepare / Prepared date / Retry this prepared export** for export snapshots.

The Gallery mode formerly labelled Shared becomes **Guest gallery**. Compatibility field names such as `isFavorite` remain below the UI boundary.

## Persistent Gallery summary

Add a lightweight Manager projection:

```ts
interface GalleryAudienceSummaryView {
  albumPhotoCount: number;
  albumEntryCount: number;
  albumLink: { active: boolean; sharedAt: string | null };
  guestGalleryVisible: boolean;
  guestGalleryPublishedCount: number;
}
```

`GET /api/manage/events/:eventId/gallery/summary` returns `200 { data: { summary: GalleryAudienceSummaryView }, requestId }` and never the Album credential. `albumPhotoCount` is the active visible Album-photo count used in audience copy; `albumEntryCount` is the authoritative capacity count, including sections and retained trashed photo entries hidden until restoration. `ManagerGalleryWorkspace` loads it through its own Slice 1 resource controller, replacing duplicate local count derivations, and invalidates that owner after picks, section/entry changes, share lifecycle changes, publication changes, trash/restoration, and settings reconciliation.

The route uses `requireManager`, a strict `{ summary: GalleryAudienceSummaryView }` envelope, `Cache-Control: private, no-store`, and the existing Manager authentication/lifecycle errors. Its Album-link subquery selects only `active` and `sharedAt`; it does not call the credential-bearing share-status mapper. A Gallery-summary generation belongs to one `eventId`, and a failure uses the resource-scoped panel seam from Slice 1 without clearing the event, media, exports, or any prior trusted summary.

One compact line beneath the existing mode switch reads, for example:

> Album: 12 photos · Link: Live · Guest gallery: On, 8 published

It is text, not a promotional badge row, and respects the design system's above-fold constraints.

## Action-point consequences

When the Album link is live, Library and Album show:

> Album link live—membership and Album edits affect the link.

Library's pick explanation states both preserved axes: picking affects Album membership and a live Album link; it does not publish to the Guest gallery. Guest gallery states the inverse: Publish/Hide affects event guests and does not change Album membership or its link.

Hide remains Guest-gallery-only. No control claims that Hide withdraws the photo from people holding the Album link. The deferred cross-audience withdrawal action is not approximated through hidden coupling.

## Library and selection

Library cards add one compact Guest-gallery state label while keeping Pick as the primary control. Remove the duplicate picked label so each card has one Album-membership state.

Selection copy derives from the existing shared constant:

- `Select all 48 loaded photos`
- `12 of 50 selected`
- the same capacity explanation in Library and Guest gallery.

Selection changes continue through the pure helpers in `selection-state.ts`. The remove action keeps the already-remediated Minus icon and literal accessible label.

## Guest-gallery interaction

The mode header distinguishes saved publication choice from present availability:

- when on: `Published photos are visible to event guests.`
- when off: `Publication choices are saved, but the Guest gallery is off.`

Its existing Settings action does not duplicate the toggle; Slice 4 adds the exact mode/filter/focus return intent at the Router boundary.

Action hierarchy follows filter context:

- Unpublished leads with Publish;
- Published leads with Hide;
- Hidden leads with Publish;
- the alternate action is visually secondary rather than equal weight.

Single and bulk success messages name the item/count, resulting state, and audience. Filter changes that clear selection announce the reset. Guestbook calls published captions `Not currently visible to event guests` when Gallery availability suppresses them, rather than misfiling them as Hidden.

## Album Preview, sections, and sharing

Preview calls the Manager public-projection endpoint from Slice 1 and renders `PublicAlbum` with the Manager-authenticated `imageSource`. `PublicAlbum` has one content tree and a required semantic variant: the public page uses `page` (`main`, title `h1`, section headings `h2`), while Manager Preview uses `embedded` (`section`, title `h3`, Album section headings `h4`) beneath the retained Manager Gallery `h2`. Therefore the cover, title, description, count, ordering, captions, empty-state, fallbacks, and omission of contributor names match the live link by construction without nesting main landmarks or skipping heading depth.

Empty sections remain visible and flagged in the editor but are omitted from the public projection. A new section inserts next to the current editing context instead of always appending.

Sharing confirmation states the current photo count, published-caption count, audience, and live request-time behavior. “Published caption” is defined there as a caption on a photo whose Guest-gallery publication state is `published`; it is not Guestbook-note moderation. It follows the existing modal contract: initial focus is **Cancel**, Escape/backdrop/Cancel send no request and restore the invoking control, and **Create Album link** is an explicit nondefault action. Success focuses the sensitive link card's Copy action.

Extend `CopyableLinkCard` with `sensitive?: boolean` rather than introducing another credential component. While hidden, the complete value is absent from DOM text, attributes, accessible names, and focusable descendants; a fixed-length mask independent of secret length appears beside **Reveal** and **Copy** with complete accessible names. Copy reads the prop value without revealing it. Reveal mounts a read-only text field. If Clipboard is absent or rejects, reveal first, then after commit focus the field, select `[0, value.length]`, and announce the fallback. A changed value remasks automatically and clears copy/fallback state, so a revoked credential cannot remain rendered. Non-sensitive uses retain their current presentation. Album's custom code display is replaced by this card. Both the initial management link on event creation and every rotated replacement Manager link use sensitive mode; ordinary event links remain non-sensitive.

## Publication feedback

Publish and Hide stay immediate reversible actions without confirmation. The existing Gallery notice/live-region path reports:

- named single-photo transitions;
- exact bulk counts;
- Guest-gallery on/off consequence;
- recovery through the opposite action.

No new toast or notification framework is introduced.

## Verification

- Exact terminology assertions in existing Gallery, Guestbook, export, and Album UI tests
- Summary exact-key/auth/no-store tests, distinct active-photo versus capacity-entry counts, and freshness after pick/unpick, section/entry changes, share start/stop, publish/hide, trash/restore, and availability changes
- Live-link copy at single-pick, bulk-pick, remove, metadata, and order boundaries
- Guest-gallery-off and on projections and announcements
- Preview/live `PublicAlbumView` deep equality across caption states, Guest-gallery availability, empty sections, and zero photos; never-shared/revoked Preview works, with no exchange/status call, `Set-Cookie`, or credential field; heading levels are h1/h2 for page and retained Gallery h2 plus h3/h4 for embedded
- Share-creation consequence, Cancel-first focus, Escape/backdrop/no-request, return-focus, and success-focus tests
- Empty-section omission and contextual insertion tests
- Selection loaded/cap copy at 0, 1, 49, and 50 selections
- Sensitive-card DOM/attribute/accessibility tests proving the hidden URL is absent and mask length fixed, plus Reveal, hidden Copy, rejection fallback focus/selection, value-change remasking, and accessible-name tests
- Regressions for the post-review Minus icon/public-safe labels plus the newly implemented masking and duplicate-state removal

## Non-goals

- Changing Hide to remove Album membership
- A staged or frozen Album publish step
- A duplicated Guest-gallery setting
- Contributor names or original filenames in the public Album
- A new notification/toast system
