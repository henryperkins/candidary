/**
 * One byte scale for the whole manager. Event capacity and export part sizes are the
 * same fact to a host — how much of their event this is — so they must not drift into
 * two different roundings.
 */
export function formatBytes(bytes = 0): string {
  if (bytes < 1024 ** 2) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
