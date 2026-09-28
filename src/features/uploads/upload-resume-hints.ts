import type { UploadQueueItem } from './upload-queue';
import { MAX_IMAGE_BYTES } from '../../../shared/constants';
import { isLegacyUploadMimeType, resolveImageDeclaration } from '../../../shared/image-formats';
import { MAX_MOBILE_ORIGINAL_BYTES } from '../../../shared/mobile-image-contract';
type Hint = {id:string;name:string;size:number;type:string;expiresAt:number;reservation?:UploadQueueItem['reservation']};
const key = (root:string) => `candidary.upload-resume.v1:${root}`;
// Only tab-scoped metadata is kept. A hint is never authority or proof of bytes;
// the authenticated server checks the selected File before it can adopt a receipt.
function read(root:string):Hint[] {
  try {
    const parsed:unknown = JSON.parse(sessionStorage.getItem(key(root)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-100).filter((h):h is Hint => h && typeof h === 'object'
      && typeof h.id === 'string' && h.id.length <= 128 && typeof h.name === 'string' && h.name.length <= 1024
      && typeof h.type === 'string' && Number.isSafeInteger(h.size) && h.size > 0 && h.size <= MAX_MOBILE_ORIGINAL_BYTES
      && Number.isFinite(h.expiresAt) && h.expiresAt > Date.now());
  } catch {return [];}
}
function write(root:string,hints:Hint[]) {
  try {if (hints.length) sessionStorage.setItem(key(root),JSON.stringify(hints.slice(-100))); else sessionStorage.removeItem(key(root));}
  catch { /* Selection and uploads work when browser storage is unavailable. */ }
}
export function rememberUploads(root:string,items:readonly UploadQueueItem[]):void {
  const hints=new Map(read(root).map(h => [h.id,h]));
  for (const item of items) {
    if (item.state === 'delivered') {hints.delete(item.id); continue;}
    const declaration=resolveImageDeclaration(item.file.name,item.file.type);
    if (item.validationError || !declaration || (isLegacyUploadMimeType(declaration.mimeType) && item.file.size <= MAX_IMAGE_BYTES)) continue;
    if (item.state === 'selected' && !hints.has(item.id)) continue;
    const reservation=item.reservation?.transfer ? {...item.reservation,uploadUrl:''} : undefined;
    hints.set(item.id,{id:item.id,name:item.file.name,size:item.file.size,type:item.file.type,
      expiresAt:reservation ? Date.parse(reservation.transfer!.hardExpiresAt) : hints.get(item.id)?.expiresAt ?? Date.now()+6*3600_000,
      ...(reservation ? {reservation} : {})});
  }
  write(root,[...hints.values()]);
}
export function forgetUploads(root:string,ids:readonly string[]):void {write(root,read(root).filter(h => !ids.includes(h.id)));}
export function restoreUploadHints(root:string,items:UploadQueueItem[],usedIds:readonly string[]=[]):UploadQueueItem[] {
  const used=new Set(usedIds); const hints=read(root);
  return items.map(item => {
    const hint=hints.find(h => !used.has(h.id) && h.name === item.file.name && h.size === item.file.size && h.type === item.file.type);
    if (!hint) return item;
    used.add(hint.id);
    const reservation=hint.reservation?.transfer && typeof hint.reservation.mediaId === 'string'
      && hint.reservation.transfer.mediaId === hint.reservation.mediaId && typeof hint.reservation.transfer.id === 'string'
      ? {...hint.reservation,uploadUrl:''} : undefined;
    return {...item,id:hint.id,state:'selected',validationError:undefined,error:undefined,
      retryStage:undefined,reservation,resumed:true};
  });
}
export function hasUploadHints(root:string):boolean {return read(root).length > 0;}
export function resumeImageAccept(root:string):string {
  return [...new Set(read(root).flatMap(h => {
    const declaration=resolveImageDeclaration(h.name,h.type);
    const suffix=h.name.toLowerCase().match(/\.(?:dng|jxl|avif|tiff?|heic|heif|jpe?g|png|webp|gif)$/u)?.[0];
    return declaration ? [declaration.mimeType,...(suffix ? [suffix] : [])] : [];
  }))].join(',');
}
