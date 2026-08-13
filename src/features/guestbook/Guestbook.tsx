import { ArrowRight, ChevronDown, MessageCircle } from 'lucide-react';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { GuestEventView, GuestGuestbookItem } from '../../../shared/contracts';
import { api, ClientApiError, mediaPreview } from '../../app/api';
import {
  appendGuestbookItems,
  isSameGuestbookDraft,
  type GuestbookPage,
  type GuestbookReadStatus,
  type GuestbookSubmission,
  type GuestbookSubmissionIntent,
  type GuestbookSubmitStatus,
  guestbookItemKey,
  guestbookPrivacyLabel,
  guestbookSourceLabel,
  guestbookStateLabel,
  prependGuestbookItem,
} from './guestbook-state';

interface GuestbookProps {
  event: GuestEventView;
  contributionEnabled: boolean;
  guestName: string;
  onGuestNameChange: (name: string) => void;
  openRequest: number;
}

function calmFailure(caught: unknown, fallback: string): string {
  if (!(caught instanceof ClientApiError)) return fallback;
  const retryAfter = retryAfterGuidance(caught.retryAfterMs);
  const reference = caught.requestId ? ` Reference ${caught.requestId}.` : '';
  return `${caught.message}${retryAfter}${reference}`;
}

function retryAfterGuidance(retryAfterMs: number | null | undefined): string {
  if (!retryAfterMs || retryAfterMs < 0) return '';
  const seconds = Math.ceil(retryAfterMs / 1_000);
  if (seconds < 60) {
    return ` Try again in about ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
  }
  const minutes = Math.ceil(seconds / 60);
  return ` Try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

function remainingCharacters(count: number): string {
  return count === 1 ? '1 character left' : `${count} characters left`;
}

function formatContributedAt(item: GuestGuestbookItem, eventTimezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: eventTimezone,
    }).format(new Date(item.createdAt));
  } catch {
    return item.createdAt;
  }
}

export function Guestbook({
  event,
  contributionEnabled,
  guestName,
  onGuestNameChange,
  openRequest,
}: GuestbookProps) {
  const [opened, setOpened] = useState(false);
  const [readStatus, setReadStatus] = useState<GuestbookReadStatus>('idle');
  const [feedError, setFeedError] = useState<string | null>(null);
  const [sharedItems, setSharedItems] = useState<GuestGuestbookItem[]>([]);
  const [privateItems, setPrivateItems] = useState<GuestGuestbookItem[]>([]);
  const [ownUnsharedCount, setOwnUnsharedCount] = useState(0);
  const [sharedCursor, setSharedCursor] = useState<string | null>(null);
  const [privateCursor, setPrivateCursor] = useState<string | null>(null);
  const [sharedEarlierBusy, setSharedEarlierBusy] = useState(false);
  const [privateEarlierBusy, setPrivateEarlierBusy] = useState(false);
  const [sharedEarlierError, setSharedEarlierError] = useState<string | null>(null);
  const [privateEarlierError, setPrivateEarlierError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [explicitlyUnsigned, setExplicitlyUnsigned] = useState(false);
  const [editingSignature, setEditingSignature] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<GuestbookSubmitStatus>('idle');
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [submissionKey, setSubmissionKey] = useState<string>(() => crypto.randomUUID());
  const [failedIntent, setFailedIntent] = useState<GuestbookSubmissionIntent | null>(null);
  const [rotateConflictOnRetry, setRotateConflictOnRetry] = useState(false);
  const [submissionDisabled, setSubmissionDisabled] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const loadTicket = useRef(0);
  const lifetimeTicket = useRef(0);
  const readControllers = useRef(new Set<AbortController>());
  const lastOpenRequest = useRef(openRequest);
  const pendingFocusRequest = useRef<number | null>(null);
  const signedName = explicitlyUnsigned ? null : guestName.trim() || null;

  const loadFirstPage = useCallback(async (confirmedItem?: GuestGuestbookItem) => {
    const ticket = ++loadTicket.current;
    const controller = new AbortController();
    readControllers.current.add(controller);
    setReadStatus('loading');
    setFeedError(null);
    setSharedEarlierBusy(false);
    setPrivateEarlierBusy(false);
    setSharedEarlierError(null);
    setPrivateEarlierError(null);
    try {
      const page = await api<GuestbookPage>(`/api/event/${event.slug}/messages?contract=2`, {
        signal: controller.signal,
      });
      if (loadTicket.current !== ticket) return;
      let shared = page.items;
      let own = page.ownUnshared;
      if (confirmedItem) {
        if (confirmedItem.visibility === 'shared') shared = prependGuestbookItem(shared, confirmedItem);
        else own = prependGuestbookItem(own, confirmedItem);
      }
      setSharedItems(shared);
      setPrivateItems(own);
      setOwnUnsharedCount(confirmedItem?.visibility === 'author_only'
        ? Math.max(1, page.ownUnsharedCount)
        : page.ownUnsharedCount);
      setSharedCursor(page.nextCursor);
      setPrivateCursor(page.ownUnsharedNextCursor);
      setReadStatus('ready');
    } catch (caught) {
      if (loadTicket.current !== ticket) return;
      setFeedError(calmFailure(
        caught,
        'The guestbook could not be loaded. Check your connection and try again.',
      ));
      setReadStatus('retryable_error');
    } finally {
      readControllers.current.delete(controller);
    }
  }, [event.slug]);

  useEffect(() => {
    if (!opened) return;
    void loadFirstPage();
  }, [loadFirstPage, opened]);

  useEffect(() => {
    if (openRequest === lastOpenRequest.current) return;
    lastOpenRequest.current = openRequest;
    pendingFocusRequest.current = openRequest;
    setOpened(true);
  }, [openRequest]);

  useEffect(() => {
    const request = pendingFocusRequest.current;
    if (!opened || request === null) return;
    const frame = requestAnimationFrame(() => {
      if (pendingFocusRequest.current !== request) return;
      const heading = headingRef.current;
      if (!heading) return;
      pendingFocusRequest.current = null;
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      heading.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      heading.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [openRequest, opened]);

  useEffect(() => () => {
    loadTicket.current += 1;
    lifetimeTicket.current += 1;
    for (const controller of readControllers.current) controller.abort();
    readControllers.current.clear();
  }, []);

  useEffect(() => {
    if (!failedIntent || isSameGuestbookDraft(failedIntent, body.trim(), signedName)) return;
    setSubmissionKey(crypto.randomUUID());
    setFailedIntent(null);
    setSubmitStatus('idle');
    setSubmitMessage(null);
    setRotateConflictOnRetry(false);
    setConfirmationOpen(false);
  }, [body, failedIntent, signedName]);

  function clearDraftFeedback() {
    setSubmitStatus('idle');
    setSubmitMessage(null);
    setRotateConflictOnRetry(false);
    setConfirmationOpen(false);
  }

  function updateBody(value: string) {
    if (value !== body) clearDraftFeedback();
    setBody(value);
  }

  function updateRememberedName(value: string) {
    if (value !== guestName) clearDraftFeedback();
    setExplicitlyUnsigned(false);
    onGuestNameChange(value);
  }

  function leaveUnsigned() {
    if (!explicitlyUnsigned) clearDraftFeedback();
    setExplicitlyUnsigned(true);
    setEditingSignature(false);
  }

  function startConfirmation(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) {
      setSubmitStatus('invalid');
      setSubmitMessage('Write a note before sending it.');
      noteInputRef.current?.focus();
      return;
    }
    setBody(trimmed);
    if (failedIntent && !isSameGuestbookDraft(failedIntent, trimmed, signedName)) {
      setSubmissionKey(crypto.randomUUID());
      setFailedIntent(null);
      setRotateConflictOnRetry(false);
    }
    setSubmitStatus('idle');
    setSubmitMessage(null);
    setConfirmationOpen(true);
  }

  async function sendNote() {
    if (submitStatus === 'sending' || submissionDisabled) return;
    const lifetime = lifetimeTicket.current;
    const submittedBody = body.trim();
    const submittedName = signedName;
    const sameFailedIntent = failedIntent
      ? isSameGuestbookDraft(failedIntent, submittedBody, submittedName)
      : false;
    let key = sameFailedIntent && failedIntent ? failedIntent.idempotencyKey : submissionKey;
    if (
      rotateConflictOnRetry
      || (failedIntent && !sameFailedIntent)
    ) {
      key = crypto.randomUUID();
      setSubmissionKey(key);
    }
    setConfirmationOpen(false);
    setSubmitStatus('sending');
    setSubmitMessage(null);
    try {
      const result = await api<GuestbookSubmission>(`/api/event/${event.slug}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: submittedBody, guestName: submittedName, idempotencyKey: key }),
      });
      if (lifetimeTicket.current !== lifetime) return;
      const item = result.item;
      if (item.visibility === 'shared') {
        setSharedItems((current) => prependGuestbookItem(current, item));
        setPrivateItems((current) => current.filter((candidate) => guestbookItemKey(candidate) !== guestbookItemKey(item)));
      } else {
        setPrivateItems((current) => prependGuestbookItem(current, item));
        setOwnUnsharedCount((current) => Math.max(1, current + (current === 0 ? 1 : 0)));
      }
      setBody('');
      setExplicitlyUnsigned(false);
      setEditingSignature(false);
      setSubmissionKey(crypto.randomUUID());
      setFailedIntent(null);
      setRotateConflictOnRetry(false);
      setSubmitStatus('confirmed_success');
      setSubmitMessage(`Safely sent to ${event.name}.`);
      void loadFirstPage(item);
    } catch (caught) {
      if (lifetimeTicket.current !== lifetime) return;
      if (caught instanceof ClientApiError) {
        if (caught.code === 'MESSAGE_SUBMISSION_CONFLICT') setRotateConflictOnRetry(true);
        if (caught.code === 'MESSAGE_EVENT_LIMIT' || caught.code === 'EVENT_PHASE_CONFLICT') {
          setSubmissionDisabled(true);
        }
      }
      setFailedIntent({ body: submittedBody, effectiveGuestName: submittedName, idempotencyKey: key });
      setSubmitStatus('retryable_error');
      setSubmitMessage(calmFailure(
        caught,
        'Your note was not sent. Check your connection and try again.',
      ));
    }
  }

  async function loadEarlier(stream: 'shared' | 'private') {
    const cursor = stream === 'shared' ? sharedCursor : privateCursor;
    if (!cursor) return;
    const lifetime = lifetimeTicket.current;
    const firstPageTicket = loadTicket.current;
    const controller = new AbortController();
    readControllers.current.add(controller);
    const setBusy = stream === 'shared' ? setSharedEarlierBusy : setPrivateEarlierBusy;
    const setError = stream === 'shared' ? setSharedEarlierError : setPrivateEarlierError;
    setBusy(true);
    setError(null);
    try {
      const cursorName = stream === 'shared' ? 'cursor' : 'ownCursor';
      const page = await api<GuestbookPage>(
        `/api/event/${event.slug}/messages?contract=2&${cursorName}=${encodeURIComponent(cursor)}`,
        { signal: controller.signal },
      );
      if (lifetimeTicket.current !== lifetime || loadTicket.current !== firstPageTicket) return;
      if (stream === 'shared') {
        setSharedItems((current) => appendGuestbookItems(current, page.items));
        setSharedCursor(page.nextCursor);
      } else {
        setPrivateItems((current) => appendGuestbookItems(current, page.ownUnshared));
        setOwnUnsharedCount(page.ownUnsharedCount);
        setPrivateCursor(page.ownUnsharedNextCursor);
      }
    } catch (caught) {
      if (lifetimeTicket.current !== lifetime || loadTicket.current !== firstPageTicket) return;
      setError(calmFailure(caught, 'Earlier entries could not be loaded. Try again.'));
    } finally {
      readControllers.current.delete(controller);
      if (lifetimeTicket.current === lifetime && loadTicket.current === firstPageTicket) setBusy(false);
    }
  }

  function renderEntry(item: GuestGuestbookItem) {
    const privacy = guestbookPrivacyLabel(item);
    return <li key={guestbookItemKey(item)}>
      <article className="guestbook-entry">
        {item.source === 'photo_caption'
          && <img className="guestbook-entry__thumbnail" src={mediaPreview(item.mediaId)} alt="" loading="lazy" />}
        <div className="guestbook-entry__body">
          <p dir="auto">{item.body}</p>
          <div className="guestbook-entry__meta">
            <small dir="auto"><bdi>{item.guestName || 'Unsigned'}</bdi> · {guestbookSourceLabel(item)} · {formatContributedAt(item, event.eventTimezone)}</small>
            <span className="status">{guestbookStateLabel(item)}</span>
          </div>
          {item.isOwn && <strong className="guestbook-entry__own">Your entry</strong>}
          {privacy && <small className="guestbook-entry__privacy">{privacy}</small>}
        </div>
      </article>
    </li>;
  }

  return <details
    ref={detailsRef}
    className="event-extra guestbook"
    open={opened}
    onToggle={(toggle) => setOpened(toggle.currentTarget.open)}
  >
    <summary><span>Guestbook <small>{contributionEnabled ? 'Read or leave a note' : 'Read entries'}</small></span><ChevronDown aria-hidden="true" /></summary>
    {opened && <div className="event-extra__content guestbook__content">
      <div className="guestbook__intro">
        <MessageCircle aria-hidden="true" />
        <h3 ref={headingRef} tabIndex={-1}>Leave a note for <bdi>{event.name}</bdi></h3>
        <p dir="auto">{event.guestbookPrompt}</p>
        <p className="guestbook__privacy">This event-private book is visible to current guests only after the hosts share an entry. Your display name is not a verified identity.</p>
      </div>

      {contributionEnabled && !submissionDisabled && <section className="guestbook-composer" aria-labelledby="guestbook-composer-heading">
        <h4 id="guestbook-composer-heading" className="sr-only">Write a guestbook note</h4>
        <div className="guestbook-signature">
          {editingSignature ? <label>
            <span>Name for this and future contributions</span>
            <input
              autoComplete="name"
              dir="auto"
              maxLength={80}
              value={guestName}
              onChange={(change) => updateRememberedName(change.currentTarget.value)}
              onBlur={() => onGuestNameChange(guestName.trim())}
            />
          </label> : signedName
            ? <p><span>Signed as <bdi>{signedName}</bdi></span> <button type="button" className="text-button" onClick={() => setEditingSignature(true)}>Change</button> <button type="button" className="text-button" onClick={leaveUnsigned}>Leave unsigned</button></p>
            : <p><span>Unsigned</span> <button type="button" className="text-button" onClick={() => { setExplicitlyUnsigned(false); setEditingSignature(true); }}>Add your name</button></p>}
        </div>
        <form className="note-form" onSubmit={startConfirmation} aria-busy={submitStatus === 'sending'}>
          <label>
            <span className="note-form__label">Your note for <bdi>{event.name}</bdi></span>
            <textarea
              ref={noteInputRef}
              name="body"
              rows={4}
              maxLength={500}
              required
              dir="auto"
              readOnly={submitStatus === 'sending'}
              value={body}
              aria-invalid={submitStatus === 'invalid'}
              aria-describedby="guestbook-note-help guestbook-submit-feedback"
              placeholder="Share a wish or memory…"
              onChange={(change) => updateBody(change.currentTarget.value)}
            />
          </label>
          <div className="note-form__footer">
            <small id="guestbook-note-help">{remainingCharacters(500 - body.length)}</small>
            <button type="submit" className="button button--primary" disabled={submitStatus === 'sending'}>
              Send note <ArrowRight aria-hidden="true" />
            </button>
          </div>
        </form>
        {confirmationOpen && <div className="guestbook-confirmation" role="group" aria-label="Confirm guestbook note">
          <p>{signedName ? <>Send this note signed as <bdi>{signedName}</bdi>?</> : 'Send this note unsigned?'}</p>
          <div>
            <button type="button" className="button button--primary" onClick={() => void sendNote()}>Confirm and send</button>
            <button type="button" className="button button--secondary" onClick={() => setConfirmationOpen(false)}>Keep editing</button>
          </div>
        </div>}
        <div id="guestbook-submit-feedback" className="note-submit-feedback" aria-live="polite" aria-atomic="true">
          {submitStatus === 'confirmed_success' && <p role="status">{submitMessage}</p>}
          {(submitStatus === 'retryable_error' || submitStatus === 'invalid') && <div>
            <p className="note-submit-feedback__error" role="alert">{submitMessage}</p>
            {submitStatus === 'retryable_error' && <button type="button" className="button button--secondary" onClick={() => void sendNote()}>Retry</button>}
          </div>}
        </div>
      </section>}

      {contributionEnabled && submissionDisabled && <p className="guestbook-composer-closed" role="status">New notes are closed for this event right now. The guestbook remains available to read.</p>}

      <div className="guestbook-reading">
        {readStatus === 'loading' && <p className="guestbook-feed-state" role="status">{sharedItems.length || privateItems.length ? 'Refreshing the guestbook…' : 'Opening the guestbook…'}</p>}
        {readStatus === 'retryable_error' && <div className="notes-feed__recovery">
          <p role="alert">{feedError}</p>
          <button type="button" className="button button--secondary" onClick={() => void loadFirstPage()}>Try again</button>
        </div>}

        {ownUnsharedCount > 0 && <section className="guestbook-section" aria-labelledby="guestbook-private-heading">
          <h4 id="guestbook-private-heading">Your private entries</h4>
          <p>Visible only in this guest session and to the hosts until shared.</p>
          {privateItems.length > 0 && <ul className="notes-feed">{privateItems.map(renderEntry)}</ul>}
          {privateCursor && <div className="notes-feed__more">
            <button type="button" className="button button--secondary" disabled={privateEarlierBusy} onClick={() => void loadEarlier('private')}>
              {privateEarlierBusy ? 'Loading earlier private entries…' : 'Show earlier private entries'}
            </button>
            {privateEarlierError && <p role="alert">{privateEarlierError}</p>}
          </div>}
        </section>}

        <section className="guestbook-section" aria-labelledby="guestbook-shared-heading">
          <h4 id="guestbook-shared-heading">Shared guestbook</h4>
          {readStatus === 'ready' && sharedItems.length === 0
            && <p className="guestbook-feed-state">No entries have been shared yet.</p>}
          {sharedItems.length > 0 && <ul className="notes-feed">{sharedItems.map(renderEntry)}</ul>}
          {sharedCursor && <div className="notes-feed__more">
            <button type="button" className="button button--secondary" disabled={sharedEarlierBusy} onClick={() => void loadEarlier('shared')}>
              {sharedEarlierBusy ? 'Loading earlier shared entries…' : 'Show earlier shared entries'}
            </button>
            {sharedEarlierError && <p role="alert">{sharedEarlierError}</p>}
          </div>}
        </section>
      </div>
    </div>}
  </details>;
}
