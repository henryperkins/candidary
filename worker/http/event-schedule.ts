import { ApiError } from '../../shared/errors';
import { endOfLocalDate, instantForLocalDateTime } from '../../shared/event-time';

export interface EventScheduleInput {
  eventDate: string;
  // Local 24-hour wall clock. An omitted value is interpreted as `00:00` local
  // for rollout compatibility; every current client sends the field explicitly.
  eventStartTime?: string;
  rsvpDeadlineDate: string;
  eventTimezone: string;
}

export interface ResolvedEventSchedule {
  eventStartAt: string;
  rsvpDeadlineAt: string;
}

export const DEFAULT_EVENT_START_TIME = '00:00';

/**
 * Turns the host's calendar date, local start time, and deadline date into the
 * two absolute instants the lifecycle runs on.
 *
 * Only the dates, the time, and the zone are taken from the request; both
 * instants are derived here. A browser that sent its own timestamp would be
 * answering a question only the event's own zone can answer.
 *
 * Both instants are always resolved together, from the same tuple, so an edit
 * to any one of the three can never move one without the other. A time-zone
 * change that recomputed only the deadline could push it past the start.
 *
 * The rule is `rsvpDeadlineAt < eventStartAt`, strictly. `rsvpState` treats the
 * deadline instant itself as still open (`now > deadline` closes it), so a
 * non-strict rule would admit a single instant that is simultaneously RSVP-open
 * and event-started — a state no phase can describe and every guest RSVP route
 * would refuse. Because the deadline is the last millisecond of the host's
 * chosen local day, this means the deadline date must be earlier than the event
 * date; the comparison is still made on the resolved instants.
 */
export function resolveEventSchedule(
  input: EventScheduleInput,
  message: string,
): ResolvedEventSchedule {
  const startTime = input.eventStartTime ?? DEFAULT_EVENT_START_TIME;
  let eventStartAt: string;
  try {
    eventStartAt = instantForLocalDateTime(input.eventDate, startTime, input.eventTimezone);
  } catch {
    // A local time the zone skipped over is refused rather than silently moved:
    // the host is asked for a different time, because 02:30 becoming 03:30
    // would change what the invitation means without telling anyone.
    throw new ApiError('VALIDATION_FAILED', message, 422, {
      eventStartTime: 'Choose a start time that exists on the event date.',
    });
  }

  let rsvpDeadlineAt: string;
  try {
    rsvpDeadlineAt = endOfLocalDate(input.rsvpDeadlineDate, input.eventTimezone);
  } catch {
    throw new ApiError('VALIDATION_FAILED', message, 422, {
      rsvpDeadlineDate: 'Choose a valid RSVP deadline.',
    });
  }

  if (Date.parse(rsvpDeadlineAt) >= Date.parse(eventStartAt)) {
    throw new ApiError('VALIDATION_FAILED', message, 422, {
      rsvpDeadlineDate: 'The RSVP deadline must be before the event starts.',
    });
  }

  return { eventStartAt, rsvpDeadlineAt };
}
