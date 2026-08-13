export function mediaReservationObjectKey(eventId: string, mediaId: string): string {
  return `events/${eventId}/uploads/${mediaId}`;
}

export function finalizedMediaObjectKey(eventId: string, mediaId: string): string {
  return `events/${eventId}/media/final/${mediaId}`;
}

export function legacyMediaPreviewObjectKey(eventId: string, mediaId: string): string {
  return `events/${eventId}/previews/${mediaId}.webp`;
}
