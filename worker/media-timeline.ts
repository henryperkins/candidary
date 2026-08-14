import type { SupportedImageType } from '../shared/constants';
import type { TimelineSource } from '../shared/contracts';
import { instantForLocalDateTimeSeconds } from '../shared/event-time';
import { isLegacyEventStart } from '../shared/rsvp';
import { inspectJpegCaptureTime } from './security/exif-capture-time';

export interface MediaTimeline {
  capturedAt: string | null;
  timelineAt: string;
  timelineSource: TimelineSource;
}

export interface MediaTimelineInput {
  mimeType: SupportedImageType;
  bytes: Uint8Array;
  eventStartAt: string;
  eventTimezone: string;
  storedAt: string;
}

export interface MediaTimelineContext {
  eventStartAt: string;
  eventTimezone: string;
}

const CAPTURE_PRE_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CAPTURE_POST_RECEIPT_TOLERANCE_MS = 5 * 60 * 1000;
const DATE_TIME_ORIGINAL = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u;
const OFFSET_TIME_ORIGINAL = /^([+-])(\d{2}):(\d{2})$/u;

function receivedFallback(storedAt: string): MediaTimeline {
  return { capturedAt: null, timelineAt: storedAt, timelineSource: 'received' };
}

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  const rebuilt = new Date(Date.UTC(year, month - 1, day));
  return rebuilt.getUTCFullYear() === year
    && rebuilt.getUTCMonth() + 1 === month
    && rebuilt.getUTCDate() === day;
}

/**
 * The one effective timeline instant for a newly stored photo.
 *
 * Exactly one embedded capture-time source is supported — JPEG
 * `DateTimeOriginal`, with optional `OffsetTimeOriginal` — and it is trusted
 * only inside the event-start and receipt-time plausibility windows. Every
 * other container, malformed metadata, DST gap, sentinel event start, and
 * out-of-window candidate deliberately falls back to `stored_at`, because a
 * believable received-time position beats an incorrect device clock.
 */
export function resolveMediaTimeline(input: MediaTimelineInput): MediaTimeline {
  const fallback = receivedFallback(input.storedAt);
  if (input.mimeType !== 'image/jpeg') return fallback;
  if (isLegacyEventStart(input.eventStartAt)) return fallback;
  const eventStartMs = Date.parse(input.eventStartAt);
  const storedMs = Date.parse(input.storedAt);
  if (!Number.isFinite(eventStartMs) || !Number.isFinite(storedMs)) return fallback;

  const exif = inspectJpegCaptureTime(input.bytes);
  if (!exif) return fallback;
  const dateTime = DATE_TIME_ORIGINAL.exec(exif.dateTimeOriginal);
  if (!dateTime) return fallback;
  const year = Number(dateTime[1]);
  const month = Number(dateTime[2]);
  const day = Number(dateTime[3]);
  const hour = Number(dateTime[4]);
  const minute = Number(dateTime[5]);
  const second = Number(dateTime[6]);
  if (hour > 23 || minute > 59 || second > 59 || !isRealCalendarDate(year, month, day)) {
    return fallback;
  }
  const dateOnly = `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}`;

  let captureMs: number;
  if (exif.offsetTimeOriginal !== null) {
    const offset = OFFSET_TIME_ORIGINAL.exec(exif.offsetTimeOriginal);
    if (!offset) return fallback;
    const offsetHour = Number(offset[2]);
    const offsetMinute = Number(offset[3]);
    if (offsetHour > 23 || offsetMinute > 59) return fallback;
    const offsetMs = (offsetHour * 60 + offsetMinute) * 60_000;
    const sign = offset[1] === '+' ? 1 : -1;
    captureMs = Date.UTC(year, month - 1, day, hour, minute, second) - sign * offsetMs;
  } else {
    try {
      captureMs = Date.parse(
        instantForLocalDateTimeSeconds(dateOnly, hour, minute, second, input.eventTimezone),
      );
    } catch {
      return fallback;
    }
  }

  if (!Number.isFinite(captureMs)) return fallback;
  if (captureMs < eventStartMs - CAPTURE_PRE_EVENT_WINDOW_MS) return fallback;
  if (captureMs > storedMs + CAPTURE_POST_RECEIPT_TOLERANCE_MS) return fallback;

  const capturedAt = new Date(captureMs).toISOString();
  return { capturedAt, timelineAt: capturedAt, timelineSource: 'capture' };
}
