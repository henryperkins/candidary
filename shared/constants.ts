export const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_EVENT_MEDIA = 50;
export const MAX_EVENT_BYTES = 300 * 1024 * 1024;
export const UPLOAD_URL_TTL_SECONDS = 10 * 60;
export const UPLOAD_RESERVATION_TTL_SECONDS = 15 * 60;

