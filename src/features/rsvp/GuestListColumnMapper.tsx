import type { GuestListColumn, GuestListLocalIssue, GuestListMapping, parseGuestListSource } from './guest-list-intake';

const FIELDS: Array<{ value: GuestListColumn; label: string; required?: boolean }> = [
  { value: 'guestName', label: 'Guest name', required: true },
  { value: 'household', label: 'Household' },
  { value: 'plusOneSlots', label: 'Plus-one slots' },
  { value: 'householdKey', label: 'Household key (advanced)' },
];

export function GuestListColumnMapper({ parsed, mapping, issues, onMapping }: {
  parsed: ReturnType<typeof parseGuestListSource>; mapping: GuestListMapping; issues: GuestListLocalIssue[]; onMapping(value: GuestListMapping): void;
}) {
  const headers = parsed.rows[0] ?? [];
  return <div className="guest-list-mapper">
    <p>Map each source column. Guest name is required; household key is available only when Household is mapped.</p>
    {FIELDS.map(({ value, label, required }) => <label key={value}>
      {label}{required ? ' (required)' : ''}
      <select value={mapping[value] ?? ''} onChange={(event) => {
        const index = event.target.value === '' ? null : Number(event.target.value);
        onMapping({ ...mapping, [value]: index });
      }} disabled={value === 'householdKey' && mapping.household === null}>
        <option value="">Not mapped</option>
        {headers.map((header, index) => <option value={index} key={`${header}-${index}`}>{header || `Column ${index + 1}`}</option>)}
      </select>
      {issues.filter((issue) => issue.field === value).map((issue) => <span className="guest-list-field-error" role="alert" key={issue.message}>{issue.message}</span>)}
    </label>)}
    <div className="guest-list-sample" aria-label="Source sample">
      {parsed.rows.slice(0, 6).map((row, index) => <p key={`${row.join('-')}-${index}`}>{row.join(' · ')}</p>)}
    </div>
  </div>;
}
