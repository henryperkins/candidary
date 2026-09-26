import { describe, expect, it } from 'vitest';
import { canPreviewInBrowser, imageDeclarationMatches, resolveImageDeclaration, type ImageEvidence } from '../../shared/image-formats';
import { createUploadSelection } from '../../src/features/uploads/upload-selection';

const still = (family: ImageEvidence['family']): ImageEvidence => ({ family, width: 10, height: 8, frameCount: 1, primaryIndex: 0, isSequence: false });

describe('image declarations', () => {
  it.each([
    ['IMG.JPG', '', 'selected'], ['IMG.PNG', 'application/octet-stream', 'selected'],
    ['IMG.WEBP', 'binary/octet-stream', 'selected'], ['IMG.PNG', 'image/x-png', 'selected'],
    ['IMG.DNG', 'image/dng', 'failed'], ['IMG.AVIF', '', 'failed'], ['IMG.JPG', 'application/pdf', 'failed'],
  ])('selects %s with %s provisionally without changing the File', (name, type, state) => {
    const file = new File([new Uint8Array([1, 2, 3])], name, { type });
    const files = { 0: file, length: 1, item: () => file } as unknown as FileList;
    const [selected] = createUploadSelection(files, false);
    expect(selected?.state).toBe(state);
    expect(selected?.file).toBe(file);
    if (selected?.previewUrl) URL.revokeObjectURL(selected.previewUrl);
  });

  it.each([
    ['IMG.JPG', '', 'image/jpeg'], ['IMG.JPEG', 'application/octet-stream', 'image/jpeg'],
    ['IMG.PNG', '', 'image/png'], ['IMG.WEBP', 'binary/octet-stream', 'image/webp'],
    ['IMG.HEIC', '', 'image/heic'], ['IMG.HEIF', 'application/octet-stream', 'image/heif'],
    ['IMG.jpg', 'image/jpg', 'image/jpeg'], ['IMG.png', 'image/x-png', 'image/png'],
    ['wrong.jpg', 'image/x-heic', 'image/heic'], ['IMG.heif', 'image/x-heif', 'image/heif'],
    ['burst.heic', 'image/x-heic-sequence', 'image/heic-sequence'],
    ['burst.heif', 'image/x-heif-sequence', 'image/heif-sequence'],
    ['IMG.heic', ' IMAGE/JPEG ', 'image/jpeg'],
    ['raw.DNG', 'image/x-adobe-dng', 'image/dng'], ['raw.DNG', '', 'image/dng'],
    ['photo.AVIF', '', 'image/avif'], ['photo.gif', 'image/gif', 'image/gif'],
    ['photo.TIF', '', 'image/tiff'], ['photo.bmp', '', 'image/bmp'],
    ['photo.JP2', '', 'image/jp2'], ['photo.jxl', '', 'image/jxl'],
  ])('resolves %s with %s without using a contradictory extension', (filename, mime, expected) => {
    expect(resolveImageDeclaration(filename, mime)?.mimeType).toBe(expected);
  });

  it.each([['photo.jpg', 'application/pdf'], ['photo.heic', 'video/quicktime'], ['photo.jpg.exe', ''], ['no-extension', '']])(
    'does not reinterpret %s with %s as an image', (filename, mime) => {
      expect(resolveImageDeclaration(filename, mime)).toBeNull();
    },
  );

  it('accepts HEVC for a generic HEIF declaration without accepting AVIF or JPEG', () => {
    const declared = { family: 'heif' as const, mimeType: 'image/heif', requiresSequence: false };
    expect(imageDeclarationMatches(declared, still('heic'))).toBe(true);
    expect(imageDeclarationMatches(declared, still('avif'))).toBe(false);
    expect(imageDeclarationMatches(declared, still('jpeg'))).toBe(false);
    expect(imageDeclarationMatches({ ...declared, family: 'heic', mimeType: 'image/heic' }, still('heif'))).toBe(false);
  });

  it('requires sequence evidence only for an explicit sequence declaration', () => {
    const sequence = { ...still('heic'), frameCount: 3, isSequence: true };
    const explicit = resolveImageDeclaration('burst.heic', 'image/heic-sequence');
    expect(explicit).not.toBeNull();
    expect(imageDeclarationMatches(explicit!, still('heic'))).toBe(false);
    expect(imageDeclarationMatches(explicit!, sequence)).toBe(true);
    expect(imageDeclarationMatches({ family: 'heic', mimeType: 'image/heic', requiresSequence: false }, sequence)).toBe(true);
  });

  it('offers local thumbnails only for the conservative browser raster set', () => {
    expect(['jpeg', 'png', 'webp'].map((family) => canPreviewInBrowser(family as ImageEvidence['family']))).toEqual([true, true, true]);
    expect(['heic', 'heif', 'dng', 'avif', 'jxl'].map((family) => canPreviewInBrowser(family as ImageEvidence['family']))).toEqual([false, false, false, false, false]);
  });
});
