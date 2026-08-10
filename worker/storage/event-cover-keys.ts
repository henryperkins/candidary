import type {
  EventCoverDensity,
  EventCoverEffectId,
  EventCoverFormat,
  EventCoverProfileId,
} from '../../shared/event-cover';

/**
 * The only place a cover R2 key or preset asset path is constructed.
 *
 * Every key is deterministic beneath an opaque server-generated identifier, and
 * every one lives under the event's own prefix — which is what lets the existing
 * `events/{eventId}/` purge remove all four shapes without knowing about covers
 * at all. Route handlers never build these; they pass identifiers and get keys.
 *
 * A key is never accepted back from a client. Ownership is always resolved from
 * the event-scoped draft, master, or render-set ID.
 */

function coverPrefix(eventId: string): string {
  return `events/${eventId}/cover`;
}

export function coverRawKey(eventId: string, draftId: string): string {
  return `${coverPrefix(eventId)}/raw/${draftId}`;
}

export function coverMasterKey(eventId: string, masterId: string): string {
  return `${coverPrefix(eventId)}/masters/${masterId}.webp`;
}

export function coverPreviewKey(
  eventId: string,
  draftId: string,
  effect: EventCoverEffectId,
  recipeVersion: number,
): string {
  return `${coverPrefix(eventId)}/previews/${draftId}/${effect}-${recipeVersion}.webp`;
}

export function coverRenderKey(
  eventId: string,
  renderSetId: string,
  profile: EventCoverProfileId,
  density: EventCoverDensity,
  format: EventCoverFormat,
): string {
  return `${coverPrefix(eventId)}/rendered/${renderSetId}/${profile}-${density}.${format}`;
}

/**
 * Whether a stored key really is one of this event's cover objects.
 *
 * Used before deleting or streaming anything read back out of inventory: a row
 * is trusted, but a key that does not sit under this event's cover prefix means
 * the row and the object have diverged, and neither is safe to act on.
 */
export function isEventCoverKey(eventId: string, key: string): boolean {
  return key.startsWith(`${coverPrefix(eventId)}/`) && !key.includes('..');
}

/**
 * A lowercase SHA-256 of an object key.
 *
 * Stored beside a retired legacy original and pinned into a backfill job, so a
 * recovery audit can match a row to a key it already has — and so a job can
 * prove the original it was created against is still the current one — without
 * either needing to compare full keys. Recomputable by anyone holding the key,
 * which a hand-rolled hash would not be.
 */
export async function coverKeyFingerprint(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
