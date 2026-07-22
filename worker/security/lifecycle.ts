const DAY_MS = 24 * 60 * 60 * 1000;

function eventDeadline(eventDate: string, days: number): number {
  const parsed = new Date(`${eventDate}T23:59:59.999Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error('Event date must be a valid calendar date.');
  return parsed.getTime() + days * DAY_MS;
}

function fixedDeadline(eventDate: string, now: Date, days: number): string {
  return new Date(Math.max(eventDeadline(eventDate, days), now.getTime() + days * DAY_MS)).toISOString();
}

export interface EventLifecycle {
  guestAccessExpiresAt: string;
  managementAccessExpiresAt: string;
  purgeAfter: string;
}

export function calculateLifecycle(eventDate: string, now = new Date()): EventLifecycle {
  return {
    guestAccessExpiresAt: fixedDeadline(eventDate, now, 30),
    managementAccessExpiresAt: fixedDeadline(eventDate, now, 90),
    purgeAfter: fixedDeadline(eventDate, now, 120),
  };
}

