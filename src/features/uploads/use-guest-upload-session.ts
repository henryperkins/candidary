import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uploadCapabilitySummary } from '../../../shared/mobile-image-contract';

import { createBrowserTransport } from './browser-upload-transport';
import type { UploadFlowSession } from './GuestUploadFlow';
import { createUploadSelection, imageAccept } from './upload-selection';
import { useUploadCapabilities } from './use-upload-capabilities';
import { rememberUploads,forgetUploads,restoreUploadHints,hasUploadHints,resumeImageAccept } from './upload-resume-hints';
import {
  getReceiptCount,
  removeQueueItem,
  runUploadQueue,
  type UploadQueueItem,
  type UploadTransport,
} from './upload-queue';

interface UseGuestUploadSessionOptions {
  slug: string;
  guestName: string;
  uploadsAvailable: boolean;
  transport?: UploadTransport;
  onDelivered?: (count: number) => void;
}

export function useGuestUploadSession({
  slug,
  guestName,
  uploadsAvailable,
  transport,
  onDelivered,
}: UseGuestUploadSessionOptions): UploadFlowSession {
  const root = `/api/event/${encodeURIComponent(slug)}/uploads`;
  const capabilities = useUploadCapabilities(root, !transport && uploadsAvailable);
  const accept = [imageAccept(capabilities),resumeImageAccept(root)].filter(Boolean).join(',');
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [sending, setSending] = useState(false);
  const itemsRef = useRef(items);
  const availableRef = useRef(uploadsAvailable);
  const nameRef = useRef(guestName);
  const mountedRef = useRef(true);
  const objectUrls = useRef(new Set<string>());
  const uploadController = useRef<AbortController | null>(null);
  const queuePromise = useRef<Promise<UploadQueueItem[]> | null>(null);
  const notifiedReceipt = useRef<number | null>(null);
  availableRef.current = uploadsAvailable;
  nameRef.current = guestName;

  const publish = useCallback((next: UploadQueueItem[]) => {
    rememberUploads(root,next);
    itemsRef.current = next;
    if (mountedRef.current) setItems(next);
  }, [root]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      uploadController.current?.abort();
      uploadController.current = null;
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrls.current.clear();
    };
  }, []);

  const receiptCount = getReceiptCount(items) ?? 0;
  useEffect(() => {
    if (receiptCount > 0 && notifiedReceipt.current !== receiptCount) {
      notifiedReceipt.current = receiptCount;
      onDelivered?.(receiptCount);
    }
  }, [onDelivered, receiptCount]);

  const adoptFiles = useCallback((files: FileList | null, isNewCapture: boolean) => {
    if (!files?.length || !availableRef.current) return;
    const selected = restoreUploadHints(root,createUploadSelection(files, isNewCapture,capabilities),itemsRef.current.map(item => item.id));
    for (const item of selected) {
      if (item.previewUrl) objectUrls.current.add(item.previewUrl);
    }
    publish([...itemsRef.current, ...selected]);
  }, [publish,root,capabilities]);

  const removeItem = useCallback((itemId: string) => {
    forgetUploads(root,[itemId]);
    const target = itemsRef.current.find((item) => item.id === itemId);
    if (target?.previewUrl) {
      URL.revokeObjectURL(target.previewUrl);
      objectUrls.current.delete(target.previewUrl);
    }
    publish(removeQueueItem(itemsRef.current, itemId));
  }, [publish,root]);

  const canRemoveItem = useCallback((itemId: string) => {
    const target = itemsRef.current.find((item) => item.id === itemId);
    return target ? target.state === 'selected' || target.state === 'failed' : false;
  }, []);

  const send = useCallback(async () => {
    if (!availableRef.current || queuePromise.current) return;
    const controller = new AbortController();
    uploadController.current = controller;
    if (mountedRef.current) setSending(true);
    const activeTransport = transport ?? createBrowserTransport({
      kind: 'guest',
      slug,
      guestName: nameRef.current,
    });
    const request = runUploadQueue(itemsRef.current, activeTransport, {
      concurrency: 2,
      onChange: publish,
      signal: controller.signal,
    });
    queuePromise.current = request;
    try {
      publish(await request);
    } finally {
      if (queuePromise.current === request) queuePromise.current = null;
      if (uploadController.current === controller) uploadController.current = null;
      if (mountedRef.current) setSending(false);
    }
  }, [publish, slug, transport]);

  const cancel = useCallback(async () => {
    uploadController.current?.abort();
    await queuePromise.current?.catch(() => undefined);
  }, []);

  return useMemo(() => ({
    imageAccept: accept,
    selectionHint: uploadCapabilitySummary(capabilities),
    hasResumeHints: hasUploadHints(root),
    items,
    sending,
    receiptCount,
    adoptFiles,
    canRemoveItem,
    removeItem,
    send,
    cancel,
  }), [accept,root,capabilities,adoptFiles, canRemoveItem, cancel, items, receiptCount, removeItem, send, sending]);
}
