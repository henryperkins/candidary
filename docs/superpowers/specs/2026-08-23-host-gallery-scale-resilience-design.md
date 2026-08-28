# Host Gallery Scale and Resilience Design

**Program:** [Host Gallery Roadmap](2026-08-23-host-gallery-roadmap-program-design.md)

**Slice:** 6 of 6

**Findings:** C-34, C-38, C-62

## Goal

Keep large-event browsing and publication bounded, atomic, position-stable, and usable when an unrelated Manager read fails.

## Existing systems retained

- The 48-row Library page and 50-action selection cap remain.
- `selection-state.ts`, `SelectionTray`, Gallery cursors, and existing media repositories remain.
- Manager's current event/media/export/entry/Guestbook reads remain the data sources.
- Existing panel error and retry components remain.
- No all-event client-side cache, infinite selection promise, or new state library is added.

## Filter ownership

Extend the destination-scoped media resources established in Slice 1; do not move or duplicate their ownership here. Intake contributor/status/Recently-deleted state remains in Intake, Library search/order remains in Library, and Guest gallery owns its publication filter. This slice adds bounded paging/reconciliation to those owners. Moving between destinations cannot silently reuse another destination's query.

If a transition intentionally resets a destination-local selection or filter, the existing visible notice/live region names the reset. Returning through Router intent restores only the originating Guest-gallery filter documented by that intent.

## One bounded selection model

Guest gallery adopts the same page size, pure selection transitions, visible `N of 50`, and `Select all N loaded photos` vocabulary as Library. It never promises to select unloaded or all-event results.

When a host reaches 50 selections:

- unchecked row controls are disabled with the shared capacity explanation;
- checked rows remain removable;
- row publication actions that would conflict with the selected batch are disabled while the batch is running;
- pagination and the current filter remain visible.

This supports events with thousands of photos without sending an unbounded mutation.

## Atomic publication API

Replace the client's sequential grouping loop with one strict request:

```ts
interface BulkPublicationRequest {
  action: 'publish' | 'hide';
  items: Array<{
    id: string;
    expectedStatus: 'unpublished' | 'published' | 'hidden';
  }>;
}
```

The exact HTTP contract remains `POST /api/manage/events/:eventId/media/bulk` with the normal `{ data: { changed: ManagerMediaView[] }, requestId }` response. `changed` contains every requested row in request order, including an allowed no-op whose `expectedStatus` already equals the action's target. `publish` accepts expected unpublished/published/hidden; `hide` accepts the same three states. Duplicate IDs, more than 50 items, missing fields, or unknown keys return existing `VALIDATION_FAILED` 422.

The array contains 1–50 unique IDs. `MediaRepository.setPublicationBulkExpected()` binds the validated item array once as JSON and performs one CTE-backed `UPDATE ... RETURNING` statement. A requested-items CTE feeds an eligible-row CTE; the update predicate includes a global eligible-count-equals-request-count guard, so SQLite either matches every item in that statement snapshot or matches none. It:

- restricts every row to the authorized event, stored and untrashed state;
- matches each row's supplied expected status;
- applies the single target state and timestamp, while an allowed already-at-target item preserves its existing timestamps;
- succeeds only when all unique requested rows match.

The statement returns every matched row, including valid no-ops. A returned count other than the validated request count means conflict and, because the global guard matched no rows, no write occurred. Any missing, cross-event, changed, deleted, or trashed row therefore produces `MEDIA_STATE_CONFLICT` 409 without identifying the conflicting ID. The repository maps returned rows by ID and then through the validated input array to guarantee response order; it never performs a post-update fetch that could race. The current `{ ids, action, expectedStatus }` payload remains accepted for one compatibility release, is translated to itemized inputs before the repository call, and receives the same all-or-nothing response; new UI always sends the itemized shape and never uses the sequential loop. A contract test marks the legacy parser for removal after that release rather than maintaining two mutation implementations.

## Position preservation after writes

Publication changes update or remove cards in place according to the active filter. The list keeps an anchor ID and current cursor ownership:

- a row that remains in the filter updates without a refetch jump;
- a row leaving the filter is removed, and the next/previous card becomes the anchor;
- a bounded first-page reconciliation fills visible gaps without resetting document scroll;
- `Load more` continues only from a cursor belonging to the same filter generation.

When a single or bulk Publish/Hide removes the invoking/focused row under the active publication filter, the mutation establishes keyboard focus on the next surviving card, previous card, or Guest-gallery results heading in that order while using the same row as the scroll anchor. Pointer activation leaves focus on that established fallback only when its invoking control disappeared. Bulk focus resolves from the earliest removed focused/selected position, not request-response order. The success announcement follows that focus move; it never leaves focus on `body`.

A failed atomic write leaves rows, selection, position, and filter unchanged and adds the existing recoverable notice.

## Panel-level Manager loading

Reuse the resource-scoped loader introduced in Slice 1. This slice adds paging, polling, and Gallery-summary reads to the same ownership model; it does not create a late replacement for `ManagerPage.refresh()`. The event identity/lifecycle result remains critical because every panel depends on it. Media, exports, printed entry, Guestbook summary, Album/Gallery summary, and other reads may execute concurrently, but they settle and adopt independently; their usable results are discarded only when the event identity itself is unavailable.

Each resource adopts its own generation guard and local result:

- success updates only that resource;
- retryable failure renders the existing panel error and Try again inside that panel;
- credential/lifecycle escalation still reaches the Manager-level recovery surface;
- a stale completion cannot replace a newer write or filter result.

An export failure cannot erase Intake. A Guestbook-summary failure cannot erase Gallery. A media failure cannot remove Settings or Share. Background polling follows the same resource ownership.

## Scale verification

Use the existing Worker and Playwright scale fixtures to cover:

- 1,000+ stored photos with 48-row paging;
- Guest-gallery filters across multiple pages;
- 49/50/51 selection attempts;
- a mixed-state 50-row atomic write;
- allowed publish/hide no-ops and request-order response;
- one-release legacy uniform-payload translation;
- one stale expected state causing zero changes;
- concurrent single/bulk requests with one clear winner;
- preserved anchor, next/previous/results-heading focus, and cursor after single/bulk rows stay, leave, or conflict under every publication filter;
- filter change during an in-flight page read;
- independent failures for media, exports, entry, Guestbook summary, and Gallery summary.

Tests assert D1 state after conflicts and partial-read failures, not only UI messages.

## Non-goals

- Selecting every result across an unbounded event
- More than 50 mutations in one host action
- Replacing cursor pagination with a client-side event cache
- Optimistic partial success
- A new global data-fetching or state-management library
