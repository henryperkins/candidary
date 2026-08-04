/**
 * The payload one cover publication's Workflow instance carries.
 *
 * Deliberately two opaque identifiers and nothing else. Every other input —
 * the frozen draft, the pinned master, the recipe, the derived manifest, the
 * staging set — is rehydrated from the durable receipt in preflight, so a
 * replayed step can never act on a stale copy of state that D1 has since moved,
 * and no recipe detail is ever carried in platform-retained instance data.
 */
export interface CoverRenderPayload {
  eventId: string;
  operationId: string;
}
