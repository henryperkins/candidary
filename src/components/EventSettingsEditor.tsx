import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { KeyboardEvent, Ref } from 'react';

import type { EventView } from '../../shared/contracts';
import {
  DEFAULT_GUESTBOOK_PROMPT,
  MAX_GUESTBOOK_PROMPT_LENGTH,
} from '../../shared/constants';
import { api, ClientApiError } from '../app/api';
import {
  createAutosaveQueue,
  type AutosaveFailure,
  type AutosaveHandle,
  type AutosaveOutcome,
  type AutosaveQueue,
  type AutosaveState,
  type DomainAutosaveState,
} from '../features/settings/autosave-queue';
import {
  canonicalEventSettings,
  draftFromEvent,
  eventSettingsKey,
  EVENT_SETTINGS_FIELDS,
  EVENT_SETTINGS_LABELS,
  validateEventSettings,
  type EventSettingsDraft,
  type EventSettingsField,
  type EventSettingsPayload,
} from '../features/settings/event-settings-draft';
import { AutosaveStatus } from './AutosaveStatus';
import { describeLoadFailure } from './States';

const DOMAIN_LABEL = 'Event settings';

/** A roster race that has already been refused twice for the same intent. It is
 *  something the host can retry by hand, not a field they can fix, so it must
 *  not become a field error and must not re-enqueue itself. */
class RosterRaceExhausted extends Error {
  constructor(readonly refusal: ClientApiError) { super(refusal.message); }
}

interface ServerFieldError {
  message: string;
  // The edit generation of the field this error names. A later edit of that
  // field retires it; editing anything else must not.
  generation: number;
  // Set for an RSVP refusal, which the roster version owns rather than the
  // control the host can see. A newer version retires it and revalidates.
  rosterVersion: number | null;
}

type FieldGenerations = Record<EventSettingsField, number>;

interface EditorState {
  confirmed: EventSettingsDraft;
  rosterVersion: number;
  draft: EventSettingsDraft;
  generations: FieldGenerations;
  serverErrors: Partial<Record<EventSettingsField, ServerFieldError>>;
}

interface EventSettingsSave {
  payload: EventSettingsPayload;
  generations: FieldGenerations;
}

type ScheduleFields = Pick<
  EventSettingsDraft,
  'eventTimezone' | 'eventStartTime' | 'rsvpDeadlineDate'
>;

function scheduleKey(settings: ScheduleFields): string {
  return JSON.stringify([
    settings.eventTimezone,
    settings.eventStartTime,
    settings.rsvpDeadlineDate,
  ]);
}

function zeroGenerations(): FieldGenerations {
  return {
    name: 0, welcomeMessage: 0, guestbookPrompt: 0, eventTimezone: 0, eventStartTime: 0,
    rsvpDeadlineDate: 0, rsvpEnabled: 0, galleryVisible: 0, moderationRequired: 0,
  };
}

function initialState(event: EventView): EditorState {
  const confirmed = draftFromEvent(event);
  return {
    confirmed,
    rosterVersion: event.rsvpRosterVersion,
    draft: confirmed,
    generations: zeroGenerations(),
    serverErrors: {},
  };
}

function liveServerErrors(state: EditorState): Partial<Record<EventSettingsField, string>> {
  const live: Partial<Record<EventSettingsField, string>> = {};
  for (const field of EVENT_SETTINGS_FIELDS) {
    const error = state.serverErrors[field];
    if (!error) continue;
    if (error.generation !== state.generations[field]) continue;
    if (error.rosterVersion !== null && error.rosterVersion !== state.rosterVersion) continue;
    live[field] = error.message;
  }
  return live;
}

function draftMatchesConfirmed(state: EditorState): boolean {
  return EVENT_SETTINGS_FIELDS.every((field) => state.draft[field] === state.confirmed[field]);
}

function editorErrors(
  state: EditorState,
  eventDate: string,
): Partial<Record<EventSettingsField, string>> {
  const clientErrors = draftMatchesConfirmed(state)
    ? {}
    : validateEventSettings(state.draft, eventDate);
  return { ...clientErrors, ...liveServerErrors(state) };
}

function baselineKeyOf(state: EditorState): string {
  return eventSettingsKey(canonicalEventSettings(state.confirmed, state.rosterVersion));
}

// Newly confirmed values are adopted wherever the host has not moved on. A
// dirty field stays theirs until it saves — that is what makes a same-page RSVP
// mutation safe to absorb without an avoidable stale write.
function rebaseDraft(
  state: EditorState,
  incoming: EventSettingsDraft,
  confirmedThrough: FieldGenerations | null,
): EventSettingsDraft {
  const next = { ...state.draft };
  for (const field of EVENT_SETTINGS_FIELDS) {
    const canAdopt = confirmedThrough
      ? state.generations[field] === confirmedThrough[field]
      : state.draft[field] === state.confirmed[field];
    if (canAdopt) {
      (next as Record<string, unknown>)[field] = incoming[field];
    }
  }
  return next;
}

interface EventSettingsEditorProps {
  event: EventView;
  onSettingsSaved(event: EventView, metadata: { scheduleChanged: boolean }): void;
  onAutosaveStateChange(state: DomainAutosaveState): void;
  // Brackets a write so a whole-event read cannot be adopted across it.
  onEventWrite<T>(request: () => Promise<T>): Promise<T>;
  // Repeats an explicit conflict-recovery read if another manager write made
  // its whole-event answer stale while it was open.
  onEventRead<T>(request: () => Promise<T>): Promise<T>;
  ref?: Ref<AutosaveHandle>;
}

export function EventSettingsEditor({
  event, onSettingsSaved, onAutosaveStateChange, onEventWrite, onEventRead, ref,
}: EventSettingsEditorProps) {
  const [state, setState] = useState<EditorState>(() => initialState(event));
  const [autosave, setAutosave] = useState<AutosaveState>({ status: 'saved', failure: null });
  // Everything the queue callbacks read has to be readable synchronously from
  // a promise continuation, so state is mirrored rather than closed over.
  const stateRef = useRef(state);
  const queueRef = useRef<AutosaveQueue<EventSettingsSave> | null>(null);
  // The queue is built once, so anything it closes over has to be read through
  // a ref or it would keep calling the first render props forever.
  const savedRef = useRef(onSettingsSaved);
  savedRef.current = onSettingsSaved;
  // The settings queue is serialized, so this is the exact confirmed server
  // schedule immediately before each queued snapshot starts. Comparing at
  // request time avoids calling a name-only save schedule-changing merely
  // because an earlier schedule edit was still in flight when it was queued.
  const confirmedScheduleKeyRef = useRef(scheduleKey(state.confirmed));
  // A settings response confirms the field generations carried by its exact
  // queued snapshot. The parent may render that response before the queue's
  // promise continuation settles, so reconciliation reads this synchronously.
  const confirmedThroughRef = useRef<FieldGenerations | null>(null);
  // One automatic race retry per intent. A roster that keeps moving becomes a
  // visible failure rather than a loop.
  const raceRef = useRef<{ intent: string; races: number } | null>(null);
  // Event id and date are fixed for a mounted editor: the manager keys it by id.
  const eventId = event.id;
  const eventDate = event.eventDate;

  function intentKeyOf(payload: EventSettingsPayload): string {
    return eventSettingsKey({ ...payload, rsvpRosterVersion: 0 });
  }

  async function sendSettings(save: EventSettingsSave): Promise<AutosaveOutcome> {
    const { payload } = save;
    const scheduleChanged = scheduleKey(payload) !== confirmedScheduleKeyRef.current;
    try {
      const result = await onEventWrite(() => api<{ event: EventView }>(
        '/api/manage/events/' + eventId + '/settings',
        { method: 'PATCH', body: JSON.stringify(payload) },
      ));
      raceRef.current = null;
      confirmedThroughRef.current = save.generations;
      confirmedScheduleKeyRef.current = scheduleKey(draftFromEvent(result.event));
      savedRef.current(result.event, { scheduleChanged });
      // The stored form, read back from the Worker: it canonicalizes the time
      // zone and may return a roster version this payload did not carry.
      return {
        status: 'confirmed',
        key: eventSettingsKey(canonicalEventSettings(
          draftFromEvent(result.event),
          result.event.rsvpRosterVersion,
        )),
      };
    } catch (caught) {
      if (!(caught instanceof ClientApiError) || caught.code !== 'RSVP_ROSTER_INVALID') throw caught;
      // One read decides which kind of refusal this is. A version that moved is
      // a race worth rebasing; the same version is a roster that cannot open at
      // all, and repeating the write would be refused identically.
      const refreshed = await onEventRead(() => (
        api<{ event: EventView }>('/api/manage/events/' + eventId)
      ));
      confirmedScheduleKeyRef.current = scheduleKey(draftFromEvent(refreshed.event));
      savedRef.current(refreshed.event, { scheduleChanged: false });
      if (refreshed.event.rsvpRosterVersion === payload.rsvpRosterVersion) throw caught;
      const intent = intentKeyOf(payload);
      const seen = raceRef.current?.intent === intent ? raceRef.current.races : 0;
      raceRef.current = { intent, races: seen + 1 };
      if (seen >= 1) throw new RosterRaceExhausted(caught);
      // Nothing was written. The refreshed version arrives as a prop, and the
      // reconciliation effect rebases the dirty intent onto it and enqueues the
      // retry — doing it here as well would send the same change twice. Saying
      // rebased rather than returning quietly stops the queue from advancing
      // its baseline and announcing a Saved that never happened.
      return { status: 'rebased' };
    }
  }

  function describeFailure(error: unknown): AutosaveFailure {
    if (error instanceof RosterRaceExhausted) {
      return { message: error.refusal.message, retryable: true };
    }
    if (error instanceof ClientApiError && error.fieldErrors) {
      // A refusal about named fields is not something Retry can help with. It is
      // recorded against the generations it was refused at and shown on the
      // fields themselves, which is what makes the domain invalid.
      const current = stateRef.current;
      const recorded: Partial<Record<EventSettingsField, ServerFieldError>> = {};
      for (const field of EVENT_SETTINGS_FIELDS) {
        const message = error.fieldErrors[field];
        if (!message) continue;
        recorded[field] = {
          message,
          generation: current.generations[field],
          rosterVersion: error.code === 'RSVP_ROSTER_INVALID' ? current.rosterVersion : null,
        };
      }
      if (Object.keys(recorded).length > 0) {
        apply({ ...current, serverErrors: { ...current.serverErrors, ...recorded } }, 'silent');
        return { message: error.message, retryable: false };
      }
    }
    const failure = describeLoadFailure(error, 'manager', 'These settings could not be saved.');
    // A revoked credential or an ended event cannot be fixed by repeating the
    // request, so it goes to the manager recovery notice instead of Retry.
    return failure.kind === 'retry'
      ? { message: failure.message, retryable: true }
      : { message: failure.message, retryable: false, escalation: failure };
  }

  if (queueRef.current === null) {
    queueRef.current = createAutosaveQueue<EventSettingsSave>({
      baselineKey: baselineKeyOf(stateRef.current),
      save: (snapshot) => sendSettings(snapshot),
      describeFailure: (error) => describeFailure(error),
      onChange: setAutosave,
    });
  }
  const queue = queueRef.current;

  // Silent records state without touching the queue: describeFailure runs
  // inside the queue settle path, and re-entering it there would decide the
  // next request before this one has finished being classified.
  function apply(next: EditorState, mode: 'enqueue' | 'immediate' | 'silent') {
    stateRef.current = next;
    setState(next);
    if (mode === 'silent') return;
    const errors = editorErrors(next, eventDate);
    const payload = canonicalEventSettings(next.draft, next.rosterVersion);
    queue.submit(
      {
        key: eventSettingsKey(payload),
        // Every general setting is a controlled value, so what the host can see
        // is the draft itself plus whichever server errors are still live.
        intent: JSON.stringify([next.draft, Object.entries(errors).sort()]),
        snapshot: Object.keys(errors).length > 0
          ? null
          : { payload, generations: { ...next.generations } },
      },
      mode === 'immediate',
    );
  }

  function edit<K extends EventSettingsField>(
    field: K,
    value: EventSettingsDraft[K],
    mode: 'enqueue' | 'immediate',
  ) {
    const current = stateRef.current;
    apply({
      ...current,
      draft: { ...current.draft, [field]: value },
      generations: { ...current.generations, [field]: current.generations[field] + 1 },
    }, mode);
  }

  useEffect(() => () => { queue.dispose(); }, [queue]);

  useEffect(() => {
    const current = stateRef.current;
    const incoming = draftFromEvent(event);
    confirmedScheduleKeyRef.current = scheduleKey(incoming);
    const confirmedThrough = confirmedThroughRef.current;
    confirmedThroughRef.current = null;
    const next: EditorState = {
      confirmed: incoming,
      rosterVersion: event.rsvpRosterVersion,
      draft: rebaseDraft(current, incoming, confirmedThrough),
      generations: current.generations,
      serverErrors: current.serverErrors,
    };
    const baseline = baselineKeyOf(next);
    const unchanged = baseline === baselineKeyOf(current)
      && eventSettingsKey(canonicalEventSettings(next.draft, next.rosterVersion))
        === eventSettingsKey(canonicalEventSettings(current.draft, current.rosterVersion));
    if (unchanged) return;
    // The confirmed value moved, so the baseline moves with it before anything
    // is judged equivalent to it.
    queue.adoptBaseline(baseline);
    const exhausted = raceRef.current !== null && raceRef.current.races >= 2;
    apply(next, exhausted ? 'silent' : 'enqueue');
  }, [event, queue]);

  const errors = editorErrors(state, eventDate);
  const blockingName = EVENT_SETTINGS_FIELDS.find((field) => errors[field]);
  const blockingField = blockingName
    ? { label: EVENT_SETTINGS_LABELS[blockingName], message: errors[blockingName]! }
    : null;

  // Server field errors are recorded from inside the queue settle path, which
  // must not re-enter it. This is where the domain learns it can no longer send,
  // so a refusal about a named field reads as invalid rather than failed.
  // Resubmitting the same unsendable key is a no-op, so this is safe to repeat.
  const blockedKey = blockingName
    ? eventSettingsKey(canonicalEventSettings(state.draft, state.rosterVersion))
    : null;
  useEffect(() => {
    if (blockedKey === null) return;
    queue.submit({
      key: blockedKey,
      intent: JSON.stringify([state.draft, Object.entries(errors).sort()]),
      snapshot: null,
    });
    // State and errors are deliberately not dependencies: this exists only to
    // tell the queue the domain became unsendable, and rerunning it on every
    // keystroke would fight apply.
  }, [blockedKey, queue]);

  useEffect(() => {
    onAutosaveStateChange({
      domain: 'settings',
      label: DOMAIN_LABEL,
      status: autosave.status,
      failure: autosave.failure,
      blockingField,
    });
  }, [autosave, blockingField?.label, blockingField?.message, onAutosaveStateChange]);

  useImperativeHandle(ref, () => ({ flush: () => { queue.flush(); } }), [queue]);

  function describedBy(field: EventSettingsField) {
    return errors[field] ? 'settings-' + field + '-error' : undefined;
  }

  function fieldError(field: EventSettingsField) {
    return errors[field]
      ? <small className="field-error" id={'settings-' + field + '-error'}>{errors[field]}</small>
      : null;
  }

  // Four fields block implicit submission, so Enter would otherwise do nothing
  // at all. It flushes instead, and never reloads the page.
  function flushOnEnter(keyEvent: KeyboardEvent) {
    if (keyEvent.key !== 'Enter') return;
    keyEvent.preventDefault();
    queue.flush();
  }

  // A raw value that canonicalizes to what is already stored is normalized on
  // screen and needs no request; anything else is flushed rather than waiting
  // out the rest of its window.
  function settleField(
    field: 'name' | 'welcomeMessage' | 'guestbookPrompt' | 'eventTimezone',
    canonical: string,
  ) {
    const current = stateRef.current;
    if (current.draft[field] !== canonical) {
      apply({ ...current, draft: { ...current.draft, [field]: canonical } }, 'enqueue');
    }
    queue.flush();
  }

  return <section className="event-settings-editor" aria-labelledby="event-settings-title">
    <div className="event-settings-editor__heading">
      <h3 id="event-settings-title" className="sr-only">Event settings</h3>
      <AutosaveStatus
        label={DOMAIN_LABEL}
        state={autosave}
        blockingField={blockingField}
        onRetry={() => apply(stateRef.current, 'immediate')}
      />
    </div>
    <form className="settings-form" onSubmit={(formEvent) => { formEvent.preventDefault(); queue.flush(); }}>
      <div className="settings-field">
        <label htmlFor="settings-name">Event name</label>
        <input
          id="settings-name"
          name="name"
          value={state.draft.name}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={describedBy('name')}
          onChange={(change) => edit('name', change.target.value, 'enqueue')}
          onBlur={() => settleField('name', state.draft.name.trim())}
          onKeyDown={flushOnEnter}
        />
        {fieldError('name')}
      </div>
      <div className="settings-field">
        <label htmlFor="settings-guestbook-prompt">Guestbook prompt</label>
        <textarea
          id="settings-guestbook-prompt"
          name="guestbookPrompt"
          dir="auto"
          rows={3}
          maxLength={MAX_GUESTBOOK_PROMPT_LENGTH}
          value={state.draft.guestbookPrompt}
          aria-invalid={Boolean(errors.guestbookPrompt)}
          aria-describedby={describedBy('guestbookPrompt')}
          onChange={(change) => edit('guestbookPrompt', change.target.value, 'enqueue')}
          onBlur={() => settleField('guestbookPrompt', state.draft.guestbookPrompt.trim())}
        />
        {fieldError('guestbookPrompt')}
        <button
          className="button button--secondary"
          type="button"
          onClick={() => edit('guestbookPrompt', DEFAULT_GUESTBOOK_PROMPT, 'immediate')}
        >Reset prompt</button>
      </div>
      <div className="settings-field">
        <label htmlFor="settings-welcome-message">Welcome message</label>
        <textarea
          id="settings-welcome-message"
          name="welcomeMessage"
          rows={4}
          value={state.draft.welcomeMessage}
          aria-invalid={Boolean(errors.welcomeMessage)}
          aria-describedby={describedBy('welcomeMessage')}
          onChange={(change) => edit('welcomeMessage', change.target.value, 'enqueue')}
          onBlur={() => settleField('welcomeMessage', state.draft.welcomeMessage.trim())}
        />
        {fieldError('welcomeMessage')}
      </div>
      <div className="settings-field">
        <label htmlFor="settings-event-timezone">Event time zone</label>
        <input
          id="settings-event-timezone"
          name="eventTimezone"
          value={state.draft.eventTimezone}
          required
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(errors.eventTimezone)}
          aria-describedby={describedBy('eventTimezone')}
          onChange={(change) => edit('eventTimezone', change.target.value, 'enqueue')}
          onBlur={() => settleField(
            'eventTimezone',
            canonicalEventSettings(state.draft, state.rosterVersion).eventTimezone,
          )}
          onKeyDown={flushOnEnter}
        />
        {fieldError('eventTimezone')}
      </div>
      {/* The event date itself stays read-only here; only the local time the
          host puts on it is editable, and the Worker resolves the instant. */}
      <div className="settings-field">
        <label htmlFor="settings-event-start-time">Event start time</label>
        <input
          id="settings-event-start-time"
          name="eventStartTime"
          type="time"
          value={state.draft.eventStartTime}
          required
          aria-invalid={Boolean(errors.eventStartTime)}
          aria-describedby={describedBy('eventStartTime')}
          onChange={(change) => edit('eventStartTime', change.target.value, 'immediate')}
          onKeyDown={flushOnEnter}
        />
        {fieldError('eventStartTime')}
      </div>
      <div className="settings-field">
        <label htmlFor="settings-rsvp-deadline">RSVP deadline</label>
        <input
          id="settings-rsvp-deadline"
          name="rsvpDeadlineDate"
          type="date"
          value={state.draft.rsvpDeadlineDate}
          required
          aria-invalid={Boolean(errors.rsvpDeadlineDate)}
          aria-describedby={describedBy('rsvpDeadlineDate')}
          onChange={(change) => edit('rsvpDeadlineDate', change.target.value, 'immediate')}
          onKeyDown={flushOnEnter}
        />
        {fieldError('rsvpDeadlineDate')}
      </div>
      {([
        ['rsvpEnabled', 'Accept RSVPs'],
        ['galleryVisible', 'Show the optional shared gallery'],
        ['moderationRequired', 'Review guestbook notes before sharing'],
      ] as const).map(([field, label]) => <div className="settings-toggle-field" key={field}>
        <label className="toggle">
          <input
            type="checkbox"
            name={field}
            checked={state.draft[field]}
            aria-invalid={Boolean(errors[field])}
            aria-describedby={describedBy(field)}
            onChange={(change) => edit(field, change.target.checked, 'immediate')}
          />
          <span>{label}</span>
        </label>
        {fieldError(field)}
      </div>)}
    </form>
  </section>;
}
