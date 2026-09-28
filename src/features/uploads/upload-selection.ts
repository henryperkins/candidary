import { MAX_IMAGE_BYTES } from '../../../shared/constants';
import { canPreviewInBrowser, LEGACY_UPLOAD_MIME_TYPES, resolveImageDeclaration } from '../../../shared/image-formats';
import type { UploadQueueItem } from './upload-queue';
import { MOBILE_IMAGE_PART_BYTES, type UploadCapabilityView } from '../../../shared/mobile-image-contract';

export const IMAGE_ACCEPT = [...LEGACY_UPLOAD_MIME_TYPES, '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].join(',');
export const BASELINE_UPLOAD_CAPABILITIES: UploadCapabilityView = {
  mimeTypes:[...LEGACY_UPLOAD_MIME_TYPES],extensions:['.jpg','.jpeg','.png','.webp','.heic','.heif'],
  directMaxBytes:MAX_IMAGE_BYTES,maxOriginalBytes:MAX_IMAGE_BYTES,partBytes:MOBILE_IMAGE_PART_BYTES,
};
export function imageAccept(capabilities:UploadCapabilityView):string {
  return [...capabilities.mimeTypes,...capabilities.extensions.map(ext => ext.startsWith('.') ? ext : `.${ext}`)].join(',');
}

function validationMessage(file: File, capabilities:UploadCapabilityView): string | null {
  if (file.size < 1) return 'This photo is empty. Choose it again.';
  if (file.size > capabilities.maxOriginalBytes) return `This photo is larger than ${Math.floor(capabilities.maxOriginalBytes/1024**2)} MiB.`;
  const declaration = resolveImageDeclaration(file.name, file.type);
  if (!declaration || !capabilities.mimeTypes.includes(declaration.mimeType)) {
    return 'This photo format is not available for this event. Choose another original.';
  }
  return null;
}

export function createUploadSelection(
  files: FileList,
  isNewCapture: boolean,
  capabilities: UploadCapabilityView = BASELINE_UPLOAD_CAPABILITIES,
): UploadQueueItem[] {
  return Array.from(files).map((file): UploadQueueItem => {
    const error = validationMessage(file,capabilities);
    const declaration = resolveImageDeclaration(file.name, file.type);
    let previewUrl: string | undefined;
    if (!error && declaration && canPreviewInBrowser(declaration.family)
      && typeof URL.createObjectURL === 'function') {
      try {
        previewUrl = URL.createObjectURL(file);
      } catch {
        // A local thumbnail is optional; the original File remains the upload source.
      }
    }
    return {
      id: crypto.randomUUID(),
      file,
      state: error ? 'failed' : 'selected',
      progress: 0,
      isNewCapture,
      ...(error ? { error, validationError: true } : {}),
      ...(previewUrl ? { previewUrl } : {}),
    };
  });
}
