import type { ExportGuestbookEntryRecord } from '../db/types';
import type { GuestbookPhotoArchiveMap } from './guestbook-csv';
import { exportPartName } from './paths';

export interface GuestbookHtmlInput {
  eventName: string;
  eventDate: string;
  eventTimezone: string;
  prompt: string;
  snapshotAt: string;
  entries: ExportGuestbookEntryRecord[];
  photoArchiveByMediaId: GuestbookPhotoArchiveMap;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return value;
  } catch {
    return 'UTC';
  }
}

function formatInstant(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: safeTimeZone(timeZone),
  }).format(date);
}

function formatEventDate(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

function compareEntries(left: ExportGuestbookEntryRecord, right: ExportGuestbookEntryRecord): number {
  return left.createdAt.localeCompare(right.createdAt)
    || right.sourceRank - left.sourceRank
    || left.sourceId.localeCompare(right.sourceId);
}

export function buildGuestbookHtml(input: GuestbookHtmlInput): string {
  const entries = input.entries
    .filter((entry) => entry.includedInKeepsake)
    .toSorted(compareEntries);
  const articles = entries.map((entry) => {
    const guestName = entry.guestName ?? 'Unsigned';
    const archive = entry.mediaId ? input.photoArchiveByMediaId.get(entry.mediaId) : undefined;
    const photo = entry.source === 'photo_caption'
      ? `<p class="source">Photo caption${archive
        ? ` · ${escapeHtml(exportPartName(archive.partNumber))} · ${escapeHtml(archive.path)}`
        : entry.mediaId ? ` · Photo ID ${escapeHtml(entry.mediaId)}` : ''}</p>`
      : '';
    return `<article dir="auto">
      ${photo}
      <p class="entry-body">${escapeHtml(entry.body)}</p>
      <footer><strong>${escapeHtml(guestName)}</strong><time datetime="${escapeHtml(entry.createdAt)}">${escapeHtml(formatInstant(entry.createdAt, input.eventTimezone))}</time></footer>
    </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(input.eventName)} guestbook</title>
<style>
:root{color-scheme:light;font-family:Georgia,serif;background:#f7f3ec;color:#241f1a}body{max-width:52rem;margin:0 auto;padding:3rem 1.5rem}header{text-align:center;margin-bottom:3rem}h1{font-size:2.4rem;margin:.3rem 0}.prompt{font-size:1.2rem}.prepared{font-family:system-ui,sans-serif;font-size:.9rem}article{background:#fff;padding:1.5rem;margin:1rem 0;border:1px solid #d7cec1;break-inside:avoid;overflow-wrap:anywhere}.entry-body{white-space:pre-wrap;font-size:1.1rem;line-height:1.6}.source,footer{font-family:system-ui,sans-serif;font-size:.85rem}footer{display:flex;justify-content:space-between;gap:1rem;border-top:1px solid #e7e0d6;padding-top:.75rem}time{white-space:nowrap}.empty{text-align:center;padding:2rem}
@media print{body{max-width:none;background:#fff;padding:0}article{box-shadow:none}a{color:inherit}}
</style></head><body>
<header dir="auto"><p>${escapeHtml(formatEventDate(input.eventDate))}</p><h1>${escapeHtml(input.eventName)}</h1><p class="prompt">${escapeHtml(input.prompt)}</p><p class="prepared">Prepared from the guestbook on ${escapeHtml(formatInstant(input.snapshotAt, input.eventTimezone))} (${escapeHtml(input.eventTimezone)})</p></header>
<main>${articles || '<p class="empty">No guestbook entries were shared at this snapshot.</p>'}</main>
</body></html>`;
}
