import type { EventView, PhotoIntakeState } from '../../shared/contracts';
import { formatEventDateTime, TIME_UNAVAILABLE } from '../app/event-date-time';

export type PhotoIntakeAction = 'open_early' | 'return_to_schedule' | 'pause' | 'reopen';

interface ManagerPhotoIntakePanelProps {
  event: EventView;
  // The printed entry has been stopped for good. Resuming is not one of the
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
    status: 'Guest uploads open when the event starts.',
    label: 'Open guest uploads now',
    action: 'open_early',
  },
  'open-early': {
    status: 'Guest uploads are open early.',
    label: 'Return guest uploads to schedule',
    action: 'return_to_schedule',
  },
  open: {
    status: 'Guest uploads are open.',
    label: 'Pause guest uploads',
    action: 'pause',
  },
  paused: {
    status: 'New guest uploads are paused. Event access, Guestbook, the Guest gallery setting, and Manager uploads are unchanged.',
    label: 'Resume guest uploads',
    action: 'reopen',
  },
};

export function ManagerPhotoIntakePanel({
  event,
  entryDisabled,
  pending,
  onAction,
}: ManagerPhotoIntakePanelProps) {
  const control = PHOTO_INTAKE_CONTROLS[event.photoIntakeState];
  const eventStart = formatEventDateTime(event.eventStartAt, event.eventTimezone)
    ?? TIME_UNAVAILABLE;
  // "Before the start" without a clock comparison: the server only sends a delay
  // while a scheduled opening or the start itself is still ahead of it. A pause
  // in that window is the §6.4 exception — the normal pre-start control only
  // sets or clears the early opening — so it is explained rather than offered a
  // resume action that would look like the schedule coming back.
  const withheld = event.photoIntakeState !== 'paused'
    ? null
    : entryDisabled
      ? 'The printed event QR was disabled, so guest uploads cannot resume.'
      : event.photoIntakeRecheckAfterMs !== null
        ? 'Guest uploads are paused for this event and will not open at the scheduled start.'
        : null;
  return <section className="manager-credential" aria-labelledby="photo-intake-title">
    <h3 id="photo-intake-title">Guest uploads</h3>
    <p role="status" aria-live="polite">{pending ? 'Saving guest uploads…' : control.status}</p>
    <p>Event start: {eventStart} ({event.eventTimezone}).</p>
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
