import { type FormEvent, useEffect, useRef, useState } from 'react';

import type { GuestEventView } from '../../../shared/contracts';
import { RsvpShell } from './RsvpShell';

interface RsvpLookupProps {
  event: GuestEventView;
  presentation: 'primary' | 'secondary' | 'embedded';
  secondNameRequired: boolean;
  busy: boolean;
  message: string;
  onLookup: (firstName: string, secondName?: string) => Promise<void>;
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00`));
}

export function RsvpLookup({
  event,
  presentation,
  secondNameRequired,
  busy,
  message,
  onLookup,
}: RsvpLookupProps) {
  const [firstName, setFirstName] = useState('');
  const [secondName, setSecondName] = useState('');
  const [fieldError, setFieldError] = useState('');
  const firstNameRef = useRef<HTMLInputElement>(null);
  const secondNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (secondNameRequired) secondNameRef.current?.focus();
  }, [secondNameRequired]);

  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const first = firstName.trim();
    const second = secondName.trim();
    if (!first) {
      setFieldError('Enter the full name on the invitation.');
      firstNameRef.current?.focus();
      return;
    }
    if (secondNameRequired && !second) {
      setFieldError('Enter another full name from the same invitation.');
      secondNameRef.current?.focus();
      return;
    }
    setFieldError('');
    await onLookup(first, secondNameRequired ? second : undefined);
  }

  /* Secondary opens inside a disclosure far below the photo drop's hero, so it repeats the event
     identity. Primary and embedded both sit directly under a hero that already carries it. */
  const withIdentity = presentation === 'secondary';
  const HeadingTag = presentation === 'embedded' ? 'h2' : 'h1';

  return <RsvpShell event={event} presentation={presentation} className="rsvp-flow--lookup">
    <header className="rsvp-identity">
      {withIdentity && <p className="rsvp-identity__event">{event.name}</p>}
      <HeadingTag>{presentation === 'embedded'
        ? 'Find your household to view a saved response.'
        : 'Find your household invitation'}</HeadingTag>
      {withIdentity && <p>{displayDate(event.eventDate)}</p>}
      {/* The deadline sentence is an instruction to answer. Once access is read-only it would name a
          date nobody can act on, which is the dead-end this surface exists to replace. */}
      {event.rsvpDeadlineDate && event.rsvpAccess === 'editable' && <p className="rsvp-deadline">Please RSVP by {displayDate(event.rsvpDeadlineDate)}.</p>}
    </header>
    <div className="rsvp-card rsvp-lookup">
      <form onSubmit={(formEvent) => void submit(formEvent)} noValidate>
        <div className="rsvp-field">
          <label htmlFor="rsvp-first-name">Full name</label>
          <input
            ref={firstNameRef}
            id="rsvp-first-name"
            name="firstName"
            value={firstName}
            autoComplete="name"
            maxLength={80}
            aria-invalid={fieldError && !firstName.trim() ? true : undefined}
            aria-describedby={fieldError ? 'rsvp-lookup-field-error' : 'rsvp-privacy'}
            onChange={(change) => {
              setFirstName(change.target.value);
              setFieldError('');
            }}
          />
        </div>
        {secondNameRequired && <div className="rsvp-field">
          <label htmlFor="rsvp-second-name">Another full name</label>
          <input
            ref={secondNameRef}
            id="rsvp-second-name"
            name="secondName"
            value={secondName}
            autoComplete="name"
            maxLength={80}
            aria-invalid={fieldError && !secondName.trim() ? true : undefined}
            aria-describedby={fieldError ? 'rsvp-lookup-field-error' : 'rsvp-second-name-help'}
            onChange={(change) => {
              setSecondName(change.target.value);
              setFieldError('');
            }}
          />
          <small id="rsvp-second-name-help">Use another named guest from this same invitation.</small>
        </div>}
        {fieldError && <p id="rsvp-lookup-field-error" className="rsvp-error">{fieldError}</p>}
        <p id="rsvp-privacy" className="rsvp-privacy">
          Enter a full name exactly as it appears on the invitation. We never show or suggest the guest list.
        </p>
        <button className="rsvp-button rsvp-button--primary" type="submit" disabled={busy}>
          {busy ? 'Finding invitation…' : 'Find my invitation'}
        </button>
      </form>
      <p className="rsvp-status" aria-live="polite">{message}</p>
    </div>
  </RsvpShell>;
}
