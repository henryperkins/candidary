import type { HostEventLifecycleView } from '../../../shared/contracts';

export type OverviewDestination = 'rsvp' | 'share' | 'library' | 'settings' | 'originals';
export interface OverviewRecommendation { label: string; reason: string; destination: OverviewDestination }

export function resolveOverviewRecommendation(
  lifecycle: HostEventLifecycleView | null,
  namedInvitees: number | null,
  deliveredPhotos: number | null,
): OverviewRecommendation {
  if (lifecycle === null) return { label: 'Open Settings', reason: 'The current phase is not confirmed yet. You can review event details or retry the phase below.', destination: 'settings' };
  if (lifecycle.guestAccessEnded) return { label: 'Retrieve originals', reason: 'Guest access has ended. Management and original retrieval remain available until the management deadline.', destination: 'originals' };
  if (lifecycle.entryDisabled) return { label: 'Review event access', reason: 'The printed event QR is disabled. Review access in Settings.', destination: 'settings' };
  switch (lifecycle.phase) {
    case 'rsvp-primary': return namedInvitees === 0
      ? { label: 'Add guests', reason: 'RSVP is open and the confirmed guest list is empty. Add named guests to prepare their household responses.', destination: 'rsvp' }
      : { label: 'Review RSVPs', reason: 'RSVP is open. Review household attendance and prepare your guest list.', destination: 'rsvp' };
    case 'before-start': return { label: 'Prepare your QR', reason: 'The event has not started. Prepare the permanent QR for your invitations or venue signs.', destination: 'share' };
    case 'photos-primary': return deliveredPhotos === 0
      ? { label: 'Share your QR', reason: 'Photo delivery is open. Share the permanent QR so guests can send their photos.', destination: 'share' }
      : { label: 'Open Library', reason: 'Photo delivery is open. View the originals delivered privately to you in Library.', destination: 'library' };
    case 'waiting': return { label: 'Review delivery settings', reason: 'Photo delivery is paused. You can leave it paused or review availability when you are ready.', destination: 'settings' };
  }
}

export function overviewPhaseLabel(lifecycle: HostEventLifecycleView | null): string {
  if (!lifecycle) return 'Current phase not confirmed';
  if (lifecycle.guestAccessEnded) return 'Guest access ended';
  if (lifecycle.entryDisabled) return 'Event QR disabled';
  return { 'rsvp-primary': 'RSVP is open', 'before-start': 'Before the event', 'photos-primary': 'Photo delivery is open', waiting: 'Photo delivery is paused' }[lifecycle.phase];
}

/** Delays may shorten without a semantic transition; preserve the armed boundary. */
export function overviewLifecycleKey(lifecycle: HostEventLifecycleView): string {
  return [lifecycle.phase, lifecycle.rsvpState, lifecycle.photoIntakeState, lifecycle.guestAccessEnded, lifecycle.entryDisabled].join(':');
}
