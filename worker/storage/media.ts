import { MAX_IMAGE_BYTES } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import type { MediaRecord } from '../db/types';
import type {
  ClaimedMediaPromotion,
  MediaObjectPromotion,
  MediaRepository,
} from '../db/media';
import {
  assertLegacyMediaCopyEnabled,
  assertWorkerIngressEnabled,
} from '../media-upload-release';
import { inspectImageHeader } from '../security/image-metadata';
import { finalizedMediaObjectKey, legacyMediaPreviewObjectKey } from './media-keys';

const MEDIA_INGRESS_LEASE_MS = 20 * 60 * 1_000;

function versionChanged(): ApiError {
  return new ApiError(
    'UPLOAD_FINALIZE_CONFLICT',
    'This upload changed while it was being verified. Try confirming it again.',
    409,
  );
}

function hasBody(object: R2ObjectBody | R2Object | null): object is R2ObjectBody {
  return object !== null && 'body' in object;
}

async function sha256(stream: ReadableStream): Promise<ArrayBuffer> {
  const bytes = await new Response(stream).arrayBuffer();
  return crypto.subtle.digest('SHA-256', bytes);
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', bytes);
}

function imageSignatureMatches(declared: string, inspected: string): boolean {
  return inspected === declared
    || (declared === 'image/heic-sequence' && inspected === 'image/heic')
    || (declared === 'image/heif-sequence' && inspected === 'image/heif');
}

function digestHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);
}

async function rejectReservation(
  bucket: R2Bucket,
  repository: MediaRepository,
  media: MediaRecord,
  error: ApiError,
): Promise<never> {
  await bucket.delete(media.objectKey);
  await repository.failReservation(media.id);
  throw error;
}

export async function finalizeStoredMedia(
  bucket: R2Bucket,
  repository: MediaRepository,
  media: MediaRecord,
  expirationCheckTime = new Date(),
): Promise<MediaRecord> {
  const finalObjectKey = finalizedMediaObjectKey(media.eventId, media.id);
  if (media.uploadState === 'stored') {
    // Cleanup is deliberately scheduled, not response-driven. A presigned PUT
    // issued before finalization remains writable until its recorded horizon;
    // deleting it here would allow a late replay to recreate an untracked key.
    return media;
  }
  if (media.uploadState !== 'reserved') {
    throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This upload can no longer be finalized.', 409);
  }
  if (Date.parse(media.reservationExpiresAt) <= expirationCheckTime.getTime()) {
    return rejectReservation(
      bucket,
      repository,
      media,
      new ApiError('UPLOAD_RESERVATION_EXPIRED', 'This upload reservation expired. Choose the file again.', 409),
    );
  }

  const object = await bucket.head(media.objectKey);
  if (!object) throw new ApiError('UPLOAD_OBJECT_MISSING', 'The uploaded object has not arrived yet.', 409);

  if (object.size > media.declaredByteSize || object.size > MAX_IMAGE_BYTES) {
    return rejectReservation(
      bucket,
      repository,
      media,
      new ApiError('FILE_TOO_LARGE', 'The uploaded image is larger than the reserved size.', 413),
    );
  }
  if (object.httpMetadata?.contentType !== media.mimeType) {
    return rejectReservation(
      bucket,
      repository,
      media,
      new ApiError('FILE_TYPE_UNSUPPORTED', 'The uploaded image type does not match its reservation.', 415),
    );
  }

  const headBytes = await bucket.get(media.objectKey, {
    onlyIf: { etagMatches: object.etag },
    range: { offset: 0, length: Math.min(object.size, 65_536) },
  });
  if (!hasBody(headBytes)) throw versionChanged();
  let metadata;
  try {
    metadata = inspectImageHeader(new Uint8Array(await new Response(headBytes.body).arrayBuffer()));
  } catch {
    return rejectReservation(
      bucket,
      repository,
      media,
      new ApiError('FILE_TYPE_UNSUPPORTED', 'The uploaded file is not a supported image.', 415),
    );
  }
  const signatureMatches = metadata.mimeType === media.mimeType
    || (media.mimeType === 'image/heic-sequence' && metadata.mimeType === 'image/heic')
    || (media.mimeType === 'image/heif-sequence' && metadata.mimeType === 'image/heif');
  if (!signatureMatches) {
    return rejectReservation(
      bucket,
      repository,
      media,
      new ApiError('FILE_TYPE_UNSUPPORTED', 'The uploaded image signature does not match its type.', 415),
    );
  }

  // The full read is conditional on the same version whose header was
  // inspected. R2 object-version reads remain stable while streamed, so a PUT
  // replay that lands before or during this copy cannot substitute new bytes.
  const source = await bucket.get(media.objectKey, { onlyIf: { etagMatches: object.etag } });
  if (!hasBody(source)) throw versionChanged();
  const sourceBytes = await new Response(source.body).arrayBuffer();
  if (sourceBytes.byteLength !== object.size) throw versionChanged();
  const sourceDigest = await sha256Bytes(sourceBytes);
  await repository.ensureFinalObjectWriteTombstone(
    media.id,
    finalObjectKey,
    expirationCheckTime.toISOString(),
  );
  const stored = await bucket.put(finalObjectKey, sourceBytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: media.mimeType },
    sha256: sourceDigest,
  });
  const verifiedFinal = await verifiedFinalObject(
    bucket,
    finalObjectKey,
    object.size,
    media.mimeType,
    sourceDigest,
  );
  if ((stored && stored.size !== object.size) || !verifiedFinal) throw versionChanged();

  let finalized: MediaRecord;
  try {
    finalized = await repository.finalize(media.id, {
      byteSize: object.size,
      width: metadata.width,
      height: metadata.height,
      objectKey: finalObjectKey,
      source: {
        etag: object.etag,
        mimeType: media.mimeType,
        sha256: digestHex(sourceDigest),
        finalEtag: verifiedFinal.etag,
      },
    });
  } catch (error) {
    const current = await repository.getById(media.id);
    if (current?.uploadState === 'stored' && current.objectKey === finalObjectKey) {
      return current;
    }
    // The create-only target remains under the durable reserved-row inventory.
    // A later scheduled pass may adopt it or, after the writable horizon, prove
    // the media inactive before deleting it. A non-atomic compensation delete
    // here could race a committed D1 transition whose response was lost.
    throw error;
  }
  return finalized;
}

export async function receiveMediaUpload(
  canonicalBucket: R2Bucket,
  repository: MediaRepository,
  media: MediaRecord,
  uploaderSessionId: string,
  bytes: ArrayBuffer,
  contentType: string,
  now = new Date(),
): Promise<MediaRecord> {
  assertWorkerIngressEnabled();
  if (media.uploadState === 'stored') return media;
  if (media.uploadState !== 'reserved' || media.deletedAt !== null) {
    throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This upload can no longer receive bytes.', 409);
  }
  if (Date.parse(media.reservationExpiresAt) <= now.getTime()) {
    throw new ApiError('UPLOAD_RESERVATION_EXPIRED', 'This upload reservation expired. Choose the file again.', 409);
  }
  if (contentType !== media.mimeType) {
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'The uploaded image type does not match its reservation.', 415);
  }
  if (bytes.byteLength !== media.declaredByteSize || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ApiError('VALIDATION_FAILED', 'That photo is a different size than the one reserved.', 422);
  }

  let metadata;
  try {
    metadata = inspectImageHeader(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 65_536)));
  } catch {
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'The uploaded file is not a supported image.', 415);
  }
  if (!imageSignatureMatches(media.mimeType, metadata.mimeType)) {
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'The uploaded image signature does not match its type.', 415);
  }

  const sourceDigest = await sha256Bytes(bytes);
  const sha256Hex = digestHex(sourceDigest);
  const claimToken = crypto.randomUUID();
  const claimedAt = now.toISOString();
  const claimed = await repository.claimReservationIngress({
    mediaId: media.id,
    eventId: media.eventId,
    uploaderSessionId,
    sourceObjectKey: media.objectKey,
    mimeType: media.mimeType,
    byteSize: bytes.byteLength,
    sha256: sha256Hex,
    width: metadata.width,
    height: metadata.height,
    claimToken,
    claimedAt,
    leaseExpiresAt: new Date(now.getTime() + MEDIA_INGRESS_LEASE_MS).toISOString(),
  });
  if (!claimed) {
    const current = await repository.getById(media.id);
    if (current?.uploadState === 'stored'
      && current.objectKey === finalizedMediaObjectKey(media.eventId, media.id)) return current;
    throw new ApiError(
      'UPLOAD_FINALIZE_CONFLICT',
      'This upload is already being secured. Wait a moment and try again.',
      409,
    );
  }

  const finalObjectKey = finalizedMediaObjectKey(media.eventId, media.id);
  await repository.ensureFinalObjectWriteTombstone(media.id, finalObjectKey, claimedAt);
  try {
    await canonicalBucket.put(finalObjectKey, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: media.mimeType },
      sha256: sourceDigest,
    });
  } catch (error) {
    // A transport error can arrive after R2 committed. Exact digest verification
    // distinguishes that ambiguous success from a genuine failed write without
    // deleting a deterministic key another invocation may already have adopted.
    if (!await finalObjectMatchesDigest(
      canonicalBucket, finalObjectKey, bytes.byteLength, media.mimeType, sourceDigest,
    )) throw error;
  }
  const verifiedFinal = await verifiedFinalObject(
    canonicalBucket, finalObjectKey, bytes.byteLength, media.mimeType, sourceDigest,
  );
  if (!verifiedFinal) {
    throw new ApiError(
      'UPLOAD_FINALIZE_CONFLICT',
      'This upload conflicts with bytes already secured for the same photo.',
      409,
    );
  }

  const committedAt = new Date().toISOString();
  try {
    if (await repository.commitReservationIngress({
      mediaId: media.id,
      claimToken,
      finalObjectKey,
      byteSize: bytes.byteLength,
      width: metadata.width,
      height: metadata.height,
      finalEtag: verifiedFinal.etag,
      committedAt,
    })) return (await repository.getById(media.id))!;
  } catch (error) {
    const current = await repository.getById(media.id);
    if (current?.uploadState === 'stored' && current.objectKey === finalObjectKey) return current;
    throw error;
  }
  const current = await repository.getById(media.id);
  if (current?.uploadState === 'stored' && current.objectKey === finalObjectKey) return current;
  throw new ApiError(
    'UPLOAD_FINALIZE_CONFLICT',
    'This upload changed while its bytes were being secured. Try again.',
    409,
  );
}

export async function promoteLegacyStoredMediaObject(
  legacyBucket: R2Bucket,
  canonicalBucket: R2Bucket,
  repository: MediaRepository,
  claimed: ClaimedMediaPromotion,
  clock: () => Date = () => new Date(),
): Promise<'verified' | 'pending'> {
  assertLegacyMediaCopyEnabled();
  const { media, promotion } = claimed;
  const claimToken = promotion.claimToken;
  if (!claimToken || promotion.state !== 'copying' || media.byteSize === null) return 'pending';

  // A stale claim with source metadata has already crossed the first canonical
  // PUT attempt boundary. Never discard or replace that digest: the original
  // response may have been lost, and an old signed URL can mutate the legacy
  // alias while the immutable canonical target still contains the validated
  // bytes. Recover/adopt only that exact durable version.
  if (promotion.sourceEtag
    && promotion.sourceMimeType
    && promotion.sourceByteSize !== null
    && promotion.sourceSha256
    && promotion.sourceWidth !== null
    && promotion.sourceHeight !== null) {
    const expectedDigestView = Uint8Array.from(
      promotion.sourceSha256.match(/.{2}/gu) ?? [],
      (pair) => Number.parseInt(pair, 16),
    );
    const expectedDigest = expectedDigestView.buffer.slice(
      expectedDigestView.byteOffset,
      expectedDigestView.byteOffset + expectedDigestView.byteLength,
    ) as ArrayBuffer;
    let verifiedTarget = await verifiedFinalObject(
      canonicalBucket,
      promotion.finalObjectKey,
      promotion.sourceByteSize,
      promotion.sourceMimeType,
      expectedDigest,
    );
    if (!verifiedTarget) {
      const sourceHead = await legacyBucket.head(promotion.sourceObjectKey);
      const exactSource = sourceHead?.etag === promotion.sourceEtag
        && sourceHead.size === promotion.sourceByteSize
        && sourceHead.httpMetadata?.contentType === promotion.sourceMimeType
        ? await legacyBucket.get(promotion.sourceObjectKey, {
            onlyIf: { etagMatches: promotion.sourceEtag },
          })
        : null;
      if (!hasBody(exactSource)) return 'pending';
      const sourceBytes = await new Response(exactSource.body).arrayBuffer();
      if (sourceBytes.byteLength !== promotion.sourceByteSize
        || !equalBytes(await sha256Bytes(sourceBytes), expectedDigest)) return 'pending';
      let metadata;
      try {
        metadata = inspectImageHeader(new Uint8Array(
          sourceBytes,
          0,
          Math.min(sourceBytes.byteLength, 65_536),
        ));
      } catch {
        return 'pending';
      }
      if (!imageSignatureMatches(promotion.sourceMimeType, metadata.mimeType)
        || metadata.width !== promotion.sourceWidth
        || metadata.height !== promotion.sourceHeight) return 'pending';
      await repository.ensureFinalObjectWriteTombstone(
        media.id,
        promotion.finalObjectKey,
        clock().toISOString(),
      );
      await canonicalBucket.put(promotion.finalObjectKey, sourceBytes, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: promotion.sourceMimeType },
        sha256: expectedDigest,
      });
      verifiedTarget = await verifiedFinalObject(
        canonicalBucket,
        promotion.finalObjectKey,
        promotion.sourceByteSize,
        promotion.sourceMimeType,
        expectedDigest,
      );
    }
    if (!verifiedTarget) return 'pending';
    try {
      if (await repository.markPromotionTargetVerified(
        media.id,
        claimToken,
        verifiedTarget.etag,
        clock().toISOString(),
      )) return 'verified';
    } catch (error) {
      const durable = await repository.getPromotion(media.id);
      if (durable?.state === 'target_verified'
        && durable.claimToken === claimToken
        && durable.finalEtag === verifiedTarget.etag) return 'verified';
      throw error;
    }
    return 'pending';
  }

  const sourceHead = await legacyBucket.head(promotion.sourceObjectKey);
  if (
    !sourceHead
    || sourceHead.size !== media.byteSize
    || sourceHead.httpMetadata?.contentType !== media.mimeType
  ) {
    await repository.releasePromotionClaim(media.id, claimToken, clock().toISOString());
    return 'pending';
  }

  const source = await legacyBucket.get(promotion.sourceObjectKey, {
    onlyIf: { etagMatches: sourceHead.etag },
  });
  if (!hasBody(source)) {
    await repository.releasePromotionClaim(media.id, claimToken, clock().toISOString());
    return 'pending';
  }
  const sourceBytes = await new Response(source.body).arrayBuffer();
  if (sourceBytes.byteLength !== sourceHead.size) {
    await repository.releasePromotionClaim(media.id, claimToken, clock().toISOString());
    return 'pending';
  }
  let sourceMetadata;
  try {
    sourceMetadata = inspectImageHeader(new Uint8Array(
      sourceBytes,
      0,
      Math.min(sourceBytes.byteLength, 65_536),
    ));
  } catch {
    await repository.releasePromotionClaim(media.id, claimToken, clock().toISOString());
    return 'pending';
  }
  if (!imageSignatureMatches(media.mimeType, sourceMetadata.mimeType)
    || sourceMetadata.width !== media.width
    || sourceMetadata.height !== media.height) {
    await repository.releasePromotionClaim(media.id, claimToken, clock().toISOString());
    return 'pending';
  }
  const sourceDigest = await sha256Bytes(sourceBytes);
  const sourceSha256 = digestHex(sourceDigest);
  const recordedAt = clock().toISOString();
  if (!await repository.recordPromotionSource(media.id, claimToken, {
    etag: sourceHead.etag,
    mimeType: media.mimeType,
    byteSize: sourceHead.size,
    sha256: sourceSha256,
    width: sourceMetadata.width,
    height: sourceMetadata.height,
    recordedAt,
  })) return 'pending';
  if (!await repository.hasPromotionWritePermit(media.id, claimToken, clock().toISOString())) {
    return 'pending';
  }

  await repository.ensureFinalObjectWriteTombstone(
    media.id,
    promotion.finalObjectKey,
    recordedAt,
  );
  await canonicalBucket.put(promotion.finalObjectKey, sourceBytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: media.mimeType },
    sha256: sourceDigest,
  });
  const verifiedTarget = await verifiedFinalObject(
    canonicalBucket,
    promotion.finalObjectKey,
    sourceHead.size,
    media.mimeType,
    sourceDigest,
  );
  if (!verifiedTarget) {
    // Once a target PUT has been attempted, ownership stays durable. Even a
    // failed response can be ambiguous, and deleting/releasing here could race
    // another invocation that has already adopted the deterministic target.
    return 'pending';
  }

  try {
    if (await repository.markPromotionTargetVerified(
      media.id,
      claimToken,
      verifiedTarget.etag,
      clock().toISOString(),
    )) return 'verified';
  } catch (error) {
    const durable = await repository.getPromotion(media.id);
    if (durable?.state === 'target_verified'
      && durable.claimToken === claimToken
      && durable.finalEtag === verifiedTarget.etag) return 'verified';
    throw error;
  }
  return 'pending';
}

async function finalObjectMatchesDigest(
  bucket: R2Bucket,
  objectKey: string,
  expectedSize: number,
  expectedContentType: string,
  expectedDigest: ArrayBuffer,
): Promise<boolean> {
  return (await verifiedFinalObject(
    bucket,
    objectKey,
    expectedSize,
    expectedContentType,
    expectedDigest,
  )) !== null;
}

async function verifiedFinalObject(
  bucket: R2Bucket,
  objectKey: string,
  expectedSize: number,
  expectedContentType: string,
  expectedDigest: ArrayBuffer,
): Promise<{ etag: string } | null> {
  const object = await bucket.get(objectKey);
  if (!object?.body || object.size !== expectedSize
    || object.httpMetadata?.contentType !== expectedContentType) return null;
  return equalBytes(await sha256(object.body), expectedDigest)
    ? { etag: object.etag }
    : null;
}

export async function cleanupPendingMediaPromotion(
  _bucket: R2Bucket,
  repository: MediaRepository,
  promotion: MediaObjectPromotion,
  now: Date,
): Promise<boolean> {
  const timestamp = now.toISOString();
  if (
    promotion.state !== 'cleanup_pending'
    || !promotion.claimToken
  ) return false;
  const claimToken = promotion.claimToken;
  let work = promotion;
  if (work.finalPointerCommitted && await repository.parkInactivePromotionCleanup(
    work.mediaId,
    claimToken,
    timestamp,
  )) {
    const parked = await repository.getPromotion(work.mediaId);
    if (!parked) return true;
    work = parked;
  }
  // The finite writer fence is retired only in the same D1 transaction that
  // permanently suppresses every alias it owned. R2 deletion happens later in
  // the recurring tombstone janitor; a delayed old PUT therefore remains
  // discoverable even after media/event relational rows have been purged.
  return repository.handoffPromotionToPermanentSuppression(
    work.mediaId,
    claimToken,
    timestamp,
  );
}

export async function cleanupInactiveMediaPromotion(
  _bucket: R2Bucket,
  repository: MediaRepository,
  claimed: ClaimedMediaPromotion,
  now: Date,
): Promise<boolean> {
  const claimToken = claimed.promotion.claimToken;
  if (!claimToken || claimed.promotion.sourceWritableUntil > now.toISOString()) return false;
  // This state transition is the D1 proof that no active legacy row can adopt
  // this deterministic target. Only after it commits is final-key deletion a
  // safe compensation; source cleanup then uses the same two-pass quiescence.
  if (!await repository.parkInactivePromotionCleanup(
    claimed.promotion.mediaId,
    claimToken,
    now.toISOString(),
  )) return false;
  return repository.handoffPromotionToPermanentSuppression(
    claimed.promotion.mediaId,
    claimToken,
    now.toISOString(),
  );
}

export async function deleteMediaObjectAliases(
  legacyBucket: R2Bucket,
  canonicalBucket: R2Bucket,
  repository: MediaRepository,
  beforeDelete: MediaRecord,
): Promise<void> {
  const deleted = await repository.getById(beforeDelete.id);
  if (!deleted || deleted.uploadState !== 'deleted' || deleted.deletedAt === null) {
    throw new Error('Media object cleanup requires a durable deleted row.');
  }
  // The durable promotion row is also deletion cleanup inventory. The route's
  // attempt is latency only; hourly recovery owns eventual verified deletion.
  if (await repository.getPromotion(beforeDelete.id)) return;
  const legacyKeys = new Set<string>([
    legacyMediaPreviewObjectKey(beforeDelete.eventId, beforeDelete.id),
  ]);
  const canonicalKeys = new Set<string>([
    finalizedMediaObjectKey(beforeDelete.eventId, beforeDelete.id),
  ]);
  (beforeDelete.objectBucketGeneration === 'canonical' ? canonicalKeys : legacyKeys)
    .add(beforeDelete.objectKey);
  (deleted.objectBucketGeneration === 'canonical' ? canonicalKeys : legacyKeys)
    .add(deleted.objectKey);
  if (beforeDelete.previewObjectKey) legacyKeys.add(beforeDelete.previewObjectKey);
  if (deleted.previewObjectKey) legacyKeys.add(deleted.previewObjectKey);
  await Promise.all([
    legacyBucket.delete([...legacyKeys]),
    canonicalBucket.delete([...canonicalKeys]),
  ]);
  for (const [bucket, keys] of [
    [legacyBucket, legacyKeys],
    [canonicalBucket, canonicalKeys],
  ] as const) {
    for (const key of keys) {
      if (await bucket.head(key)) throw new Error('Deleted media object remained in storage.');
    }
  }
}
