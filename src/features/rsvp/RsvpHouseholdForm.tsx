import { type FormEvent, useEffect, useRef, useState } from 'react';

import type { RsvpHouseholdView } from '../../../shared/contracts';
import {
  type RsvpDraft,
  validateHouseholdDraft,
} from './rsvp-form';

interface RsvpHouseholdFormProps {
  household: RsvpHouseholdView;
  draft: RsvpDraft;
  saving: boolean;
  saveError: string;
  reviewUpdated: boolean;
  onDraftChange: (draft: RsvpDraft) => void;
  onSubmit: (draft: RsvpDraft) => Promise<void>;
}
export function RsvpHouseholdForm({
  household,
  draft,
  saving,
  saveError,
  reviewUpdated,
  onDraftChange,
  onSubmit,
}: RsvpHouseholdFormProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const attendanceRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const nameRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (reviewUpdated) reviewHeadingRef.current?.focus();
  }, [reviewUpdated, household.version]);

  function changeAttendance(inviteeId: string, attendance: 'attending' | 'declined') {
    const current = draft[inviteeId]!;
    onDraftChange({
      ...draft,
      [inviteeId]: {
        ...current,
        attendance,
        displayName: attendance === 'declined' ? '' : current.displayName,
      },
    });
    setErrors((currentErrors) => {
      const next = { ...currentErrors };
      delete next[inviteeId];
      delete next[`${inviteeId}.displayName`];
      return next;
    });
  }

  function changeDisplayName(inviteeId: string, displayName: string) {
    onDraftChange({
      ...draft,
      [inviteeId]: { ...draft[inviteeId]!, displayName },
    });
    setErrors((currentErrors) => {
      const next = { ...currentErrors };
      delete next[`${inviteeId}.displayName`];
      return next;
    });
  }

  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const nextErrors = validateHouseholdDraft(household, draft);
    setErrors(nextErrors);
    for (const invitee of household.invitees) {
      if (nextErrors[invitee.id]) {
        attendanceRefs.current[invitee.id]?.focus();
        return;
      }
      if (nextErrors[`${invitee.id}.displayName`]) {
        nameRefs.current[invitee.id]?.focus();
        return;
      }
    }
    await onSubmit(draft);
  }

  const values = household.invitees.map((invitee) => draft[invitee.id]);
  const attending = values.filter((value) => value?.attendance === 'attending').length;
  const declined = values.filter((value) => value?.attendance === 'declined').length;
  const unanswered = household.invitees.length - attending - declined;
  let plusOneNumber = 0;

  return <section className="rsvp-flow rsvp-flow--household">
    <div className="rsvp-card rsvp-household">
      <header className="rsvp-household__heading">
        <p className="rsvp-eyebrow">{household.label}</p>
        <h1
          ref={reviewHeadingRef}
          tabIndex={reviewUpdated ? -1 : undefined}
        >{reviewUpdated ? 'Review updated household' : 'Your household RSVP'}</h1>
        {reviewUpdated && <p>The invitation changed. Review every person before sending again.</p>}
      </header>

      <p className="rsvp-counts" aria-live="polite">
        {attending} attending · {declined} not attending · {unanswered} to answer
      </p>

      <form onSubmit={(formEvent) => void submit(formEvent)} noValidate>
        <div className="rsvp-roster">
          {household.invitees.map((invitee) => {
            if (invitee.kind === 'plus_one') plusOneNumber += 1;
            const rowName = invitee.kind === 'named'
              ? invitee.displayName!
              : `Plus one ${plusOneNumber}`;
            const value = draft[invitee.id]!;
            const attendanceErrorId = `${invitee.id}-attendance-error`;
            const nameErrorId = `${invitee.id}-name-error`;
            return <fieldset className="rsvp-person" key={invitee.id} disabled={saving}>
              <legend>{rowName}</legend>
              <div className="rsvp-attendance">
                {(['attending', 'declined'] as const).map((attendance) => {
                  const label = attendance === 'attending' ? 'Attending' : 'Not attending';
                  const inputId = `${invitee.id}-${attendance}`;
                  return <label key={attendance} htmlFor={inputId}>
                    <input
                      ref={(element) => {
                        if (attendance === 'attending') attendanceRefs.current[invitee.id] = element;
                      }}
                      id={inputId}
                      type="radio"
                      name={`attendance-${invitee.id}`}
                      value={attendance}
                      checked={value.attendance === attendance}
                      aria-describedby={errors[invitee.id] ? attendanceErrorId : undefined}
                      onChange={() => changeAttendance(invitee.id, attendance)}
                    />
                    <span>{label}</span>
                  </label>;
                })}
              </div>
              {errors[invitee.id] && <p className="rsvp-error" id={attendanceErrorId}>
                {errors[invitee.id]}
              </p>}
              {invitee.kind === 'plus_one' && value.attendance === 'attending' && <div className="rsvp-field rsvp-plus-one-name">
                <label htmlFor={`${invitee.id}-name`}>{rowName} name</label>
                <input
                  ref={(element) => { nameRefs.current[invitee.id] = element; }}
                  id={`${invitee.id}-name`}
                  value={value.displayName}
                  maxLength={80}
                  autoComplete="name"
                  aria-invalid={Boolean(errors[`${invitee.id}.displayName`])}
                  aria-describedby={errors[`${invitee.id}.displayName`] ? nameErrorId : undefined}
                  onChange={(change) => changeDisplayName(invitee.id, change.target.value)}
                />
                {errors[`${invitee.id}.displayName`] && <p className="rsvp-error" id={nameErrorId}>
                  {errors[`${invitee.id}.displayName`]}
                </p>}
              </div>}
            </fieldset>;
          })}
        </div>
        <button className="rsvp-button rsvp-button--primary" type="submit" disabled={saving}>
          {saving ? 'Saving RSVP…' : saveError ? 'Try again' : 'Submit RSVP'}
        </button>
      </form>
      <p className="rsvp-status" aria-live="polite">{saveError}</p>
    </div>
  </section>;
}
