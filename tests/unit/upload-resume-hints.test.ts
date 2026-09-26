import { beforeEach,describe,expect,it,vi,afterEach } from 'vitest';
import { rememberUploads,forgetUploads,restoreUploadHints,hasUploadHints } from '../../src/features/uploads/upload-resume-hints';
import { createUploadSelection } from '../../src/features/uploads/upload-selection';
import type { UploadQueueItem } from '../../src/features/uploads/upload-queue';
const root='/api/event/example/uploads';
function file(name='original.dng') {return new File(['private original bytes'],name,{type:'image/dng'});}
function selection(f=file()) {return createUploadSelection([f] as unknown as FileList,false);}
function pending():UploadQueueItem { return {...selection()[0]!,id:'resume-id',state:'reserving',validationError:false,error:undefined}; }
beforeEach(() => sessionStorage.clear());
afterEach(() => vi.useRealTimers());
describe('reload upload hints',() => {
  it('recovers the idempotency key after a lost reservation response using the newly selected File',() => {
    rememberUploads(root,[pending()]); const selected=file();
    const restored=restoreUploadHints(root,selection(selected));
    expect(restored[0]).toMatchObject({id:'resume-id',state:'selected',validationError:undefined});
    expect(restored[0]!.file).toBe(selected);
    expect(hasUploadHints(root)).toBe(true);
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).not.toContain('private original bytes');
    expect(restoreUploadHints('/api/event/another/uploads',selection())[0]!.id).not.toBe('resume-id');
  });
  it('never duplicates one hint across a selection and removes it on delivery or discard',() => {
    rememberUploads(root,[pending()]);
    expect(restoreUploadHints(root,[...selection(),...selection()]).filter(item => item.id==='resume-id')).toHaveLength(1);
    expect(restoreUploadHints(root,selection(),['resume-id'])[0]!.id).not.toBe('resume-id');
    rememberUploads(root,[{...pending(),state:'delivered'}]); expect(hasUploadHints(root)).toBe(false);
    rememberUploads(root,[pending()]); forgetUploads(root,['resume-id']); expect(hasUploadHints(root)).toBe(false);
  });
  it('expires hints and tolerates unavailable browser storage without losing selection',() => {
    vi.useFakeTimers(); rememberUploads(root,[pending()]); vi.advanceTimersByTime(6*60*60*1000+1);
    expect(hasUploadHints(root)).toBe(false);
    const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(() => {throw new Error('Unavailable');});
    expect(() => rememberUploads(root,[pending()])).not.toThrow(); spy.mockRestore();
  });
});
