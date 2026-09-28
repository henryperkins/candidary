import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUploadSelection } from '../../src/features/uploads/upload-selection';

const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn(() => 'blob:photo') });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
  else Reflect.deleteProperty(URL, 'createObjectURL');
});

function select(...files: File[]) {
  return createUploadSelection(Object.assign(files, { item: (index: number) => files[index] ?? null }) as unknown as FileList, false);
}

describe('thumbnail-independent photo selection', () => {
  it('selects an admitted DNG while the baseline capability keeps it unavailable', () => {
    const file=new File(['original'],'photo.dng',{type:'image/dng'}); const files=[file] as unknown as FileList;
    expect(createUploadSelection(files,false)[0]!.state).toBe('failed');
    const capability={mimeTypes:['image/dng'],extensions:['.dng'],directMaxBytes:20*1024**2,maxOriginalBytes:512*1024**2,partBytes:8*1024**2};
    const result=createUploadSelection(files,false,capability)[0]!;
    expect(result.state).toBe('selected'); expect(result.file).toBe(file); expect(result.previewUrl).toBeUndefined();
  });
  it('keeps the original file selected when an object URL cannot be created', () => {
    const file = new File(['original'], 'photo.jpg', { type: 'image/jpeg' });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('unavailable'); });
    const [item] = select(file);
    expect(item).toMatchObject({ state: 'selected', isNewCapture: false });
    expect(item?.previewUrl).toBeUndefined();
    expect(item?.file).toBe(file);
  });

  it('does not lose the rest of a selection when only one thumbnail fails', () => {
    const files = ['a.jpg', 'b.jpg', 'c.jpg'].map((name) => new File([name], name, { type: 'image/jpeg' }));
    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:a')
      .mockImplementationOnce(() => { throw new Error('unavailable'); })
      .mockReturnValueOnce('blob:c');
    const items = select(...files);
    expect(items.map((item) => item.state)).toEqual(['selected', 'selected', 'selected']);
    expect(items.map((item) => item.previewUrl)).toEqual(['blob:a', undefined, 'blob:c']);
    items.forEach((item, index) => expect(item.file).toBe(files[index]));
  });

  it('selects an empty-MIME JPEG and a HEIC original without requiring native HEIC rendering', () => {
    const jpeg = new File(['jpeg'], 'PHOTO.JPG');
    const heic = new File(['heic'], 'photo.heic', { type: 'image/heic' });
    const items = select(jpeg, heic);
    expect(items.map((item) => item.state)).toEqual(['selected', 'selected']);
    expect(items[0]?.file).toBe(jpeg);
    expect(items[1]?.file).toBe(heic);
    expect(items[1]?.previewUrl).toBeUndefined();
    expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(jpeg);
  });
});
