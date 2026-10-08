import { describe, expect, it } from 'vitest';
import type { HostEventLifecycleView } from '../../shared/contracts';
import { resolveOverviewRecommendation } from '../../src/features/manager/overview-policy';
const view: HostEventLifecycleView = { phase: 'rsvp-primary', rsvpState: 'open', photoIntakeState: 'scheduled', guestAccessEnded: false, entryDisabled: false, lifecycleRecheckAfterMs: null };
describe('Overview recommendation', () => {
  it.each([
    [{ ...view, guestAccessEnded: true, entryDisabled: true }, 0, 0, 'originals', 'Retrieve originals'],
    [{ ...view, entryDisabled: true }, 0, 0, 'settings', 'Review event access'],
    [view, 0, null, 'rsvp', 'Add guests'],
    [view, 2, null, 'rsvp', 'Review RSVPs'],
    [view, null, null, 'rsvp', 'Review RSVPs'],
    [{ ...view, phase: 'before-start' }, null, null, 'share', 'Prepare your QR'],
    [{ ...view, phase: 'photos-primary' }, null, 0, 'share', 'Share your QR'],
    [{ ...view, phase: 'photos-primary' }, null, 2, 'library', 'Open Library'],
    [{ ...view, phase: 'photos-primary' }, null, null, 'library', 'Open Library'],
    [{ ...view, phase: 'waiting' }, null, null, 'settings', 'Review delivery settings'],
    [null, null, null, 'settings', 'Open Settings'],
  ] as const)('uses confirmed state %j', (lifecycle, guests, photos, destination, label) => {
    expect(resolveOverviewRecommendation(lifecycle as HostEventLifecycleView | null, guests, photos)).toMatchObject({ destination, label });
  });
  it('describes a pause calmly without assigning failure or completion', () => {
    expect(resolveOverviewRecommendation({ ...view, phase: 'waiting' }, null, null).reason).toMatch(/paused/);
    expect(resolveOverviewRecommendation(view, null, null).reason).not.toMatch(/no guests|not added|complete/);
  });
});
