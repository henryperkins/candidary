import { z } from 'zod';
import mobileImageCases from './mobile-image-cases.json';
import { KNOWN_IMAGE_FORMATS, type ImageDeclaration, type ImageEvidence, type ImageFamily } from './image-formats';

export const DECODER_PROTOCOL = 1 as const;
export const DECODER_PREVIEW_PROFILE = 'mobile-preview-v1';
export const DECODER_MAX_SOURCE_BYTES = 512 * 1024 * 1024;
export const DECODER_MAX_PROOF_BYTES = 2048;
export const DECODER_STILL_PREVIEW_BYTES = 8 * 1024 * 1024;
export const DECODER_ANIMATED_PREVIEW_BYTES = 20 * 1024 * 1024;
export type DecoderFailureCode = 'unsupported' | 'malformed' | 'resource_limit' | 'busy' | 'unavailable';
export type DecoderHealth = { protocolVersion: 1; buildFingerprint: string; decoderVersion: string };
export type DecoderInspection = ImageEvidence & {
  sourceSha256: string; byteSize: number; buildFingerprint: string; decoderVersion: string; previewProfile: string;
};
export type DecoderSource = {
  open: () => Promise<ReadableStream<Uint8Array>>;
  byteSize: number; declared: ImageDeclaration; signal?: AbortSignal;
};
export type DecoderPreview = {
  body: ReadableStream<Uint8Array>; byteSize: number; mimeType: 'image/webp' | 'image/jpeg';
  width: number; height: number; frameCount: number; inspection: DecoderInspection;
};
export interface ImageDecoder {
  inspectOriginal(source: DecoderSource): Promise<DecoderInspection>;
  renderOriginalPreview(source: DecoderSource): Promise<DecoderPreview>;
}
export function requiredCasesFor(family: ImageFamily, isSequence: boolean): readonly string[] {
  const cases = mobileImageCases.families[family];
  return [...cases.still, ...(isSequence ? cases.sequence : [])];
}
export class DecoderError extends Error {
  constructor(readonly code: DecoderFailureCode) {
    super(`Image decoder ${code}.`);
    this.name = 'DecoderError';
  }
}

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/u);
const positive = z.number().int().positive();
const healthSchema = z.object({ protocolVersion: z.literal(1), buildFingerprint: digest, decoderVersion: version }).strict();
const inspectionSchema = z.object({
  family: z.enum(Object.keys(KNOWN_IMAGE_FORMATS) as [ImageFamily, ...ImageFamily[]]),
  width: positive.max(300_000_000), height: positive.max(300_000_000),
  frameCount: positive.max(1024), primaryIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  isSequence: z.boolean(), sourceSha256: digest, byteSize: positive.max(DECODER_MAX_SOURCE_BYTES),
  buildFingerprint: digest, decoderVersion: version, previewProfile: z.literal(DECODER_PREVIEW_PROFILE),
}).strict().refine((value) => value.width * value.height <= 300_000_000
  && value.width * value.height * value.frameCount <= 1_000_000_000
  && (value.isSequence || value.frameCount === 1));
const failureSchema = z.object({ code: z.enum(['unsupported', 'malformed', 'resource_limit', 'busy', 'unavailable']) }).strict();

export function parseDecoderHealth(value: unknown): DecoderHealth {
  const parsed = healthSchema.safeParse(value);
  if (!parsed.success) throw new DecoderError('unavailable');
  return parsed.data;
}
export function parseDecoderInspection(value: unknown): DecoderInspection {
  const parsed = inspectionSchema.safeParse(value);
  if (!parsed.success) throw new DecoderError('unavailable');
  return parsed.data;
}
export function parseDecoderFailure(value: unknown): DecoderFailureCode {
  const parsed = failureSchema.safeParse(value);
  return parsed.success ? parsed.data.code : 'unavailable';
}
