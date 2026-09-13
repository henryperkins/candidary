import { describe, expect, it } from 'vitest';
import { emptySelection, selectAll, togglePhoto, isPhotoSelected, toPhotoExportSource, editingIds } from '../../src/features/gallery/photo-export-selection';

describe('photo export selection', () => {
  it('keeps an all-results descriptor and exclusions across unloaded pages', () => {
    const all = selectAll({ scope: 'library', filter: { order: 'oldest', query: 'dance' } });
    const next = togglePhoto(all, 'photo-a');
    expect(toPhotoExportSource(next)).toEqual({ mode: 'all', scope: 'library', filter: { order: 'oldest', query: 'dance' }, excludedMediaIds: ['photo-a'] });
    expect(isPhotoSelected(next, 'unloaded')).toBe(true);
    expect(isPhotoSelected(next, 'photo-a')).toBe(false);
    expect(editingIds(next)).toBeNull();
  });
  it('allows 10,000 explicit exports but never truncates an editing request', () => {
    let state = emptySelection('album');
    for (let i = 0; i < 10000; i++) state = togglePhoto(state, `p${i}`);
    expect(toPhotoExportSource(state).mode).toBe('ids');
    expect(() => togglePhoto(state, 'overflow')).toThrow(/10,000/);
    expect(editingIds(state)).toBeNull();
    expect(editingIds(togglePhoto(emptySelection('library'), 'one'))).toEqual(['one']);
  });
});
