import { Upload } from 'lucide-react';

import type { RsvpImportField, RsvpImportPreview } from '../../../shared/contracts';

// The wire field names are the CSV column headers. A host reads a column, not an
// identifier, so the panel spells them out and never invents a new vocabulary.
const FIELD_LABELS: Record<RsvpImportField, string> = {
  file: 'file',
  household_key: 'household key',
  household_label: 'household label',
  invitee_name: 'invitee name',
  plus_one_slots: 'plus-one slots',
};

interface ManagerRsvpImportProps {
  fileName: string;
  preview: RsvpImportPreview | null;
  busy: boolean;
  error: string;
  // The committed preview went stale. The chosen file is still here and still
  // correct; only the server's verdict about it has to be taken again.
  stale: boolean;
  disabled: boolean;
  onFileChosen: (file: File) => void;
  onPreviewAgain: () => void;
  onCommit: () => void;
}

export function ManagerRsvpImport({
  fileName,
  preview,
  busy,
  error,
  stale,
  disabled,
  onFileChosen,
  onPreviewAgain,
  onCommit,
}: ManagerRsvpImportProps) {
  const blocking = preview?.issues.length ?? 0;
  return <section className="rsvp-import" aria-labelledby="rsvp-import-title">
    <h3 id="rsvp-import-title">Import a guest list</h3>
    <p className="rsvp-import__intro">
      One CSV, once. The columns are
      {' '}<code>household_key,household_label,invitee_name,plus_one_slots</code>, and importing is
      only possible while RSVP is off and no households exist yet.
    </p>

    <div className="rsvp-import__file">
      <label htmlFor="rsvp-import-file">Guest list CSV</label>
      <input
        id="rsvp-import-file"
        type="file"
        accept="text/csv,.csv"
        disabled={disabled || busy}
        onChange={(change) => {
          const file = change.target.files?.[0];
          if (file) onFileChosen(file);
        }}
      />
      {fileName && <p className="rsvp-import__file-name">{fileName}</p>}
    </div>

    {error && <p className="rsvp-import__error" role="alert">{error}</p>}

    {stale && <div className="rsvp-import__actions">
      <button type="button" className="button button--secondary" disabled={busy} onClick={onPreviewAgain}>
        Preview again
      </button>
    </div>}

    {preview && <div className="rsvp-import__preview">
      <ul className="rsvp-import__totals">
        <li>{preview.totals.households} household{preview.totals.households === 1 ? '' : 's'}</li>
        <li>{preview.totals.namedInvitees} named</li>
        <li>{preview.totals.plusOneCapacity} plus-one</li>
        <li>{preview.totals.invitedCapacity} invited</li>
      </ul>

      {blocking === 0
        ? <p className="rsvp-import__clear">No blocking issues found.</p>
        : <section className="rsvp-import__issues" aria-label="CSV issues">
          <h4>{blocking} issue{blocking === 1 ? '' : 's'} must be fixed first</h4>
          <ul>
            {preview.issues.map((issue, index) => <li key={`${issue.row}-${issue.field}-${index}`}>
              <strong>{issue.row > 0 ? `Row ${issue.row}` : 'File'}</strong>
              <span className="rsvp-import__issue-field">{FIELD_LABELS[issue.field]}</span>
              <span className="rsvp-import__issue-message">{issue.message}</span>
            </li>)}
          </ul>
        </section>}

      {/* Committing is deliberately its own decision, and it exists only when the
          server found nothing blocking in the exact bytes it will reparse. */}
      {blocking === 0 && !stale && <div className="rsvp-import__actions">
        <button type="button" className="button button--primary" disabled={busy} onClick={onCommit}>
          <Upload aria-hidden="true" /> Commit guest list
        </button>
      </div>}
    </div>}
  </section>;
}
