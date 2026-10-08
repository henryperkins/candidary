import type { HostEventLifecycleView } from '../../shared/contracts';
import { isRsvpConfigured, resolveGuestEventPhase, resolvePhotoIntake } from '../../shared/rsvp';
import type { EventRecord } from '../db/types';

/** Entry disable state belongs to the entry record, rather than the event row. */
export function selectHostEventLifecycle(
  event: EventRecord,
  now = new Date(),
  entryDisabledAt: string | null = null,
): HostEventLifecycleView {
  const entryDisabled = entryDisabledAt !== null;
  const phase = resolveGuestEventPhase({
    ...event, entryDisabled, rsvpConfigured: isRsvpConfigured(event),
  }, now);
  const intake = resolvePhotoIntake(event, now);
  const nowMs = now.getTime();
  const delays = [
    phase.lifecycleRecheckAfterMs,
    intake.photoIntakeRecheckAfterMs,
    Date.parse(event.guestAccessExpiresAt) - nowMs,
    Date.parse(event.managementAccessExpiresAt) - nowMs,
  ].filter((delay): delay is number => delay !== null && Number.isFinite(delay) && delay > 0);
  return {
    phase: phase.phase,
    rsvpState: phase.rsvpState,
    photoIntakeState: intake.photoIntakeState,
    guestAccessEnded: Date.parse(event.guestAccessExpiresAt) <= nowMs,
    entryDisabled,
    lifecycleRecheckAfterMs: delays.length > 0 ? Math.min(...delays) : null,
  };
}
