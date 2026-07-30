import { Hono } from 'hono';
import { z } from 'zod';

import { MAX_RSVP_CSV_BYTES } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { requireManager } from '../auth/manager';
import type { AppBindings } from '../env';
import { RsvpService } from '../services/rsvp';

// Defence in depth ahead of the parser's own byte limit. Deliberately generous:
// an ordinary oversized file should reach the parser and come back as a
// `file_too_large` issue the host can read, not as a bare validation refusal.
const csvField = z.string().max(MAX_RSVP_CSV_BYTES * 2);

const previewSchema = z.object({ csv: csvField });

const commitSchema = z.object({
  csv: csvField,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedRosterVersion: z.number().int().min(0),
});

export const manageRsvpRoutes = new Hono<AppBindings>();

// Neither route reports anything but counts, issue codes, and digests. A parse
// failure must never echo a row, and no log line may carry the file.
function invalidBody(): ApiError {
  return new ApiError('VALIDATION_FAILED', 'Upload a guest list file to continue.', 422);
}

manageRsvpRoutes.post('/manage/events/:eventId/rsvp/import/preview', async (context) => {
  const auth = await requireManager(context, { write: true });
  const parsed = previewSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw invalidBody();

  const preview = await new RsvpService(context.env).previewImport(auth.event, parsed.data.csv);
  return context.json({ data: preview, requestId: context.get('requestId') });
});

manageRsvpRoutes.post('/manage/events/:eventId/rsvp/import/commit', async (context) => {
  const auth = await requireManager(context, { write: true });
  const parsed = commitSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw invalidBody();

  const committed = await new RsvpService(context.env)
    .commitInitialImport(auth.event, parsed.data);
  return context.json({ data: committed, requestId: context.get('requestId') }, 201);
});
