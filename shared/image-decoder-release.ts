import type { ImageFamily } from './image-formats';
import { z } from 'zod';
import { DECODER_PREVIEW_PROFILE, requiredCasesFor } from './image-decoder-contract';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const record = z.object({
  imageRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u),
  buildFingerprint: digest,
  protocolVersion: z.literal(1),
  verifiedCaseIds: z.array(z.string().regex(/^[a-z0-9-]+$/u)).max(256),
  previewProfile: z.literal(DECODER_PREVIEW_PROFILE),
  evidenceSha256: digest,
}).strict();
const releaseSchema = z.object({
  protocolVersion: z.literal(1), previewProfile: z.literal(DECODER_PREVIEW_PROFILE), releases: z.array(record).max(32),
}).strict();

/** Committed external evidence is authority; runtime health never grants its own cases. */
export function qualifiedDecoderFingerprints(release: unknown, family: ImageFamily, isSequence: boolean): readonly string[] {
  const parsed = releaseSchema.safeParse(release);
  if (!parsed.success) return [];
  const required = requiredCasesFor(family, isSequence);
  return [...new Set(parsed.data.releases.filter((candidate) => required.length > 0
    && required.every((id) => candidate.verifiedCaseIds.includes(id))).map((candidate) => candidate.buildFingerprint))];
}
