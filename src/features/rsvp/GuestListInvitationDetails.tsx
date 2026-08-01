import type {
  RsvpHouseholdDetail,
  RsvpRosterBatchDraft,
  RsvpRosterBatchIssue,
} from '../../../shared/contracts';

import { clientId } from './guest-list-intake';

export interface PlusOneResponseDraft {
  clientInviteeId: string;
  attendance: 'attending' | 'declined' | null;
  displayName: string;
}

type ConflictState = 'changed' | 'archived' | 'missing';

function updateCreate(
  batch: RsvpRosterBatchDraft,
  id: string,
  update: Partial<RsvpRosterBatchDraft['creates'][number]>,
): RsvpRosterBatchDraft {
  return {
    ...batch,
    creates: batch.creates.map((create) => create.clientHouseholdId === id ? { ...create, ...update } : create),
  };
}

function attendance(value: string): 'attending' | 'declined' | undefined {
  return value === 'attending' || value === 'declined' ? value : undefined;
}

function issuesFor(issues: RsvpRosterBatchIssue[], id: string): RsvpRosterBatchIssue[] {
  return issues.filter((issue) => issue.clientHouseholdId === id);
}

function updateNamedInvitee(
  batch: RsvpRosterBatchDraft,
  householdId: string,
  inviteeId: string,
  displayName: string,
): RsvpRosterBatchDraft {
  return {
    creates: batch.creates.map((create) => create.clientHouseholdId === householdId
      ? {
        ...create,
        namedInvitees: create.namedInvitees.map((invitee) => invitee.clientInviteeId === inviteeId
          ? { ...invitee, displayName }
          : invitee),
      }
      : create),
    appends: batch.appends.map((append) => append.clientHouseholdId === householdId
      ? {
        ...append,
        namedInvitees: append.namedInvitees.map((invitee) => invitee.clientInviteeId === inviteeId
          ? { ...invitee, displayName }
          : invitee),
      }
      : append),
  };
}

export function GuestListInvitationDetails({
  batch,
  target,
  plusOneDrafts,
  onPlusOneDrafts,
  onChange,
  onBack,
  onReview,
  onAcceptConflict,
  busy,
  conflicts = new Map(),
  issues = [],
}: {
  batch: RsvpRosterBatchDraft;
  target: RsvpHouseholdDetail | null;
  plusOneDrafts: Record<string, PlusOneResponseDraft[]>;
  onPlusOneDrafts(appendId: string, rows: PlusOneResponseDraft[]): void;
  onChange(value: RsvpRosterBatchDraft): void;
  onBack(): void;
  onReview(): void;
  onAcceptConflict?(appendId: string): void;
  busy: boolean;
  conflicts?: ReadonlyMap<string, ConflictState>;
  issues?: RsvpRosterBatchIssue[];
}) {
  const responded = Boolean(target?.firstRespondedAt);
  return <div className="guest-list-details">
    {batch.creates.map((create) => {
      const cardIssues = issuesFor(issues, create.clientHouseholdId);
      return <section id={`guest-list-card-${create.clientHouseholdId}`} tabIndex={-1} key={create.clientHouseholdId} className="guest-list-card">
        <label id={`guest-list-field-${create.clientHouseholdId}-label`} tabIndex={-1}>
          Invitation label
          <input
            value={create.label}
            onChange={(event) => onChange(updateCreate(batch, create.clientHouseholdId, { label: event.target.value }))}
          />
        </label>
        {create.namedInvitees.map((invitee) => <label
          id={`guest-list-field-${invitee.clientInviteeId}-namedInvitees.displayName`}
          tabIndex={-1}
          key={invitee.clientInviteeId}
        >
          Guest name
          <input
            value={invitee.displayName}
            onChange={(event) => onChange(updateNamedInvitee(
              batch,
              create.clientHouseholdId,
              invitee.clientInviteeId,
              event.target.value,
            ))}
          />
        </label>)}
        <label id={`guest-list-field-${create.clientHouseholdId}-plusOneSlots`} tabIndex={-1}>
          Plus-one slots
          <input
            type="number"
            min="0"
            max="10"
            value={create.plusOneSlots}
            onChange={(event) => onChange(updateCreate(batch, create.clientHouseholdId, {
              plusOneSlots: Math.min(10, Math.max(0, Number(event.target.value) || 0)),
            }))}
          />
        </label>
        <p>Invited capacity: {create.namedInvitees.length + create.plusOneSlots}</p>
        {cardIssues.map((issue, index) => <p className="guest-list-field-error" id={`guest-list-issue-target-${create.clientHouseholdId}-${issue.field}-${index}`} key={`${issue.code}-${index}`}>{issue.message}</p>)}
      </section>;
    })}
    {batch.appends.map((append) => {
      const responseRows = (plusOneDrafts[append.clientHouseholdId] ?? []).slice(0, append.plusOneSlotsToAdd);
      const conflict = conflicts.get(append.clientHouseholdId);
      const cardIssues = issuesFor(issues, append.clientHouseholdId);
      return <section
        id={`guest-list-card-${append.clientHouseholdId}`}
        tabIndex={-1}
        className={`guest-list-card${conflict ? ' guest-list-card--conflict' : ''}`}
        key={append.clientHouseholdId}
      >
        <h4>Add to {target?.label ?? 'selected household'}</h4>
        {conflict && <div role="alert">
          <p><strong>Review required:</strong> this household is {conflict}.</p>
          {conflict === 'changed' && target && <button type="button" className="button button--secondary" onClick={() => onAcceptConflict?.(append.clientHouseholdId)}>
            Accept current household and review again
          </button>}
          {conflict !== 'changed' && <p>Choose another household or convert these guests into new invitations.</p>}
        </div>}
        {append.namedInvitees.map((invitee) => <div key={invitee.clientInviteeId}>
          <label id={`guest-list-field-${invitee.clientInviteeId}-namedInvitees.displayName`} tabIndex={-1}>
            Guest name
            <input
              value={invitee.displayName}
              onChange={(event) => onChange(updateNamedInvitee(
                batch,
                append.clientHouseholdId,
                invitee.clientInviteeId,
                event.target.value,
              ))}
            />
          </label>
          {responded && <label id={`guest-list-field-${invitee.clientInviteeId}-namedInvitees.attendance`} tabIndex={-1}>
            Attendance for {invitee.displayName}
            <select
              aria-label={`Attendance for ${invitee.displayName}`}
              value={invitee.attendance ?? ''}
              onChange={(event) => {
                const next = attendance(event.target.value);
                onChange({
                  ...batch,
                  appends: batch.appends.map((current) => current.clientHouseholdId === append.clientHouseholdId
                    ? {
                      ...current,
                      namedInvitees: current.namedInvitees.map((item) => item.clientInviteeId === invitee.clientInviteeId
                        ? { ...item, ...(next ? { attendance: next } : { attendance: undefined }) }
                        : item),
                    }
                    : current),
                });
              }}
            >
              <option value="">Choose attendance</option>
              <option value="attending">Attending</option>
              <option value="declined">Not attending</option>
            </select>
          </label>}
        </div>)}
        <label id={`guest-list-field-${append.clientHouseholdId}-plusOneSlots`} tabIndex={-1}>
          Additional plus-one slots
          <input
            type="number"
            min="0"
            max="10"
            value={append.plusOneSlotsToAdd}
            onChange={(event) => {
              const slots = Math.min(10, Math.max(0, Number(event.target.value) || 0));
              onChange({
                ...batch,
                appends: batch.appends.map((current) => current.clientHouseholdId === append.clientHouseholdId
                  ? { ...current, plusOneSlotsToAdd: slots, newPlusOneResponses: undefined }
                  : current),
              });
              if (!responded) return;
              const currentRows = plusOneDrafts[append.clientHouseholdId] ?? [];
              const rows = [...currentRows];
              while (rows.length < slots) {
                rows.push({ clientInviteeId: clientId(), attendance: null, displayName: '' });
              }
              // Keep surplus rows in draft memory. Reducing and then restoring
              // slots therefore never changes an existing plus-one's client ID.
              onPlusOneDrafts(append.clientHouseholdId, rows);
            }}
          />
        </label>
        {responded && responseRows.map((response, index) => <div key={response.clientInviteeId}>
          <label id={`guest-list-field-${response.clientInviteeId}-newPlusOneResponses.attendance`} tabIndex={-1}>
            Attendance for new plus-one {index + 1}
            <select
              value={response.attendance ?? ''}
              onChange={(event) => {
                const next = attendance(event.target.value) ?? null;
                onPlusOneDrafts(append.clientHouseholdId, (plusOneDrafts[append.clientHouseholdId] ?? []).map((item) => item.clientInviteeId === response.clientInviteeId
                  ? { ...item, attendance: next, displayName: next === 'attending' ? item.displayName : '' }
                  : item));
              }}
            >
              <option value="">Choose attendance</option>
              <option value="attending">Attending</option>
              <option value="declined">Not attending</option>
            </select>
          </label>
          {response.attendance === 'attending' && <label id={`guest-list-field-${response.clientInviteeId}-newPlusOneResponses.displayName`} tabIndex={-1}>
            Name for attending plus-one {index + 1}
            <input
              value={response.displayName}
              onChange={(event) => onPlusOneDrafts(append.clientHouseholdId, (plusOneDrafts[append.clientHouseholdId] ?? []).map((item) => item.clientInviteeId === response.clientInviteeId
                ? { ...item, displayName: event.target.value }
                : item))}
            />
          </label>}
        </div>)}
        {cardIssues.map((issue, index) => <p className="guest-list-field-error" id={`guest-list-issue-target-${append.clientHouseholdId}-${issue.field}-${index}`} key={`${issue.code}-${index}`}>{issue.message}</p>)}
      </section>;
    })}
    <div className="guest-list-workspace__actions">
      <button type="button" className="button button--secondary" onClick={onBack}>Back</button>
      <button type="button" className="button button--primary" disabled={busy} onClick={onReview}>Review guests</button>
    </div>
  </div>;
}
