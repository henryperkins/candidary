import { describe, expect, it } from 'vitest';
import type { HostEventLifecycleView } from '../../shared/contracts';
import { getHostWelcomeIntroduction, getHostWelcomeToolSteps, getGuestEntryCopy, getCreationReceiptCopy, getEmptyLibraryMessage, type HostWelcomeContext } from '../../src/features/manager/host-welcome-content';
import { overviewPhaseLabel, resolveOverviewRecommendation } from '../../src/features/manager/overview-policy';
const base: HostEventLifecycleView = { phase: 'photos-primary', rsvpState: 'disabled', photoIntakeState: 'open', guestAccessEnded: false, entryDisabled: false, lifecycleRecheckAfterMs: null };
export function context(lifecycle: HostEventLifecycleView | null = base, namedGuests: number | null = null, photos: number | null = null): HostWelcomeContext {
  return { lifecycle, phaseLabel: overviewPhaseLabel(lifecycle), recommendation: resolveOverviewRecommendation(lifecycle, namedGuests, photos), eventStartLabel: 'September 19, 2026 at 5:00 PM CDT', namedGuests, photos, entryAvailability: lifecycle?.entryDisabled ? 'disabled' : 'available' };
}
describe('state-aware host welcome content', () => {
  it.each([
    ['unknown phase', null, null, null, 'settings', /checking|not confirmed/i],
    ['empty roster', { ...base, phase: 'rsvp-primary', rsvpState: 'open' }, 0, null, 'rsvp', /add guests/i],
    ['existing roster', { ...base, phase: 'rsvp-primary', rsvpState: 'open' }, 4, null, 'rsvp', /review RSVPs/i],
    ['unknown roster', { ...base, phase: 'rsvp-primary', rsvpState: 'open' }, null, null, 'rsvp', /review RSVPs/i],
    ['scheduled', { ...base, phase: 'before-start', photoIntakeState: 'scheduled' }, null, 0, 'share', /September 19, 2026 at 5:00 PM CDT/],
    ['open empty', base, null, 0, 'share', /already open/i],
    ['open early', { ...base, photoIntakeState: 'open-early' }, null, 0, 'share', /already open/i],
    ['photos delivered', base, null, 4, 'library', /privat/i],
    ['photos unknown', base, null, null, 'library', /Library/],
    ['paused', { ...base, phase: 'waiting', photoIntakeState: 'paused' }, null, 0, 'settings', /leave.*paused/i],
    ['disabled', { ...base, entryDisabled: true }, null, 0, 'settings', /permanently disabled/i],
    ['ended', { ...base, guestAccessEnded: true }, null, 0, 'originals', /retrieve originals/i],
    ['ended and disabled', { ...base, guestAccessEnded: true, entryDisabled: true }, null, 0, 'originals', /permanently disabled/i],
  ] as const)('%s has truthful copy and exact handoff', (_name, lifecycle, guests, photos, destination, text) => {
    const value = context(lifecycle as HostEventLifecycleView | null, guests, photos);
    const intro = getHostWelcomeIntroduction(value);
    expect(intro.destination).toBe(destination);
    expect(intro.text).toMatch(text);
    expect(intro.label).toBe(`Go to ${destination === 'originals' ? 'Exports' : destination === 'rsvp' ? 'RSVP' : destination[0]!.toUpperCase() + destination.slice(1)}`);
    const steps = getHostWelcomeToolSteps(value);
    expect(steps.map(step => step.id)).toEqual(['overview', 'rsvp', 'share', 'library', 'exports', 'settings']);
    expect(steps).toHaveLength(6);
    expect(steps[1]!.text).toMatch(/optional/);
    expect(steps[1]!.text).toMatch(/you send/i);
    if (lifecycle?.guestAccessEnded || lifecycle?.entryDisabled) {
      expect(intro.text).not.toMatch(/share (its|your|the) (event )?link/i);
      expect(steps[2]!.anchor).toBe('share-status');
      expect(steps[2]!.text).not.toMatch(/share (your|the).*QR/i);
    }
    if (guests === null) expect(steps[1]!.text).not.toMatch(/no guests|empty|add guests/i);
    if (photos === null) expect(steps[3]!.text).not.toMatch(/no photos|have arrived|empty/i);
  });
  it.each(['unknown', 'absent', 'disabled'] as const)('never points to a QR when entry is %s', entryAvailability => {
    const value = { ...context(base, null, 0), entryAvailability };
    const step = getHostWelcomeToolSteps(value)[2]!;
    expect(step.anchor).toBe('share-status');
    expect(step.text).not.toMatch(/use the same|share your QR/i);
    expect(step.text).toMatch(entryAvailability === 'unknown' ? /checking|not confirmed/i : entryAvailability === 'disabled' ? /permanently disabled/i : /unavailable/i);
  });
});

describe('contextual link and Library copy', () => {
  it.each([
    ['scheduled', { ...base, photoIntakeState: 'scheduled' }, 'available', 'Photo uploads open September 19, 2026 at 5:00 PM CDT.', 'Share your guest link so guests are ready when uploads open.'],
    ['open', base, 'available', 'Photo uploads are already open.', 'Share your guest link so guests can send originals.'],
    ['open early', { ...base, photoIntakeState: 'open-early' }, 'available', 'Photo uploads are already open.', 'Share your guest link so guests can send originals.'],
    ['paused', { ...base, photoIntakeState: 'paused' }, 'available', 'Photo uploads are paused. You can leave them paused or review availability in Settings.', 'Photo uploads are paused. Review availability in Settings or leave them paused.'],
    ['disabled', { ...base, entryDisabled: true }, 'disabled', 'This event’s guest link and QR have been permanently disabled. Guests can no longer use them.', 'This event’s guest link and QR have been permanently disabled. Guests can no longer use them.'],
    ['ended', { ...base, guestAccessEnded: true }, 'available', 'Guest access has ended. Guests can no longer send photos. Retrieve originals in Exports while management access remains available.', 'Guest access has ended. Guests can no longer send photos.'],
    ['missing entry', base, 'absent', 'The guest link and QR are unavailable. Review access in Settings.', 'The guest link and QR are unavailable. Review access in Settings.'],
    ['unconfirmed entry', base, 'unknown', 'Checking the guest link and QR. Retry in Share if they cannot load.', 'Guest link availability is not confirmed. Check Share before sharing.'],
  ] as const)('%s uses confirmed availability', (_name, lifecycle, entryAvailability, shareCopy, emptyMessage) => {
    const value = { ...context(lifecycle as HostEventLifecycleView, null, 0), entryAvailability };
    expect(getGuestEntryCopy(value)).toBe(shareCopy);
    expect(getEmptyLibraryMessage(value)).toBe(emptyMessage);
    const receipt = getCreationReceiptCopy(value);
    expect(receipt).toContain(shareCopy);
    expect(receipt).toContain('Keep your management link private so you can return.');
    if (entryAvailability !== 'available' || lifecycle.guestAccessEnded || lifecycle.entryDisabled) {
      expect(receipt).not.toContain('are ready');
      expect(emptyMessage).not.toMatch(/share your guest link/i);
    }
  });
  it('never promises an opening time for an unknown phase or legacy/sentinel start', () => {
    const legacy = { ...context({ ...base, photoIntakeState: 'scheduled' }), eventStartLabel: null };
    expect(getGuestEntryCopy(legacy)).toBe('Photo uploads are scheduled. Check the opening time in Settings; it is not confirmed here.');
    expect(getGuestEntryCopy(context(null))).toBe('Photo upload availability is not confirmed. Check the current phase in Overview before sharing.');
    expect(getCreationReceiptCopy(legacy)).not.toMatch(/Invalid Date|1970|open .* at|opens at start/);
  });
});
