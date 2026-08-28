export const PENDING_REGISTRATION_KEY = 'candidary.pending-registration.v1';

const PENDING_REGISTRATION_VERSION = 1;

export interface PendingRegistrationMarker {
  emailDigest: string;
  expiresAt: string;
}

export interface AcceptedPendingRegistration {
  email: string;
  resumeExpiresAt: string;
}

interface StoredPendingRegistration extends PendingRegistrationMarker {
  version: typeof PENDING_REGISTRATION_VERSION;
}

function registrationStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function exactExpiry(value: unknown): { value: string; milliseconds: number } | null {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null;
  return { value, milliseconds };
}

function parseStoredMarker(
  serialized: string,
  now: Date,
): StoredPendingRegistration | null {
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== PENDING_REGISTRATION_VERSION) return null;
    if (typeof candidate.emailDigest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(candidate.emailDigest)) return null;
    const expiry = exactExpiry(candidate.expiresAt);
    if (!expiry || expiry.milliseconds <= now.getTime()) return null;
    return {
      version: PENDING_REGISTRATION_VERSION,
      emailDigest: candidate.emailDigest,
      expiresAt: expiry.value,
    };
  } catch {
    return null;
  }
}

function storedMarker(now: Date): StoredPendingRegistration | null {
  const storage = registrationStorage();
  if (!storage) return null;
  try {
    const serialized = storage.getItem(PENDING_REGISTRATION_KEY);
    if (serialized === null) return null;
    const marker = parseStoredMarker(serialized, now);
    if (!marker) storage.removeItem(PENDING_REGISTRATION_KEY);
    return marker;
  } catch {
    return null;
  }
}

async function emailDigest(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function rememberPendingRegistration(
  input: AcceptedPendingRegistration,
): Promise<void> {
  const storage = registrationStorage();
  if (!storage) return;
  const expiry = exactExpiry(input.resumeExpiresAt);
  if (!expiry || expiry.milliseconds <= Date.now()) {
    clearPendingRegistration();
    return;
  }
  const marker: StoredPendingRegistration = {
    version: PENDING_REGISTRATION_VERSION,
    emailDigest: await emailDigest(input.email),
    expiresAt: expiry.value,
  };
  try {
    storage.setItem(PENDING_REGISTRATION_KEY, JSON.stringify(marker));
  } catch {
    // Storage can be disabled or full. The HttpOnly cookie remains the only resume
    // credential, so failure here must not turn into a second credential channel.
  }
}

export function refreshPendingRegistrationExpiry(resumeExpiresAt: string): boolean {
  const storage = registrationStorage();
  if (!storage) return false;
  const marker = storedMarker(new Date());
  const expiry = exactExpiry(resumeExpiresAt);
  if (!marker || !expiry || expiry.milliseconds <= Date.now()) return false;
  try {
    storage.setItem(PENDING_REGISTRATION_KEY, JSON.stringify({
      version: PENDING_REGISTRATION_VERSION,
      emailDigest: marker.emailDigest,
      expiresAt: expiry.value,
    } satisfies StoredPendingRegistration));
    return true;
  } catch {
    return false;
  }
}

export async function readPendingRegistration(
  now: Date,
): Promise<PendingRegistrationMarker | null> {
  const marker = storedMarker(now);
  return marker ? { emailDigest: marker.emailDigest, expiresAt: marker.expiresAt } : null;
}

export async function matchesPendingRegistration(email: string, now: Date): Promise<boolean> {
  const marker = await readPendingRegistration(now);
  return marker !== null && marker.emailDigest === await emailDigest(email);
}

export function clearPendingRegistration(): void {
  try {
    registrationStorage()?.removeItem(PENDING_REGISTRATION_KEY);
  } catch {
    // Clearing is best effort when browser storage is unavailable.
  }
}
