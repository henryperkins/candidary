import { type FormEvent, useId, useRef, useState } from 'react';

import { parseManagementLink, replaceManagementLocation } from '../app/management-link';

export function ManagementLinkRecovery() {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const headingId = useId();
  const errorId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const pathname = parseManagementLink(String(data.get('managementLink') ?? ''), window.location.origin);
    if (!pathname) {
      setError('Enter a Candidary management link from this site.');
      input.current?.focus();
      return;
    }
    setError('');
    replaceManagementLocation(pathname);
  }

  return <section className="management-link-recovery" aria-labelledby={headingId}>
    <h2 id={headingId}>Open an event manager</h2>
    <p>Your link is used only to reopen this event manager.</p>
    <form aria-labelledby={headingId} onSubmit={submit} noValidate>
      <div className="management-link-recovery__field">
        <label htmlFor="management-link">Management link</label>
        <input
          ref={input}
          id="management-link"
          type="url"
          name="managementLink"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
        />
        {error && <p id={errorId} className="management-link-recovery__error" role="alert">{error}</p>}
      </div>
      <button className="button button--primary" type="submit">Open event manager</button>
    </form>
  </section>;
}
