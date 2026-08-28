import { MAX_IMAGE_BYTES } from '../../../shared/constants';
import type { UploadQueueItem } from './upload-queue';

export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,image/heic-sequence,image/heif-sequence,.heic,.heif';

const CLIENT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_IMAGE_TYPES = new Set([
  ...CLIENT_IMAGE_TYPES,
  'image/jpg',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);
const PROVISIONAL_HEIF_TYPES = new Map([
  ['', null],
  ['application/octet-stream', null],
  ['binary/octet-stream', null],
  ['image/x-heic', 'heic'],
  ['image/x-heic-sequence', 'heic'],
  ['image/x-heif', 'heif'],
  ['image/x-heif-sequence', 'heif'],
]);

function validationMessage(file: File): string | null {
  if (file.size < 1) return 'This photo is empty. Choose it again.';
  if (file.size > MAX_IMAGE_BYTES) return 'This photo is larger than 20 MB.';
  const extension = file.name.toLowerCase().split('.').pop();
  const normalizedType = file.type.toLowerCase();
  const expectedExtension = PROVISIONAL_HEIF_TYPES.get(normalizedType);
  const provisionalHeif = PROVISIONAL_HEIF_TYPES.has(normalizedType)
    && (extension === 'heic' || extension === 'heif')
    && (!expectedExtension || extension === expectedExtension);
  if (!ALLOWED_IMAGE_TYPES.has(normalizedType) && !provisionalHeif) {
    return 'Choose a JPG, PNG, WebP, HEIC, or HEIF photo.';
  }
  return null;
}

export function createUploadSelection(
  files: FileList,
  isNewCapture: boolean,
): UploadQueueItem[] {
  return Array.from(files).map((file): UploadQueueItem => {
    const error = validationMessage(file);
    const previewUrl = CLIENT_IMAGE_TYPES.has(file.type)
      && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(file)
      : undefined;
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
