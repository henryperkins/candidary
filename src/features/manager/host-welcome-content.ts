import type { HostEventLifecycleView } from '../../../shared/contracts';
import type { OverviewDestination, OverviewRecommendation } from './overview-policy';

export type HostWelcomeMode = 'intro' | 'tools';
export type TourDestination = 'overview' | 'rsvp' | 'share' | 'library' | 'settings';
export interface HostWelcomeContext {
  lifecycle: HostEventLifecycleView | null;
  phaseLabel: string;
  recommendation: OverviewRecommendation;
  eventStartLabel: string | null;
  namedGuests: number | null;
  photos: number | null;
  entryAvailability: 'available' | 'disabled' | 'absent' | 'unknown';
}
export interface HostWelcomeStep {
  id: string;
  destination: TourDestination;
  anchor: string;
  title: string;
  text: string;
}
const destinations: Record<OverviewDestination, string> = { rsvp: 'RSVP', share: 'Share', library: 'Library', originals: 'Exports', settings: 'Settings' };
export function hostWelcomeTaskAnchor(destination: OverviewDestination): string {
  return { rsvp: 'rsvp', share: 'share-qr', library: 'library', originals: 'exports', settings: 'settings' }[destination];
}
export type GuestEntryCopyContext = Pick<HostWelcomeContext, 'entryAvailability' | 'eventStartLabel'> & {
  lifecycle: Pick<HostEventLifecycleView, 'photoIntakeState' | 'entryDisabled' | 'guestAccessEnded'> | null;
};
export const OPTIONAL_RSVP_HELP = 'RSVP is optional. If you want attendance replies, set up your guest list. You send invitations; guests can send photos without RSVPing.';
const DISABLED_ENTRY_COPY = 'This event’s guest link and QR have been permanently disabled. Guests can no longer use them.';

/** Presentation of confirmed state only: no phase policy, clock or inferred host actions. */
export function getGuestEntryCopy(context: GuestEntryCopyContext): string {
  if (context.lifecycle?.entryDisabled || context.entryAvailability === 'disabled') return DISABLED_ENTRY_COPY;
  if (context.lifecycle?.guestAccessEnded) return 'Guest access has ended. Guests can no longer send photos. Retrieve originals in Exports while management access remains available.';
  if (context.entryAvailability === 'unknown') return 'Checking the guest link and QR. Retry in Share if they cannot load.';
  if (context.entryAvailability === 'absent') return 'The guest link and QR are unavailable. Review access in Settings.';
  if (!context.lifecycle) return 'Photo upload availability is not confirmed. Check the current phase in Overview before sharing.';
  if (context.lifecycle.photoIntakeState === 'open' || context.lifecycle.photoIntakeState === 'open-early') return 'Photo uploads are already open.';
  if (context.lifecycle.photoIntakeState === 'scheduled') return context.eventStartLabel
    ? `Photo uploads open ${context.eventStartLabel}.`
    : 'Photo uploads are scheduled. Check the opening time in Settings; it is not confirmed here.';
  return 'Photo uploads are paused. You can leave them paused or review availability in Settings.';
}
export function getCreationReceiptCopy(context: GuestEntryCopyContext): string {
  const ready = context.entryAvailability === 'available' && !context.lifecycle?.entryDisabled && !context.lifecycle?.guestAccessEnded;
  return [ready ? 'Your guest link and QR are ready.' : '', getGuestEntryCopy(context), 'Keep your management link private so you can return.'].filter(Boolean).join(' ');
}
export function getEmptyLibraryMessage(context: GuestEntryCopyContext): string {
  if (context.lifecycle?.entryDisabled || context.entryAvailability === 'disabled') return DISABLED_ENTRY_COPY;
  if (context.lifecycle?.guestAccessEnded) return 'Guest access has ended. Guests can no longer send photos.';
  if (context.entryAvailability === 'unknown') return 'Guest link availability is not confirmed. Check Share before sharing.';
  if (context.entryAvailability === 'absent') return 'The guest link and QR are unavailable. Review access in Settings.';
  if (!context.lifecycle) return 'Photo upload availability is not confirmed. Check the current phase in Overview.';
  if (context.lifecycle.photoIntakeState === 'scheduled') return 'Share your guest link so guests are ready when uploads open.';
  if (context.lifecycle.photoIntakeState === 'open' || context.lifecycle.photoIntakeState === 'open-early') return 'Share your guest link so guests can send originals.';
  return 'Photo uploads are paused. Review availability in Settings or leave them paused.';
}
function entryExplanation(context: HostWelcomeContext): string {
  const explanation = getGuestEntryCopy(context);
  return context.entryAvailability === 'available' && !context.lifecycle?.entryDisabled && !context.lifecycle?.guestAccessEnded
    && (context.lifecycle?.photoIntakeState === 'open' || context.lifecycle?.photoIntakeState === 'open-early' || context.lifecycle?.photoIntakeState === 'scheduled')
    ? `${explanation} Share your guest link or QR so guests can send originals without an app or account.` : explanation;
}
export function getHostWelcomeIntroduction(context: HostWelcomeContext) {
  const { recommendation } = context;
  const availability = recommendation.destination === 'share' || recommendation.destination === 'settings'
    || context.lifecycle?.guestAccessEnded || context.lifecycle?.entryDisabled || context.entryAvailability === 'disabled'
    ? entryExplanation(context) : '';
  const text = ['Original photos go directly to your private Library. Guests need no app or account; you share the guest link or QR.',
    context.phaseLabel + '.', recommendation.label + ': ' + recommendation.reason,
    availability,
    recommendation.destination === 'rsvp' ? OPTIONAL_RSVP_HELP : '',
  ].filter(Boolean).join(' ');
  return { title: 'Collect photos privately', text, destination: recommendation.destination, anchor: hostWelcomeTaskAnchor(recommendation.destination), label: `Go to ${destinations[recommendation.destination]}` };
}
export function getHostWelcomeToolSteps(context: HostWelcomeContext): HostWelcomeStep[] {
  const usableEntry = context.entryAvailability === 'available' && !!context.lifecycle && !context.lifecycle.entryDisabled && !context.lifecycle.guestAccessEnded;
  return [
    { id: 'overview', destination: 'overview', anchor: 'overview-task', title: 'Your next task', text: `${context.phaseLabel}. ${context.recommendation.reason} Return to Overview whenever you need your bearings.` },
    { id: 'rsvp', destination: 'rsvp', anchor: 'rsvp', title: 'Your guest list', text: `${context.namedGuests === 0 && context.lifecycle?.rsvpState === 'open' ? 'Add guests to prepare named invitations.' : 'Review your guest list and household attendance here.'} You send the invitations. RSVP is optional: guests can still deliver photos without responding.` },
    { id: 'share', destination: 'share', anchor: usableEntry ? 'share-qr' : 'share-status', title: 'One QR for your event', text: entryExplanation(context) },
    { id: 'library', destination: 'library', anchor: 'library', title: 'Your delivered photos', text: `${context.photos !== null && context.photos > 0 ? 'Your delivered originals are private in Library.' : 'Library keeps original photos private.'} Album and Guest gallery are separate, optional ways to share photos; neither is required to receive originals.` },
    { id: 'exports', destination: 'library', anchor: 'exports', title: 'Keep your originals', text: 'Open Exports when you want to prepare or retrieve originals. A ready export is available to download; it does not confirm that you have downloaded it.' },
    { id: 'settings', destination: 'settings', anchor: 'settings', title: 'Event details and access', text: `${context.lifecycle?.entryDisabled || context.entryAvailability === 'disabled' ? 'This event’s guest link and QR have been permanently disabled. Guests can no longer use them. Review access here.' : context.lifecycle?.photoIntakeState === 'paused' ? 'Photo delivery is paused. You can leave it paused or review availability here.' : 'Review event details, RSVP availability and photo delivery here.'} This tour changes no settings. Finish returns you to your next task.` },
  ];
}
