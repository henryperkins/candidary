import type { RsvpRosterBatchCommitResponse } from '../../../shared/contracts';

export interface AffectedHousehold {
  householdId: string;
  label: string;
}

export function GuestListCommitReceipt({
  receipt,
  affected,
  onReturn,
  onAddMore,
  onOpenHousehold,
}: {
  receipt: RsvpRosterBatchCommitResponse;
  affected: AffectedHousehold[];
  onReturn(): void;
  onAddMore(): void;
  onOpenHousehold(householdId: string): void;
}) {
  return <div className="guest-list-receipt">
    <div role="status" aria-live="polite">
      <p>Guest list updated{receipt.replayed ? ' (retry confirmed)' : ''}.</p>
      <ul>
        <li>{receipt.totals.householdsCreated} households created</li>
        <li>{receipt.totals.householdsUpdated} households updated</li>
        <li>{receipt.totals.namedInviteesAdded} named guests added</li>
        <li>{receipt.totals.plusOneCapacityAdded} plus-one slots added</li>
        <li>{receipt.totals.resultingInvitedCapacity} invited capacity</li>
      </ul>
    </div>
    {affected.length > 0 && <div className="guest-list-receipt__households">
      <strong>Open an affected household</strong>
      {affected.map((household) => <button
        type="button"
        className="text-button"
        key={household.householdId}
        onClick={() => onOpenHousehold(household.householdId)}
      >Open {household.label}</button>)}
    </div>}
    <div className="guest-list-workspace__actions">
      <button type="button" className="button button--secondary" onClick={onReturn}>Return to guest list</button>
      <button type="button" className="button button--primary" onClick={onAddMore}>Add more guests</button>
    </div>
  </div>;
}
