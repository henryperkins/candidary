import { z } from 'zod';
import decoderRelease from '../config/image-decoder-release.json';
import mobileRelease from '../config/mobile-image-release.json';
import caseCatalog from '../shared/mobile-image-cases.json';
import { MAX_IMAGE_BYTES } from '../shared/constants';
import { DECODER_MAX_PROOF_BYTES, DECODER_PREVIEW_PROFILE, DecoderError, parseDecoderHealth, requiredCasesFor, type DecoderHealth } from '../shared/image-decoder-contract';
import { qualifiedDecoderFingerprints } from '../shared/image-decoder-release';
import { KNOWN_IMAGE_FORMATS, LEGACY_UPLOAD_MIME_TYPES, type ImageDeclaration, type ImageFamily } from '../shared/image-formats';
import { MAX_MOBILE_ORIGINAL_BYTES, MOBILE_IMAGE_PART_BYTES, type UploadCapabilityView } from '../shared/mobile-image-contract';
import { resolvePhotoIntake } from '../shared/rsvp';
import type { AppEnv } from './env';
import type { EventRecord } from './db/types';
import type { UploadAuthority } from './services/upload-authority';
import { ImageDecoderClient } from './services/image-decoder';

declare const __CANDIDARY_TEST_MOBILE_IMAGE_RELEASE__: boolean;
declare global { var __CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__: unknown; }

const sha = z.string().regex(/^[0-9a-f]{64}$/u);
const releaseSchema = z.object({
  kind:z.literal('candidary.mobile-image-release'),schemaVersion:z.literal(26),protocolVersion:z.literal(1),
  previewProfile:z.literal(DECODER_PREVIEW_PROFILE),maxOriginalBytes:z.number().int().min(1).max(MAX_MOBILE_ORIGINAL_BYTES),
  cases:z.array(z.object({caseId:z.string().regex(/^[a-z0-9-]+$/u),buildFingerprint:sha,evidenceSha256:sha,
    maxOriginalBytes:z.number().int().min(1).max(MAX_MOBILE_ORIGINAL_BYTES)}).strict()).max(1024),
}).strict();
type Release = z.infer<typeof releaseSchema>;
export type CaseAdmission = {enabled:boolean;qualifiedFingerprints:string[];maxOriginalBytes:number};
export type DeclarationAdmission = CaseAdmission & {caseIds:string[];reason:'disabled'|'unavailable'|null;currentFingerprint:string|null};
type AdmissionRow = {case_id:string;enabled:number;max_original_bytes:number};
type Snapshot = {release:Release;decoder:unknown;rows:AdmissionRow[];health:DecoderHealth|null};
const closed = (): CaseAdmission => ({enabled:false,qualifiedFingerprints:[],maxOriginalBytes:0});

function committedEvidence(): {mobile:unknown;decoder:unknown} {
  // Only Vitest defines this outer compile-time guard. Requests/env cannot enable it.
  if (typeof __CANDIDARY_TEST_MOBILE_IMAGE_RELEASE__ !== 'undefined' && __CANDIDARY_TEST_MOBILE_IMAGE_RELEASE__) {
    const override = globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__;
    if (override && typeof override === 'object' && 'mobileRelease' in override && 'decoderRelease' in override)
      return {mobile:override.mobileRelease,decoder:override.decoderRelease};
  }
  return {mobile:mobileRelease,decoder:decoderRelease};
}

export async function mobileImageSchemaReady(db: D1Database): Promise<boolean> {
  try {
    const marker = await db.prepare('SELECT singleton,version,protocol FROM mobile_image_schema').all<{singleton:number;version:number;protocol:number}>();
    if (marker.results.length !== 1 || marker.results[0]?.singleton !== 1 || marker.results[0]?.version !== 26 || marker.results[0]?.protocol !== 1) return false;
    const tables = await db.prepare(`SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name IN
      ('mobile_image_admission','media_upload_transfers','media_upload_parts','media_upload_assemblies','media_processing','media_image_previews')`).first<number>('n');
    return tables === 6;
  } catch { return false; }
}

async function health(env: AppEnv): Promise<DecoderHealth|null> {
  if (!env.IMAGE_DECODER || !['production','preview'].includes(env.IMAGE_DECODER_ENVIRONMENT)) return null;
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const timer = setTimeout(() => abort.abort(),10_000);
  try {
    const operation = async () => {
      const response = await env.IMAGE_DECODER.fetch(new Request('https://image-decoder.internal/health',{
        headers:{'X-Decoder-Protocol':'1','X-Decoder-Lane':'upload'},signal:abort.signal,
      }));
      if (abort.signal.aborted || response.status !== 200 || response.headers.get('X-Decoder-Protocol') !== '1'
        || response.headers.get('X-Decoder-Environment') !== env.IMAGE_DECODER_ENVIRONMENT
        || response.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json' || !response.body) {
        await response.body?.cancel(); return null;
      }
      reader = response.body.getReader();
      const bytes = new Uint8Array(DECODER_MAX_PROOF_BYTES);
      let length = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        if (next.value.byteLength > bytes.byteLength - length) return null;
        bytes.set(next.value,length); length += next.value.byteLength;
      }
      return parseDecoderHealth(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes.subarray(0,length))));
    };
    return await Promise.race([operation(),new Promise<null>((resolve) => abort.signal.addEventListener('abort',() => resolve(null),{once:true}))]);
  } catch { return null; }
  finally { clearTimeout(timer); abort.abort(); await reader?.cancel().catch(() => {}); }
}

async function snapshot(env: AppEnv): Promise<Snapshot|null> {
  const evidence = committedEvidence();
  const parsed = releaseSchema.safeParse(evidence.mobile);
  if (!parsed.success || !parsed.data.cases.length || !await mobileImageSchemaReady(env.DB)) return null;
  try {
    const rows = (await env.DB.prepare('SELECT case_id,enabled,max_original_bytes FROM mobile_image_admission').all<AdmissionRow>()).results;
    const state:Snapshot = {release:parsed.data,decoder:evidence.decoder,rows,health:null};
    if (parsed.data.cases.some((entry) => configuredCase(entry.caseId,state).qualifiedFingerprints.length)) state.health = await health(env);
    return state;
  } catch { return null; }
}

function configuredCase(caseId:string, state:Snapshot): CaseAdmission {
  const row = state.rows.find((candidate) => candidate.case_id === caseId);
  if (!row || row.enabled !== 1) return closed();
  const families = Object.entries(caseCatalog.families).filter(([,cases]) => [...cases.still,...cases.sequence].includes(caseId));
  if (!families.length) return closed();
  const native = new Set(families.flatMap(([family,cases]) => qualifiedDecoderFingerprints(state.decoder,family as ImageFamily,(cases.sequence as string[]).includes(caseId))));
  const records = state.release.cases.filter((entry) => entry.caseId === caseId && native.has(entry.buildFingerprint));
  const fingerprints = [...new Set(records.map((entry) => entry.buildFingerprint))];
  return {enabled:fingerprints.length > 0 && state.health !== null && fingerprints.includes(state.health.buildFingerprint),qualifiedFingerprints:fingerprints,
    maxOriginalBytes:records.length ? Math.min(state.release.maxOriginalBytes,row.max_original_bytes,...records.map((entry) => entry.maxOriginalBytes)) : 0};
}

export async function getCaseAdmission(caseId: string, env: AppEnv): Promise<CaseAdmission> {
  const state = await snapshot(env);
  return state ? configuredCase(caseId,state) : closed();
}

function declarationAdmission(declared: ImageDeclaration, state:Snapshot|null): DeclarationAdmission {
  const caseIds = [...requiredCasesFor(declared.family,declared.requiresSequence)];
  const off: DeclarationAdmission = {...closed(),caseIds,reason:'disabled',currentFingerprint:null};
  if (!state || !caseIds.length) return off;
  const cases = caseIds.map((caseId) => configuredCase(caseId,state));
  const fingerprints = cases[0]!.qualifiedFingerprints.filter((fingerprint) => cases.every((entry) => entry.qualifiedFingerprints.includes(fingerprint)));
  if (!fingerprints.length) return off;
  const enabled = state.health !== null && fingerprints.includes(state.health.buildFingerprint);
  return {enabled,qualifiedFingerprints:fingerprints,maxOriginalBytes:Math.min(...cases.map((entry) => entry.maxOriginalBytes)),caseIds,
    reason:enabled ? null : 'unavailable',currentFingerprint:enabled ? state.health!.buildFingerprint : null};
}

export async function getDeclarationAdmission(declared: ImageDeclaration, env:AppEnv): Promise<DeclarationAdmission> {
  return declarationAdmission(declared,await snapshot(env));
}

export async function getUploadCapabilities(env: AppEnv, event: EventRecord, authority: Pick<UploadAuthority,'kind'>): Promise<UploadCapabilityView> {
  const mimeTypes:string[] = [...LEGACY_UPLOAD_MIME_TYPES];
  const families:ImageFamily[] = ['jpeg','png','webp','heic','heif'];
  let maxOriginalBytes = MAX_IMAGE_BYTES;
  const state = await snapshot(env);
  for (const family of Object.keys(KNOWN_IMAGE_FORMATS) as ImageFamily[]) {
    const format = KNOWN_IMAGE_FORMATS[family];
    const admission = declarationAdmission({family,mimeType:format.mimeType,requiresSequence:false},state);
    if (admission.enabled) {
      if (!mimeTypes.includes(format.mimeType)) mimeTypes.push(format.mimeType);
      if (!families.includes(family)) families.push(family);
      maxOriginalBytes = Math.max(maxOriginalBytes,admission.maxOriginalBytes);
    }
    if (['heic','heif','avif'].includes(family)
      && declarationAdmission({family,mimeType:`image/${family}-sequence`,requiresSequence:true},state).enabled
      && !mimeTypes.includes(`image/${family}-sequence`)) mimeTypes.push(`image/${family}-sequence`);
  }
  const open = !event.deletedAt && (authority.kind === 'guest' ? resolvePhotoIntake(event,new Date()).photosOpen : Date.parse(event.managementAccessExpiresAt) > Date.now());
  return {mimeTypes:open ? mimeTypes : [],extensions:open ? [...new Set(families.flatMap((family) => [...KNOWN_IMAGE_FORMATS[family].extensions]))] : [],
    directMaxBytes:MAX_IMAGE_BYTES,maxOriginalBytes,partBytes:MOBILE_IMAGE_PART_BYTES};
}

export function admittedImageDecoder(env:AppEnv, fingerprints:readonly string[], lane:'upload'|'preview') {
  return new ImageDecoderClient(async (request:Request) => {
    if (!['production','preview'].includes(env.IMAGE_DECODER_ENVIRONMENT)) throw new DecoderError('unavailable');
    const response = await env.IMAGE_DECODER.fetch(request);
    if (response.headers.get('X-Decoder-Environment') !== env.IMAGE_DECODER_ENVIRONMENT) {
      await response.body?.cancel(); throw new DecoderError('unavailable');
    }
    return response;
  },fingerprints,lane);
}

/** Accepted transfers keep their fingerprint when operators narrow new intake. */
export function pinnedImageQualification(declared:ImageDeclaration, fingerprint:string, byteSize:number, isSequence=declared.requiresSequence): boolean {
  const evidence = committedEvidence(); const parsed = releaseSchema.safeParse(evidence.mobile);
  if ((isSequence && !caseCatalog.families[declared.family].sequence.length) || !parsed.success
    || parsed.data.maxOriginalBytes<byteSize || !qualifiedDecoderFingerprints(evidence.decoder,declared.family,isSequence).includes(fingerprint)) return false;
  return requiredCasesFor(declared.family,isSequence).every((caseId) => parsed.data.cases.some((entry) =>
    entry.caseId===caseId && entry.buildFingerprint===fingerprint && entry.maxOriginalBytes>=byteSize));
}

/** Read recovery uses qualified builds even after operators close new intake. */
export function previewDecoderFingerprints(declared:ImageDeclaration, byteSize:number): readonly string[] {
  return qualifiedDecoderFingerprints(committedEvidence().decoder,declared.family,declared.requiresSequence)
    .filter(fingerprint => pinnedImageQualification(declared,fingerprint,byteSize));
}
