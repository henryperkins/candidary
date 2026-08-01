import { useEffect, useRef } from 'react';

import type {
  RsvpHouseholdDetail,
  RsvpRosterBatchIssue,
  RsvpRosterBatchPreviewResponse,
} from '../../../shared/contracts';

import { countLabel } from './guest-list-copy';

function issueId(issue: RsvpRosterBatchIssue, index: number): string {
  return `guest-list-issue-${issue.clientHouseholdId ?? 'batch'}-${issue.clientInviteeId ?? issue.field}-${index}`;
}

function issueTarget(issue: RsvpRosterBatchIssue): string {
  if (issue.clientInviteeId) return `guest-list-field-${issue.clientInviteeId}-${issue.field}`;
  if (issue.clientHouseholdId) return `guest-list-card-${issue.clientHouseholdId}`;
  return 'guest-list-workspace-title';
}

export function GuestListBatchReview({
  preview,
  automaticIndividuals,
  target,
  onBack,
  onCommit,
  onIssue,
  busy,
  issues,
}: {
  preview: RsvpRosterBatchPreviewResponse;
  automaticIndividuals: Array<{ name: string }>;
  target: RsvpHouseholdDetail | null;
  onBack(): void;
  onCommit(): void;
  onIssue(issue: RsvpRosterBatchIssue): void;
  busy: boolean;
  issues: RsvpRosterBatchIssue[];
}) {
  const { totals } = preview;

  return <div className="guest-list-review">
    <p>{countLabel(totals.householdsCreated, 'new household')} and {countLabel(totals.householdsUpdated, 'updated household')} · {countLabel(totals.namedInviteesAdded, 'named guest')} · {countLabel(totals.plusOneCapacityAdded, 'plus-one slot')}.</p>
    {automaticIndividuals.length > 0 && <p>Automatic individual invitations: {automaticIndividuals.map((person) => person.name).join(', ')}</p>}
    {target && <p>Target existing household: <strong>{target.label}</strong>.</p>}
    {issues.length > 0 && <GuestListIssueSummary
      issues={issues}
      onIssue={onIssue}
      focusKey={preview.previewDigest}
    />}
    <div className="guest-list-workspace__actions">
      <button type="button" className="button button--secondary" disabled={busy} onClick={onBack}>Back to details</button>
      {preview.canCommit && <button type="button" className="button button--primary" disabled={busy} onClick={onCommit}>
        Add {countLabel(totals.namedInviteesAdded + totals.plusOneCapacityAdded, 'guest')} across {countLabel(totals.householdsCreated + totals.householdsUpdated, 'household')}
      </button>}
    </div>
  </div>;
}

export function GuestListIssueSummary({
  issues,
  onIssue,
  focusKey,
}: {
  issues: RsvpRosterBatchIssue[];
  onIssue(issue: RsvpRosterBatchIssue): void;
  focusKey?: string;
}) {
  const blocking = issues.filter((issue) => issue.severity === 'blocking');
  const firstBlocking = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (focusKey !== undefined) firstBlocking.current?.focus();
  }, [focusKey]);

  return <section aria-label="Guest list review issues" className="guest-list-issues">
    <h4>{blocking.length
      ? `${countLabel(blocking.length, 'issue')} ${blocking.length === 1 ? 'needs' : 'need'} attention`
      : 'Advisory notices'}</h4>
    <ul>{issues.map((issue, index) => <li key={issueId(issue, index)}>
      <a
        href={`#${issueTarget(issue)}`}
        className="text-button"
        ref={issue === blocking[0] ? firstBlocking : undefined}
        onClick={(event) => {
          event.preventDefault();
          onIssue(issue);
        }}
      ><strong>{issue.severity === 'blocking' ? 'Fix needed' : 'Notice'}:</strong> {issue.message}</a>
    </li>)}</ul>
  </section>;
}
