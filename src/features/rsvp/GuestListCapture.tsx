import { useState } from 'react';

import { MAX_RSVP_CSV_BYTES } from '../../../shared/constants';
import type { RsvpHouseholdDetail } from '../../../shared/contracts';

import type { GuestListSourceKind } from './guest-list-intake';
import { GuestListHouseholdTargetPicker } from './GuestListHouseholdTargetPicker';

function supportedSourceFile(file: File): boolean {
  return /\.(csv|tsv|txt)$/iu.test(file.name);
}

export function GuestListCapture({
  eventId,
  source,
  sourceError,
  kind,
  hasHouseholds,
  target,
  targetPending,
  onSource,
  onSourceInvalid,
  onKind,
  onTarget,
  onTargetPending,
  onContinue,
}: {
  eventId: string;
  source: string;
  sourceError?: string;
  kind: GuestListSourceKind;
  hasHouseholds: boolean;
  target: RsvpHouseholdDetail | null;
  targetPending: boolean;
  onSource(value: string): void;
  onKind(value: GuestListSourceKind): void;
  onSourceInvalid(): void;
  onTarget(value: RsvpHouseholdDetail | null): void;
  onTargetPending(pending: boolean): void;
  onContinue(): void;
}) {
  const [fileError, setFileError] = useState('');
  async function readFile(file: File) {
    onSourceInvalid();
    if (!supportedSourceFile(file)) {
      setFileError('Choose a .csv, .tsv, or .txt guest-list file.');
      return;
    }
    if (file.size > MAX_RSVP_CSV_BYTES) {
      setFileError('Guest-list source files must be 256 KiB or smaller.');
      return;
    }
    try {
      const text = await file.text();
      setFileError('');
      onSource(text);
    } catch {
      setFileError('That file could not be read. Choose the file again.');
    }
  }

  return <div className="guest-list-capture">
    <p>Paste names or spreadsheet data, type guests, or choose a CSV, TSV, or text file.</p>
    <label htmlFor="guest-list-source">Guest names or spreadsheet data</label>
    <textarea
      id="guest-list-source"
      value={source}
      onChange={(event) => onSource(event.target.value)}
      placeholder={'Avery Lee\nJordan Lee'}
    />
    <div
      className="guest-list-drop-zone"
      role="group"
      aria-label="Guest-list file drop zone"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file) void readFile(file);
      }}
    >
      <p>Drop a guest-list file here, or choose one below.</p>
      <label htmlFor="guest-list-file">Choose guest-list file</label>
      <input
        id="guest-list-file"
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Reset for both a success and a failure: selecting the same corrected
          // file must deliver another change event.
          event.currentTarget.value = '';
          if (file) void readFile(file);
        }}
      />
    </div>
    {fileError && <p role="alert">{fileError}</p>}
    {sourceError && <p role="alert">{sourceError}</p>}
    <fieldset>
      <legend>Input format</legend>
      <p>Detected: <strong>{kind === 'plain' ? 'plain names' : kind === 'structured' ? 'structured data' : 'choose a format'}</strong></p>
      <label><input type="radio" checked={kind === 'plain'} onChange={() => onKind('plain')} /> Plain names</label>
      <label><input type="radio" checked={kind === 'structured'} onChange={() => onKind('structured')} /> Structured data</label>
    </fieldset>
    {hasHouseholds && <GuestListHouseholdTargetPicker
      eventId={eventId}
      target={target}
      onTarget={onTarget}
      onSelectionPendingChange={onTargetPending}
    />}
    <div className="guest-list-workspace__actions">
      <button
        type="button"
        className="button button--primary"
        disabled={Boolean(sourceError)
          || targetPending
          || (!source.trim() && target === null)
          || (source.trim().length > 0 && kind === 'ambiguous')}
        onClick={onContinue}
      >Continue</button>
    </div>
  </div>;
}
