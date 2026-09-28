import type { UploadMediaView } from './contracts';

export type PreviewState = 'pending' | 'ready' | 'unavailable' | 'unsupported';
export type TransferState = 'receiving' | 'processing' | 'retryable' | 'delivered' | 'rejected' | 'aborted' | 'expired';
export type UploadCapabilityView = {
  mimeTypes: string[];
  extensions: string[];
  directMaxBytes: number;
  maxOriginalBytes: number;
  partBytes: number;
};
export type UploadTransferView = {
  id: string; mediaId: string; state: TransferState; partBytes: number; partCount: number;
  acceptedParts: number[]; expiresAt: string; hardExpiresAt: string; previewState: PreviewState;
};
export type UploadTransferOutcome = { transfer: UploadTransferView; media?: UploadMediaView };
export const MAX_MOBILE_ORIGINAL_BYTES = 512 * 1024 ** 2;
export const MOBILE_IMAGE_PART_BYTES = 8 * 1024 ** 2;
export function uploadCapabilitySummary(capabilities:UploadCapabilityView):string {
  const names:Record<string,string> = {'image/jpeg':'JPEG','image/png':'PNG','image/webp':'WebP','image/heic':'HEIC','image/heic-sequence':'HEIC',
    'image/heif':'HEIF','image/heif-sequence':'HEIF','image/dng':'DNG','image/avif':'AVIF','image/avif-sequence':'AVIF',
    'image/gif':'GIF','image/tiff':'TIFF','image/bmp':'BMP','image/jp2':'JPEG 2000','image/jxl':'JPEG XL'};
  const formats=[...new Set(capabilities.mimeTypes.map(type => names[type]).filter(Boolean))];
  if (!formats.length) return 'Photo uploads are paused for this event.';
  const bytes=capabilities.maxOriginalBytes;
  const limit=bytes%(1024**2) === 0 ? `${bytes/(1024**2)} MiB` : `${bytes.toLocaleString('en-US')} bytes`;
  return `${formats.join(', ')} · up to ${limit} per original.`;
}
