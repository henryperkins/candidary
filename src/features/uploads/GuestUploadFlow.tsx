import { AlertCircle, Camera, Check, Image as ImageIcon, Images, LoaderCircle, Pencil, RotateCcw, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import type { GuestEventCoverView } from '../../../shared/event-cover';
import { guestEventCoverSlotPath } from '../../app/api';
import { DATE_UNAVAILABLE, formatEventDate } from '../../app/event-date-time';
import { readGuestName, rememberGuestName } from '../../app/guest-name-storage';
import { GuestEventHero } from '../../components/GuestEventHero';
import type { UploadQueueItem, UploadQueueState } from './upload-queue';
import { IMAGE_ACCEPT } from './upload-selection';

export interface GuestUploadEvent {
  name: string;
  eventDate: string;
  welcomeMessage: string;
  uploadsEnabled: boolean;
  cover: GuestEventCoverView;
}

export interface UploadFlowSession {
  readonly items: readonly UploadQueueItem[];
  readonly sending: boolean;
  readonly receiptCount: number;
  adoptFiles(files: FileList | null, isNewCapture: boolean): void;
  canRemoveItem(itemId: string): boolean;
  removeItem(itemId: string): void;
  send(): Promise<void>;
  cancel(): Promise<void>;
}

export interface GuestUploadFlowProps {
  event: GuestUploadEvent;
  slug: string;
  session: UploadFlowSession;
  uploadsAvailable: boolean;
  unavailableMessage: string;
  variant?: 'guest' | 'manager';
  guestName?: string;
  onGuestNameChange?: (name: string) => void;
  onLeaveGuestbook?: () => void;
  headingLevel?: 'h1' | 'h2' | 'h3';
  receiptAction?: ReactNode;
}

function statusLabel(state: UploadQueueState, progress: number) {
  if (state === 'uploading') return `Sending · ${progress}%`;
  if (state === 'reserving') return 'Getting ready';
  if (state === 'queued') return 'Waiting to send';
  if (state === 'finalizing') return 'Confirming delivery';
  if (state === 'delivered') return 'Delivered';
  if (state === 'failed') return 'Needs attention';
  return 'Selected';
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

export function GuestUploadFlow({
  event,
  slug,
  session,
  uploadsAvailable,
  unavailableMessage,
  variant = 'guest',
  guestName,
  onGuestNameChange,
  onLeaveGuestbook,
  headingLevel = variant === 'manager' ? 'h3' : 'h1',
  receiptAction,
}: GuestUploadFlowProps) {
  const [fallbackName, setFallbackName] = useState(readGuestName);
  const manager = variant === 'manager';
  const name = manager ? 'Host' : guestName ?? fallbackName;
  const [editingName, setEditingName] = useState(!manager && !name);
  const [nameError, setNameError] = useState('');
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const { items, sending, receiptCount } = session;
  const Heading = headingLevel;

  function updateName(value: string) {
    if (manager) return;
    if (guestName === undefined) setFallbackName(value);
    onGuestNameChange?.(value);
  }

  function saveName(): string | null {
    if (manager) return 'Host';
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Enter your name before adding photos.');
      setEditingName(true);
      nameInput.current?.focus();
      requestAnimationFrame(() => nameInput.current?.focus());
      return null;
    }
    updateName(trimmed);
    setNameError('');
    setEditingName(false);
    if (!onGuestNameChange) rememberGuestName(trimmed);
    return trimmed;
  }

  function openSource(input: HTMLInputElement | null) {
    if (!uploadsAvailable || !saveName()) return;
    input?.click();
  }

  function adoptFiles(files: FileList | null, isNewCapture: boolean) {
    if (!uploadsAvailable || !saveName()) return;
    session.adoptFiles(files, isNewCapture);
  }

  async function sendSelected() {
    if (!uploadsAvailable || !saveName()) return;
    await session.send();
  }

  const unresolvedCount = items.filter(({ state, validationError }) =>
    !validationError && (state === 'selected' || state === 'failed')).length;
  const attemptedFailureCount = items.filter(({ state, validationError }) =>
    !validationError && state === 'failed').length;
  const failedCount = items.filter(({ state }) => state === 'failed').length;
  const validationFailureCount = items.filter(({ validationError }) => validationError).length;
  const onlyValidationFailures = items.length > 0 && validationFailureCount === items.length;
  const reviewMode = items.length > 0;
  const eventDate = formatEventDate(event.eventDate, 'compact') ?? DATE_UNAVAILABLE;

  if (receiptCount > 0) {
    return <section className="photo-drop photo-drop--receipt" aria-live="polite">
      <div className="delivery-receipt">
        <span className="delivery-receipt__check"><Check aria-hidden="true" /></span>
        <p className="delivery-receipt__eyebrow">
          {manager ? `Added to ${event.name}` : `Delivered to ${event.name}`}
        </p>
        <Heading>{manager
          ? <>{receiptCount} {plural(receiptCount, 'photo')} {receiptCount === 1 ? 'was' : 'were'} added.</>
          : <>Your {receiptCount} {plural(receiptCount, 'photo')} {receiptCount === 1 ? 'was' : 'were'} sent.</>}
        </Heading>
        {validationFailureCount > 0 && <p className="delivery-receipt__caveat">
          {validationFailureCount} {plural(validationFailureCount, 'photo')} could not be added.
        </p>}
        <p>{manager
          ? 'The delivered photos are now in Intake.'
          : <>Thanks, {name}. You’re all done and can close this page.</>}
        </p>
        {!manager && onLeaveGuestbook && <button
          type="button"
          className="button button--secondary delivery-receipt__guestbook"
          onClick={onLeaveGuestbook}
        >Leave a guestbook note</button>}
        {receiptAction}
      </div>
    </section>;
  }

  return <section className={`photo-drop${reviewMode ? ' photo-drop--review' : ''}`}>
    {!manager && !reviewMode && <GuestEventHero
      event={event}
      sourceFor={(slot) => guestEventCoverSlotPath(slug, slot)}
      lookup={false}
    />}

    <div className="photo-drop__card">
      {reviewMode && <header className="review-heading">
        <p>{event.name} <span aria-hidden="true">·</span> {eventDate}</p>
        <p>{manager ? 'From Host' : `Sending as ${name}`}</p>
        <Heading>{manager
          ? sending ? 'Adding photos' : 'Ready to add'
          : sending ? 'Sending photos' : 'Ready to send'}
        </Heading>
        {!manager && <button
          type="button"
          className="text-button"
          onClick={() => setEditingName(true)}
          disabled={sending}
        ><Pencil aria-hidden="true" /> Edit name</button>}
      </header>}

      {!manager && (editingName ? <label className="photo-drop__name">
        <span>Your name <strong>Required</strong></span>
        <input
          ref={nameInput}
          value={name}
          maxLength={80}
          autoComplete="name"
          aria-label="Your name"
          aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? 'guest-name-error' : undefined}
          placeholder="Taylor Morgan"
          onChange={(change) => { updateName(change.target.value); setNameError(''); }}
          onBlur={() => { if (name.trim()) saveName(); }}
        />
      </label> : !reviewMode && <div className="sending-as">
        <span>Sending as {name}</span>
        <button
          type="button"
          className="text-button"
          aria-label="Edit name"
          onClick={() => setEditingName(true)}
        ><Pencil aria-hidden="true" /> Edit</button>
      </div>)}
      {manager && !reviewMode && <div className="sending-as"><span>From Host</span></div>}
      {nameError && <p className="field-error" id="guest-name-error" role="alert">
        <AlertCircle aria-hidden="true" /> {nameError}
      </p>}

      {!reviewMode ? <div className="photo-source-actions">
        <button
          type="button"
          className="source-button source-button--camera"
          disabled={!uploadsAvailable}
          onClick={() => openSource(cameraInput.current)}
        ><Camera aria-hidden="true" /> Take a photo</button>
        <button
          type="button"
          className="source-button source-button--library"
          disabled={!uploadsAvailable}
          onClick={() => openSource(libraryInput.current)}
        ><Images aria-hidden="true" /> Choose recent photos</button>
        <p>{uploadsAvailable
          ? manager ? 'Photos are added privately to Intake.' : 'No account needed. Your name is remembered here.'
          : unavailableMessage}
        </p>
      </div> : <>
        <ul className="selection-grid" aria-label="Selected photos" aria-live="polite">
          {items.map((item) => <li key={item.id} className={`selection-card selection-card--${item.state}`}>
            <div className="selection-card__image">
              {item.previewUrl
                ? <img src={item.previewUrl} alt="" />
                : <ImageIcon aria-hidden="true" />}
              {item.isNewCapture && <span className="new-badge">New</span>}
              {['selected', 'failed'].includes(item.state) && <button
                type="button"
                aria-label={`Remove ${item.file.name}`}
                onClick={() => session.removeItem(item.id)}
                disabled={sending || !session.canRemoveItem(item.id)}
              ><X aria-hidden="true" /></button>}
              {['reserving', 'queued', 'uploading', 'finalizing'].includes(item.state) && <span className="selection-card__spinner">
                <LoaderCircle aria-hidden="true" />
              </span>}
              {item.state === 'delivered' && <span className="selection-card__delivered">
                <Check aria-hidden="true" />
              </span>}
            </div>
            <div className="selection-card__status">
              <strong>{item.file.name}</strong>
              <span>{statusLabel(item.state, item.progress)}</span>
              {item.error && <small>{item.error}</small>}
              {item.state === 'uploading' && <progress
                max="100"
                value={item.progress}
                aria-label={`Sending ${item.file.name}`}
              />}
            </div>
          </li>)}
        </ul>
        <div className="selection-add-actions">
          <button
            type="button"
            className="source-button source-button--library"
            disabled={sending || !uploadsAvailable}
            onClick={() => openSource(libraryInput.current)}
          ><Images aria-hidden="true" /> Add recent photos</button>
          <button
            type="button"
            className="text-button"
            disabled={sending || !uploadsAvailable}
            onClick={() => openSource(cameraInput.current)}
          ><RotateCcw aria-hidden="true" /> Retake a photo</button>
        </div>
        {!uploadsAvailable && <p className="field-error" role="alert">
          <AlertCircle aria-hidden="true" /> {unavailableMessage}
        </p>}
        <div className="selection-summary">
          <span>{items.length} {plural(items.length, 'photo')} selected</span>
          {failedCount > 0 && <span className="selection-summary__attention">
            {failedCount} {plural(failedCount, 'needs', 'need')} attention
          </span>}
        </div>
        {(sending || unresolvedCount > 0) && <button
          type="button"
          className="send-button"
          disabled={sending || !uploadsAvailable}
          onClick={() => void sendSelected()}
        >{sending
            ? <><LoaderCircle aria-hidden="true" /> {manager ? 'Adding…' : 'Sending…'}</>
            : `${attemptedFailureCount > 0 ? 'Retry' : 'Send'} ${unresolvedCount} ${plural(unresolvedCount, 'photo')}`}
        </button>}
        {sending && <button
          type="button"
          className="text-button send-cancel"
          onClick={() => void session.cancel()}
        >{manager ? 'Cancel uploads' : 'Cancel sending'}</button>}
        <p className="progress-note">{!uploadsAvailable
          ? unavailableMessage
          : onlyValidationFailures
            ? 'Remove or replace the photos that need attention.'
            : manager
              ? 'Keep this dialog open while your photos transfer.'
              : 'Keep this page open while your photos transfer.'}
        </p>
      </>}

      <input
        ref={cameraInput}
        className="sr-only"
        hidden
        data-photo-source="camera"
        type="file"
        accept={IMAGE_ACCEPT}
        capture="environment"
        aria-label="Take a photo from your camera"
        onChange={(change) => {
          adoptFiles(change.currentTarget.files, true);
          change.currentTarget.value = '';
        }}
      />
      <input
        ref={libraryInput}
        className="sr-only"
        hidden
        data-photo-source="library"
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        aria-label="Choose recent photos from your library"
        onChange={(change) => {
          adoptFiles(change.currentTarget.files, false);
          change.currentTarget.value = '';
        }}
      />
    </div>
  </section>;
}
