/** Download routes enforce this deadline even before scheduled cleanup records Expired. */
export function hasExpiredExportLinks(
  job: { state: string; expiresAt: string | null },
  now = Date.now(),
): boolean {
  return job.state === 'ready' && job.expiresAt !== null && Date.parse(job.expiresAt) <= now;
}
