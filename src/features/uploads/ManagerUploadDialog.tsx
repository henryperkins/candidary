import { LoaderCircle, X } from 'lucide-react';
import { useCallback, useEffect, useRef, type RefObject } from 'react';

import type { HostUploadAvailability } from '../../../shared/contracts';
import { ModalSurface } from '../../components/ModalSurface';
import type { LoadFailure } from '../../components/States';
import type { BrowserUploadTransport } from './browser-upload-transport';
import { GuestUploadFlow, type GuestUploadEvent } from './GuestUploadFlow';
import {
  useManagerUploadSession,
  type UploadExitState,
} from './use-manager-upload-session';

export interface ManagerUploadDialogProps {
  eventId: string;
  event: GuestUploadEvent;
  availability: HostUploadAvailability;
  returnFocusRef: RefObject<HTMLElement | null>;
  inertExceptionRef?: RefObject<HTMLElement | null>;
  transport?: BrowserUploadTransport;
  hasUsableAccountCredential: boolean;
  onClose(): void;
  onExitGateChange(state: UploadExitState): void;
  onEscalate(failure: LoadFailure): void;
  onFinalized?: (result: { itemId: string; mediaId: string }) => void;
  onRefreshAfterTerminal?: () => void;
}

const UNAVAILABLE_MESSAGE: Record<Exclude<HostUploadAvailability['reason'], null>, string> = {
  'media-cap': 'This event has reached its photo limit.',
  'storage-cap': 'This event has reached its storage limit.',
  'event-unavailable': 'This event is no longer available for uploads.',
};

function unavailableMessage(availability: HostUploadAvailability): string {
  return availability.reason
    ? UNAVAILABLE_MESSAGE[availability.reason]
    : 'Photos cannot be added right now.';
}

export function ManagerUploadDialog({
  eventId,
  event,
  availability,
  returnFocusRef,
  inertExceptionRef,
  transport,
  hasUsableAccountCredential,
  onClose,
  onExitGateChange,
  onEscalate,
  onFinalized,
  onRefreshAfterTerminal,
}: ManagerUploadDialogProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const retryCleanupRef = useRef<HTMLButtonElement>(null);
  const terminalActionRef = useRef<HTMLButtonElement>(null);
  const receiptActionRef = useRef<HTMLButtonElement>(null);
  const session = useManagerUploadSession({
    eventId,
    uploadsAvailable: availability.enabled,
    transport,
    hasUsableAccountCredential,
    onExitGateChange,
    onEscalate,
    onFinalized,
    onRefreshAfterTerminal,
    onSafeClose: onClose,
  });

  const close = useCallback(() => {
    if (!session.closeAllowed) return;
    session.discardSelection();
    onClose();
  }, [onClose, session]);

  const cleanupRetry = session.cleanupOutcome?.kind === 'retry'
    ? session.cleanupOutcome
    : null;
  const terminal = session.cleanupOutcome?.kind === 'terminal'
    ? session.cleanupOutcome
    : null;

  useEffect(() => {
    if (session.phase === 'cleanup') headingRef.current?.focus();
    else if (session.phase === 'cleanup-retry') retryCleanupRef.current?.focus();
    else if (session.phase === 'terminal') terminalActionRef.current?.focus();
    else if (session.phase === 'receipt') receiptActionRef.current?.focus();
  }, [session.phase]);

  const receiptAction = <button
    ref={receiptActionRef}
    type="button"
    className="button button--primary"
    onClick={close}
  >Done</button>;

  return <ModalSurface
    labelledBy="manager-upload-dialog-title"
    initialFocusRef={headingRef}
    onRequestClose={close}
    closePolicy={{
      escape: session.closeAllowed,
      backdrop: session.closeAllowed,
    }}
    dialogRef={dialogRef}
    inertExceptionRef={inertExceptionRef}
    returnFocusRef={returnFocusRef}
  >
    <div className="modal-backdrop manager-upload-dialog">
      <div className="modal-card manager-upload-dialog__card">
      <header className="manager-upload-dialog__header">
        <h2 id="manager-upload-dialog-title" ref={headingRef} tabIndex={-1}>Add photos</h2>
        {session.closeAllowed && <button
          type="button"
          className="manager-upload-dialog__close"
          aria-label="Close Add photos"
          onClick={close}
        ><X aria-hidden="true" /></button>}
      </header>

      {session.phase === 'cleanup' && <section aria-live="polite" className="state-card">
        <LoaderCircle className="spin" aria-hidden="true" />
        <p>Cleaning up temporary uploads…</p>
      </section>}

      {session.phase === 'cleanup-retry' && cleanupRetry && <section
        className="state-card state-card--error"
        role="alert"
      >
        <p>{cleanupRetry.unresolvedCount} temporary {cleanupRetry.unresolvedCount === 1
          ? 'upload still needs'
          : 'uploads still need'} cleanup.</p>
        {cleanupRetry.deliveredIds.length > 0 && <p>
          {cleanupRetry.deliveredIds.length} delivered {cleanupRetry.deliveredIds.length === 1
            ? 'photo is'
            : 'photos are'} already safe in Intake.
        </p>}
        <button
          ref={retryCleanupRef}
          type="button"
          className="button button--secondary"
          onClick={() => void session.retryCleanup()}
        >Retry cleanup</button>
      </section>}

      {session.phase === 'terminal' && terminal && <section
        className="state-card state-card--error"
        role="alert"
      >
        <p>Temporary uploads will expire automatically.</p>
        <p>No unresolved upload is being described as canceled.</p>
        <button
          ref={terminalActionRef}
          type="button"
          className="button button--secondary"
          onClick={close}
        >
          Return to Intake
        </button>
      </section>}

      {!['cleanup', 'cleanup-retry', 'terminal'].includes(session.phase) && <>
        <GuestUploadFlow
          event={event}
          slug={eventId}
          variant="manager"
          session={session.flow}
          uploadsAvailable={availability.enabled}
          unavailableMessage={unavailableMessage(availability)}
          headingLevel="h3"
          receiptAction={receiptAction}
        />
        {session.phase === 'needs-attention' && <button
          type="button"
          className="button button--secondary send-cancel"
          onClick={() => void session.cancelUploads()}
        >Cancel uploads</button>}
      </>}
      </div>
    </div>
  </ModalSurface>;
}
