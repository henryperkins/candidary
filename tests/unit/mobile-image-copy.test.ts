import { describe,expect,it } from 'vitest';
import { CREATE_INTRO,LANDING_QUESTIONS } from '../../shared/site-content';
import { uploadCapabilitySummary } from '../../shared/mobile-image-contract';
import { BASELINE_UPLOAD_CAPABILITIES } from '../../src/features/uploads/upload-selection';
import { ApiError,toErrorResponse,type ApiErrorCode } from '../../shared/errors';
import { failureDecisionForCode } from '../../shared/load-failure';
import { managerUploadTerminalReason } from '../../src/features/uploads/manager-upload-terminal-codes';
import { DecoderError,parseDecoderFailure } from '../../shared/image-decoder-contract';

describe('mobile image admission copy and sanitized failures',() => {
  it('keeps static pages conservative and uses binary image-size units',() => {
    const copy=JSON.stringify([CREATE_INTRO,LANDING_QUESTIONS]);
    expect(copy).toContain('20 MiB'); expect(copy).not.toMatch(/20 MB|DNG|JPEG XL|all (?:image|photo) formats|universal/i);
    expect(copy).toContain('event');
  });
  it('describes only admitted formats and limits without changing read/export promises',() => {
    const baseline=uploadCapabilitySummary(BASELINE_UPLOAD_CAPABILITIES);
    expect(baseline).toContain('20 MiB'); expect(baseline).not.toContain('DNG');
    expect(uploadCapabilitySummary({...BASELINE_UPLOAD_CAPABILITIES,mimeTypes:['image/dng'],maxOriginalBytes:512*1024**2})).toBe('DNG · up to 512 MiB per original.');
    expect(uploadCapabilitySummary({...BASELINE_UPLOAD_CAPABILITIES,mimeTypes:[]})).toBe('Photo uploads are paused for this event.');
  });
  it.each([['IMAGE_PROCESSING_UNAVAILABLE',503],['IMAGE_RESOURCE_LIMIT',413],['IMAGE_PREVIEW_UNAVAILABLE',503],['UPLOAD_PART_CONFLICT',409],['UPLOAD_TRANSFER_EXPIRED',409]] as const)('keeps %s a scoped recoverable error', (code,status) => {
    const result=toErrorResponse(new ApiError(code as ApiErrorCode,'Choose the original again.',status),'request-1');
    expect(result).toEqual({status,body:{code,message:'Choose the original again.',requestId:'request-1'}});
    expect(failureDecisionForCode(code).kind).toBe('retry');
    expect(managerUploadTerminalReason(code as ApiErrorCode)).toBeNull();
  });
  it('never forwards native error text or an unknown decoder failure',() => {
    expect(toErrorResponse(new Error('private source path and raw stderr'),'request-1').body).toEqual({code:'INTERNAL_ERROR',message:expect.not.stringMatching(/private|stderr/),requestId:'request-1'});
    expect(toErrorResponse(new DecoderError('unavailable'),'request-1').body.code).toBe('INTERNAL_ERROR');
    expect(parseDecoderFailure({code:'run-a-command',stderr:'private'})).toBe('unavailable');
  });
});
