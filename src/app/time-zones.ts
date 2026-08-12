// The host's own zone is the right first guess, and the server validates whatever comes back.
// `supportedValuesOf` is recent enough that a browser without it still has to work: the datalist is a
// convenience, not the input. Shared by the create form and Settings, which take the same value and
// must offer the same help with it.

export function detectedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function knownTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}
