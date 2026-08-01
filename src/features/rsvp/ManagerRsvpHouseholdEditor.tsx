import { type FormEvent, useEffect, useRef, useState } from 'react';

import {
  MAX_NAMED_INVITEES_PER_HOUSEHOLD,
  MAX_PLUS_ONES_PER_HOUSEHOLD,
  MAX_RSVP_TEXT_LENGTH,
} from '../../../shared/constants';
import type {
  RsvpHouseholdDetail,
  RsvpHouseholdUpdateRequest,
  RsvpSubmissionInvitee,
} from '../../../shared/contracts';
import {
  createHouseholdDraft,
  type RsvpDraft,
  submissionInvitees,
  validateHouseholdDraft,
} from './rsvp-form';

// A named row the host is editing. `id` is null for a row that does not exist
// yet, which is exactly the distinction the update contract draws.
interface NamedDraft {
  key: string;
  id: string | null;
  displayName: string;
  attendance: 'attending' | 'declined' | null;
}

interface NewPlusOneDraft {
  attendance: 'attending' | 'declined' | null;
  displayName: string;
}

export interface ManagerRsvpCreateInput {
  householdKey: string;
  label: string;
  plusOneSlots: number;
  namedInvitees: string[];
}

interface ManagerRsvpHouseholdEditorProps {
  detail: RsvpHouseholdDetail | null;
  creating: boolean;
  // The unified staging workspace owns new invitations. Keep the legacy create
  // callbacks for callers that still need them, without surfacing both flows.
  allowCreate?: boolean;
  busy: boolean;
  // Set only when a refused write replaced the view with the winning version, so
  // the host reads the newer roster from the top before editing it again.
  autoFocusHeading: boolean;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onCreate: (input: ManagerRsvpCreateInput) => void;
  onSaveRoster: (input: Omit<RsvpHouseholdUpdateRequest, 'expectedVersion' | 'expectedRosterVersion'>) => void;
  onSaveCorrection: (invitees: RsvpSubmissionInvitee[]) => void;
  onArchive: () => void;
  onCloseDetail: () => void;
}

function namedDrafts(detail: RsvpHouseholdDetail): NamedDraft[] {
  return detail.invitees
    .filter((invitee) => invitee.kind === 'named')
    .map((invitee) => ({
      key: invitee.id,
      id: invitee.id,
      displayName: invitee.displayName ?? '',
      attendance: null,
    }));
}

function plusOneLabels(detail: RsvpHouseholdDetail): Map<string, string> {
  let slot = 0;
  return new Map(detail.invitees.map((invitee) => {
    if (invitee.kind === 'named') return [invitee.id, invitee.displayName ?? 'Named guest'];
    slot += 1;
    return [invitee.id, `Plus one ${slot}`];
  }));
}

export function ManagerRsvpHouseholdEditor({
  detail,
  creating,
  allowCreate = true,
  busy,
  autoFocusHeading,
  onStartCreate,
  onCancelCreate,
  onCreate,
  onSaveRoster,
  onSaveCorrection,
  onArchive,
  onCloseDetail,
}: ManagerRsvpHouseholdEditorProps) {
  return <div className="rsvp-manager__editor">
    {!creating && !detail && <div className="rsvp-manager__editor-empty">
      <p>{allowCreate ? 'Open a household to edit it, or add one by hand.' : 'Open a household to edit, correct, or archive it.'}</p>
      {allowCreate && <button type="button" className="button button--secondary" onClick={onStartCreate}>
        Add household
      </button>}
    </div>}

    {!creating && detail && allowCreate && <div className="rsvp-manager__editor-actions">
      <button type="button" className="button button--secondary" onClick={onStartCreate}>
        Add household
      </button>
    </div>}

    {creating && <CreateHouseholdForm busy={busy} onCancel={onCancelCreate} onCreate={onCreate} />}

    {!creating && detail && <HouseholdEditor
      key={`${detail.id}:${detail.version}:${detail.updatedAt}`}
      detail={detail}
      busy={busy}
      autoFocusHeading={autoFocusHeading}
      onSaveRoster={onSaveRoster}
      onSaveCorrection={onSaveCorrection}
      onArchive={onArchive}
      onClose={onCloseDetail}
    />}
  </div>;
}

function CreateHouseholdForm({
  busy,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: ManagerRsvpCreateInput) => void;
}) {
  const [householdKey, setHouseholdKey] = useState('');
  const [label, setLabel] = useState('');
  const [names, setNames] = useState('');
  const [plusOneSlots, setPlusOneSlots] = useState('0');

  function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    onCreate({
      householdKey: householdKey.trim(),
      label: label.trim(),
      plusOneSlots: Number(plusOneSlots) || 0,
      namedInvitees: names.split(/\r?\n/u).map((name) => name.trim()).filter(Boolean),
    });
  }

  return <form className="rsvp-household-form" onSubmit={submit} noValidate>
    <h3>Add a household</h3>
    <div className="rsvp-field">
      <label htmlFor="rsvp-create-key">Household key</label>
      <input
        id="rsvp-create-key"
        value={householdKey}
        maxLength={64}
        autoComplete="off"
        spellCheck={false}
        onChange={(change) => setHouseholdKey(change.target.value)}
      />
      <small>Lowercase letters, numbers, hyphens, and underscores.</small>
    </div>
    <div className="rsvp-field">
      <label htmlFor="rsvp-create-label">Household label</label>
      <input
        id="rsvp-create-label"
        value={label}
        maxLength={MAX_RSVP_TEXT_LENGTH}
        onChange={(change) => setLabel(change.target.value)}
      />
    </div>
    <div className="rsvp-field">
      <label htmlFor="rsvp-create-names">Named guests</label>
      <textarea
        id="rsvp-create-names"
        rows={4}
        value={names}
        onChange={(change) => setNames(change.target.value)}
      />
      <small>One full name per line, up to {MAX_NAMED_INVITEES_PER_HOUSEHOLD}.</small>
    </div>
    <div className="rsvp-field">
      <label htmlFor="rsvp-create-plus-ones">Plus-one slots</label>
      <input
        id="rsvp-create-plus-ones"
        type="number"
        min={0}
        max={MAX_PLUS_ONES_PER_HOUSEHOLD}
        value={plusOneSlots}
        onChange={(change) => setPlusOneSlots(change.target.value)}
      />
    </div>
    <div className="button-row">
      <button type="submit" className="button button--primary" disabled={busy}>Create household</button>
      <button type="button" className="text-button" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

function HouseholdEditor({
  detail,
  busy,
  autoFocusHeading,
  onSaveRoster,
  onSaveCorrection,
  onArchive,
  onClose,
}: {
  detail: RsvpHouseholdDetail;
  busy: boolean;
  autoFocusHeading: boolean;
  onSaveRoster: (input: Omit<RsvpHouseholdUpdateRequest, 'expectedVersion' | 'expectedRosterVersion'>) => void;
  onSaveCorrection: (invitees: RsvpSubmissionInvitee[]) => void;
  onArchive: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(detail.label);
  const [plusOneSlots, setPlusOneSlots] = useState(String(detail.plusOneSlots));
  const [named, setNamed] = useState<NamedDraft[]>(() => namedDrafts(detail));
  const [newPlusOnes, setNewPlusOnes] = useState<NewPlusOneDraft[]>([]);
  const [draft, setDraft] = useState<RsvpDraft>(() => createHouseholdDraft(detail));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [archiving, setArchiving] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const attendanceRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const nameRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    if (autoFocusHeading) headingRef.current?.focus();
  }, [autoFocusHeading]);

  const responded = detail.firstRespondedAt !== null;
  const growth = Math.max(0, (Number(plusOneSlots) || 0) - detail.plusOneSlots);
  const labels = plusOneLabels(detail);

  // A responded household must answer for every slot the host is adding, so the
  // draft array is kept exactly as long as the growth the server will compute.
  useEffect(() => {
    setNewPlusOnes((current) => {
      if (!responded || current.length === growth) return current;
      const next = current.slice(0, growth);
      while (next.length < growth) next.push({ attendance: null, displayName: '' });
      return next;
    });
  }, [growth, responded]);

  function submitRoster(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    onSaveRoster({
      label: label.trim(),
      plusOneSlots: Number(plusOneSlots) || 0,
      namedInvitees: named.map((row) => ({
        id: row.id,
        displayName: row.displayName.trim(),
        ...(row.id === null && responded && row.attendance
          ? { attendance: row.attendance }
          : {}),
      })),
      ...(responded && growth > 0
        ? {
            newPlusOneResponses: newPlusOnes.map((slot) => ({
              attendance: slot.attendance ?? 'declined',
              displayName: slot.attendance === 'attending' ? slot.displayName.trim() : null,
            })),
          }
        : {}),
    });
  }

  function submitCorrection(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const nextErrors = validateHouseholdDraft(detail, draft);
    setErrors(nextErrors);
    for (const invitee of detail.invitees) {
      if (nextErrors[invitee.id]) {
        attendanceRefs.current[invitee.id]?.focus();
        return;
      }
      if (nextErrors[`${invitee.id}.displayName`]) {
        nameRefs.current[invitee.id]?.focus();
        return;
      }
    }
    onSaveCorrection(submissionInvitees(detail, draft));
  }

  return <section className="rsvp-household-editor" aria-labelledby="rsvp-household-heading">
    <header className="rsvp-household-editor__heading">
      <h3 id="rsvp-household-heading" ref={headingRef} tabIndex={-1}>{detail.label}</h3>
      <p className="rsvp-household-editor__key">{detail.householdKey}</p>
      {detail.archivedAt && <p className="rsvp-household-editor__flag">Archived</p>}
      <button type="button" className="text-button" onClick={onClose}>Close household</button>
    </header>

    {detail.archivedAt
      ? <p className="rsvp-household-editor__note">
        This household is archived. Its rows stay in the export until the event is purged.
      </p>
      : <>
        <form className="rsvp-household-form" onSubmit={submitRoster} noValidate>
          <h4>Household details</h4>
          <div className="rsvp-field">
            <label htmlFor="rsvp-household-label">Household label</label>
            <input
              id="rsvp-household-label"
              value={label}
              maxLength={MAX_RSVP_TEXT_LENGTH}
              onChange={(change) => setLabel(change.target.value)}
            />
          </div>
          <div className="rsvp-field">
            <label htmlFor="rsvp-household-plus-ones">Plus-one slots</label>
            <input
              id="rsvp-household-plus-ones"
              type="number"
              min={0}
              max={MAX_PLUS_ONES_PER_HOUSEHOLD}
              value={plusOneSlots}
              onChange={(change) => setPlusOneSlots(change.target.value)}
            />
            <small>Reducing removes only the highest slots that are not attending.</small>
          </div>

          <fieldset className="rsvp-named-rows">
            <legend>Named guests on this invitation</legend>
            {named.map((row, index) => <div className="rsvp-field" key={row.key}>
              <label htmlFor={`rsvp-named-${index}`}>Named guest {index + 1}</label>
              <input
                id={`rsvp-named-${index}`}
                value={row.displayName}
                maxLength={MAX_RSVP_TEXT_LENGTH}
                onChange={(change) => setNamed((current) => current.map((entry, position) => (
                  position === index
                    ? { ...entry, displayName: change.target.value }
                    : entry
                )))}
              />
              {row.id === null && responded && <div className="rsvp-attendance">
                {(['attending', 'declined'] as const).map((attendance) => <label
                  key={attendance}
                  htmlFor={`rsvp-named-${index}-${attendance}`}
                >
                  <input
                    id={`rsvp-named-${index}-${attendance}`}
                    type="radio"
                    name={`rsvp-named-${index}-attendance`}
                    checked={row.attendance === attendance}
                    onChange={() => setNamed((current) => current.map((entry, position) => (
                      position === index ? { ...entry, attendance } : entry
                    )))}
                  />
                  <span>{attendance === 'attending' ? 'Attending' : 'Not attending'}</span>
                </label>)}
              </div>}
              {/* A named guest may only be removed before the household's first
                  response, so the control is not offered afterwards. */}
              {!responded && named.length > 1 && <button
                type="button"
                className="text-button"
                onClick={() => setNamed((current) => current.filter((_, position) => position !== index))}
              >Remove named guest {index + 1}</button>}
            </div>)}
            {named.length < MAX_NAMED_INVITEES_PER_HOUSEHOLD && <button
              type="button"
              className="button button--secondary"
              onClick={() => setNamed((current) => [...current, {
                key: crypto.randomUUID(),
                id: null,
                displayName: '',
                attendance: null,
              }])}
            >Add named guest</button>}
          </fieldset>

          {responded && growth > 0 && <fieldset className="rsvp-new-plus-ones">
            <legend>New plus-one slots</legend>
            {newPlusOnes.map((slot, index) => <div className="rsvp-field" key={`new-plus-one-${index}`}>
              <p className="rsvp-new-plus-ones__label">New plus one {index + 1}</p>
              <div className="rsvp-attendance">
                {(['attending', 'declined'] as const).map((attendance) => <label
                  key={attendance}
                  htmlFor={`rsvp-new-plus-one-${index}-${attendance}`}
                >
                  <input
                    id={`rsvp-new-plus-one-${index}-${attendance}`}
                    type="radio"
                    name={`rsvp-new-plus-one-${index}`}
                    checked={slot.attendance === attendance}
                    onChange={() => setNewPlusOnes((current) => current.map((entry, position) => (
                      position === index ? { ...entry, attendance } : entry
                    )))}
                  />
                  <span>{attendance === 'attending' ? 'Attending' : 'Not attending'}</span>
                </label>)}
              </div>
              {slot.attendance === 'attending' && <>
                <label htmlFor={`rsvp-new-plus-one-${index}-name`}>New plus one {index + 1} name</label>
                <input
                  id={`rsvp-new-plus-one-${index}-name`}
                  value={slot.displayName}
                  maxLength={MAX_RSVP_TEXT_LENGTH}
                  onChange={(change) => setNewPlusOnes((current) => current.map((entry, position) => (
                    position === index ? { ...entry, displayName: change.target.value } : entry
                  )))}
                />
              </>}
            </div>)}
          </fieldset>}

          <button type="submit" className="button button--primary" disabled={busy}>Save household</button>
        </form>

        <form className="rsvp-household-correction" onSubmit={submitCorrection} noValidate>
          <h4>Correct this household&rsquo;s response</h4>
          <p>A host correction stays possible after the guest deadline has passed.</p>
          {detail.invitees.map((invitee) => {
            const rowName = labels.get(invitee.id) ?? 'Guest';
            const value = draft[invitee.id]!;
            const attendanceErrorId = `${invitee.id}-correction-error`;
            const nameErrorId = `${invitee.id}-correction-name-error`;
            return <fieldset className="rsvp-person" key={invitee.id} disabled={busy}>
              <legend>{rowName}</legend>
              <div className="rsvp-attendance">
                {(['attending', 'declined'] as const).map((attendance) => <label
                  key={attendance}
                  htmlFor={`${invitee.id}-correction-${attendance}`}
                >
                  <input
                    ref={(element) => {
                      if (attendance === 'attending') attendanceRefs.current[invitee.id] = element;
                    }}
                    id={`${invitee.id}-correction-${attendance}`}
                    type="radio"
                    name={`correction-${invitee.id}`}
                    checked={value.attendance === attendance}
                    aria-describedby={errors[invitee.id] ? attendanceErrorId : undefined}
                    onChange={() => setDraft((current) => ({
                      ...current,
                      [invitee.id]: {
                        attendance,
                        displayName: attendance === 'declined' ? '' : current[invitee.id]!.displayName,
                      },
                    }))}
                  />
                  <span>{attendance === 'attending' ? 'Attending' : 'Not attending'}</span>
                </label>)}
              </div>
              {errors[invitee.id] && <p className="rsvp-error" id={attendanceErrorId}>{errors[invitee.id]}</p>}
              {invitee.kind === 'plus_one' && value.attendance === 'attending' && <div className="rsvp-field">
                <label htmlFor={`${invitee.id}-correction-name`}>{rowName} name</label>
                <input
                  ref={(element) => { nameRefs.current[invitee.id] = element; }}
                  id={`${invitee.id}-correction-name`}
                  value={value.displayName}
                  maxLength={MAX_RSVP_TEXT_LENGTH}
                  aria-invalid={Boolean(errors[`${invitee.id}.displayName`])}
                  aria-describedby={errors[`${invitee.id}.displayName`] ? nameErrorId : undefined}
                  onChange={(change) => setDraft((current) => ({
                    ...current,
                    [invitee.id]: { ...current[invitee.id]!, displayName: change.target.value },
                  }))}
                />
                {errors[`${invitee.id}.displayName`] && <p className="rsvp-error" id={nameErrorId}>
                  {errors[`${invitee.id}.displayName`]}
                </p>}
              </div>}
            </fieldset>;
          })}
          <button type="submit" className="button button--primary" disabled={busy}>
            Save response correction
          </button>
        </form>

        <div className="rsvp-household-editor__danger">
          <h4>Archive this household</h4>
          {archiving
            ? <fieldset className="rsvp-archive-confirm">
              <legend>Archive {detail.label}</legend>
              <p>
                Archiving cannot be undone: lookup and signed-in guest devices stop for this
                household, while the export keeps its marked rows until the event is purged.
              </p>
              <div className="rsvp-field">
                <label htmlFor="rsvp-archive-confirmation">Type household name</label>
                <input
                  id="rsvp-archive-confirmation"
                  value={confirmation}
                  autoComplete="off"
                  onChange={(change) => setConfirmation(change.target.value)}
                />
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="button button--danger-outline"
                  disabled={busy || confirmation.trim() !== detail.label}
                  onClick={onArchive}
                >Archive {detail.label}</button>
                <button type="button" className="text-button" onClick={() => {
                  setArchiving(false);
                  setConfirmation('');
                }}>Cancel</button>
              </div>
            </fieldset>
            : <button
              type="button"
              className="button button--danger-outline"
              onClick={() => setArchiving(true)}
            >Archive household</button>}
        </div>
      </>}
  </section>;
}
