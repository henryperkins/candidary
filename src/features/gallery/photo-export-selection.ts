import { MANAGER_BULK_SELECTION_MAX } from '../../../shared/constants';
import { PHOTO_EXPORT_MAX_IDS, type PhotoExportSource } from '../../../shared/photo-exports';

export type PhotoExportSelection = PhotoExportSource;
export const emptySelection = (scope: 'library' | 'album'): PhotoExportSelection => ({ mode: 'ids', scope, mediaIds: [] });
export function selectAll(input: { scope: 'library'; filter: Extract<PhotoExportSource, { scope: 'library'; mode: 'all' }>['filter'] } | { scope: 'album' }): PhotoExportSelection {
  return { mode: 'all', ...input, excludedMediaIds: [] };
}
export function isPhotoSelected(selection: PhotoExportSelection, id: string): boolean {
  return selection.mode === 'ids' ? selection.mediaIds.includes(id) : !selection.excludedMediaIds.includes(id);
}
export function togglePhoto(selection: PhotoExportSelection, id: string): PhotoExportSelection {
  const ids = selection.mode === 'ids' ? selection.mediaIds : selection.excludedMediaIds;
  const next = ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
  if (next.length > PHOTO_EXPORT_MAX_IDS) throw new RangeError('Select up to 10,000 photos per export. Clear some selections to continue.');
  return selection.mode === 'ids' ? { ...selection, mediaIds: next } : { ...selection, excludedMediaIds: next };
}
export function toPhotoExportSource(selection: PhotoExportSelection): PhotoExportSource {
  return selection.mode === 'ids' ? { ...selection, mediaIds: [...selection.mediaIds] } : { ...selection, excludedMediaIds: [...selection.excludedMediaIds] };
}
/** Null means that an editing write cannot represent this selection; never take a prefix. */
export function editingIds(selection: PhotoExportSelection): string[] | null {
  return selection.mode === 'ids' && selection.mediaIds.length <= MANAGER_BULK_SELECTION_MAX ? [...selection.mediaIds] : null;
}
export function selectionLabel(selection: PhotoExportSelection): string {
  return selection.mode === 'ids' ? `${selection.mediaIds.length.toLocaleString()} selected`
    : `All matching photos${selection.excludedMediaIds.length ? ` except ${selection.excludedMediaIds.length.toLocaleString()}` : ''}`;
}
