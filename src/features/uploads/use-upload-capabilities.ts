import { useEffect,useState } from 'react';
import { api } from '../../app/api';
import { MAX_MOBILE_ORIGINAL_BYTES,MOBILE_IMAGE_PART_BYTES,type UploadCapabilityView } from '../../../shared/mobile-image-contract';
import { KNOWN_IMAGE_MIME_TYPES } from '../../../shared/image-formats';
import { BASELINE_UPLOAD_CAPABILITIES } from './upload-selection';

export function useUploadCapabilities(root:string,enabled:boolean):UploadCapabilityView {
  const [capabilities,setCapabilities]=useState(BASELINE_UPLOAD_CAPABILITIES);
  useEffect(() => {
    setCapabilities(BASELINE_UPLOAD_CAPABILITIES);
    if (!enabled) return;
    let controller:AbortController | undefined;
    const refresh=async () => {
      controller?.abort(); const active=new AbortController(); controller=active;
      try {
        const value=await api<UploadCapabilityView>(`${root}/capabilities`,{signal:active.signal});
        if (!Array.isArray(value.mimeTypes) || !Array.isArray(value.extensions)
          || value.partBytes !== MOBILE_IMAGE_PART_BYTES || !Number.isSafeInteger(value.maxOriginalBytes)
          || value.maxOriginalBytes < BASELINE_UPLOAD_CAPABILITIES.maxOriginalBytes || value.maxOriginalBytes > MAX_MOBILE_ORIGINAL_BYTES
          || value.directMaxBytes !== BASELINE_UPLOAD_CAPABILITIES.directMaxBytes
          || value.mimeTypes.some(type => !(KNOWN_IMAGE_MIME_TYPES as readonly string[]).includes(type))
          || value.extensions.some(ext => typeof ext !== 'string' || !/^\.?[a-z0-9]+$/u.test(ext))) throw new Error('Invalid capabilities.');
        if (!active.signal.aborted) setCapabilities(value);
      } catch {if (!active.signal.aborted) setCapabilities(BASELINE_UPLOAD_CAPABILITIES);}
    };
    const visible=() => {if (document.visibilityState === 'visible') void refresh();};
    void refresh(); window.addEventListener('online',refresh); document.addEventListener('visibilitychange',visible);
    return () => {controller?.abort(); window.removeEventListener('online',refresh); document.removeEventListener('visibilitychange',visible);};
  },[root,enabled]);
  return capabilities;
}
