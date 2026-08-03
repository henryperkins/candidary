import type { EventView, PhotoIntakeState } from '../../shared/contracts';

export type PhotoIntakeAction = 'open_early' | 'return_to_schedule' | 'pause' | 'reopen';

interface ManagerPhotoIntakePanelProps {
  event: EventView;
  // The printed entry has been stopped for good. Reopening is not one of the
  // transitions the server would accept, so it is never offered.
  entryDisabled: boolean;
  pending: boolean;
  onAction(action: PhotoIntakeAction): void;
}

// One status and one action per server-derived state. Which one the host sees is
// read straight out of `photoIntakeState`, never out of a comparison this
// browser performs: the clock that decides whether an event has started is the
// Worker's, and a device an hour fast would otherwise offer the wrong control.
const PHOTO_INTAKE_CONTROLS: Record<PhotoIntakeState, {
  status: string;
  label: string;
  action: PhotoIntakeAction;
}> = {
  scheduled: {
    status: 'Photo delivery opens when the event starts.',
    label: 'Open photo delivery now',
    action: 'open_early',
  },
  'open-early': {
    status: 'Photo delivery is open early.',
    label: 'Pause until the event starts',
    action: 'return_to_schedule',
  },
  open: {
    status: 'Photo delivery is open.',
    label: 'Pause photo delivery',
    action: 'pause',
  },
  paused: {
    status: 'Photo delivery is paused.',
    label: 'Reopen photo delivery',
    action: 'reopen',
  },
};

// The event's own zone, never the browser's. A host managing a Chicago wedding
// from a laptop still on Pacific time has to read the start they set.
function formatZonedStart(instant: string, timeZone: string): string {
  const at = new Date(instant);
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone,
  }).format(at);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone,
  }).format(at);
  return `${date} at ${time}`;
}

export function ManagerPhotoIntakePanel({
  event,
  entryDisabled,
  pending,
  onAction,
}: ManagerPhotoIntakePanelProps) {
  const control = PHOTO_INTAKE_CONTROLS[event.photoIntakeState];
  // "Before the start" without a clock comparison: the server only sends a delay
  // while a scheduled opening or the start itself is still ahead of it. A pause
  // in that window is the §6.4 exception — the normal pre-start control only
  // sets or clears the early opening — so it is explained rather than offered a
  // reopen that would look like the schedule coming back.
  const withheld = event.photoIntakeState !== 'paused'
    ? null
    : entryDisabled
      ? 'The printed event QR was disabled, so photo delivery cannot be reopened.'
      : event.photoIntakeRecheckAfterMs !== null
        ? 'Photo delivery is paused for this event and will not open at the scheduled start.'
        : null;
  return <section className="manager-credential" aria-labelledby="photo-intake-title">
    <h3 id="photo-intake-title">Photo delivery</h3>
    <p role="status" aria-live="polite">{pending ? 'Saving photo delivery…' : control.status}</p>
    <p>Event start: {formatZonedStart(event.eventStartAt, event.eventTimezone)} ({event.eventTimezone}).</p>
    {withheld
      ? <p>{withheld}</p>
      : <button
          type="button"
          className="button button--secondary"
          disabled={pending}
          onClick={() => onAction(control.action)}
        >{pending ? 'Saving…' : control.label}</button>}
  </section>;
}
