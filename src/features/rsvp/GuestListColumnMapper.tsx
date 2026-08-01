import type { GuestListColumn, GuestListLocalIssue, GuestListMapping, parseGuestListSource } from './guest-list-intake';

const FIELDS: Array<{ value: GuestListColumn; label: string; required?: boolean }> = [
  { value: 'guestName', label: 'Guest name', required: true },
  { value: 'household', label: 'Household' },
  { value: 'plusOneSlots', label: 'Plus-one slots' },
  { value: 'householdKey', label: 'Household key (advanced)' },
];

export function GuestListColumnMapper({ parsed, mapping, issues, onMapping, onHeaderChange }: {
  parsed: ReturnType<typeof parseGuestListSource>; mapping: GuestListMapping; issues: GuestListLocalIssue[]; onMapping(value: GuestListMapping): void; onHeaderChange(value: boolean): void;
}) {
  const headers = parsed.firstRowIsHeader
    ? parsed.rows[0] ?? []
    : Array.from({ length: parsed.rows[0]?.length ?? 0 }, (_, index) => `Column ${index + 1}`);
  return <div className="guest-list-mapper">
    <p>Map each source column. Guest name is required; household key is available only when Household is mapped.</p>
    <label>
      <input
        type="checkbox"
        checked={parsed.firstRowIsHeader}
        onChange={(event) => onHeaderChange(event.target.checked)}
      /> First row contains column labels
    </label>
    {FIELDS.map(({ value, label, required }) => <label key={value}>
      {label}{required ? ' (required)' : ''}
      <select id={`guest-list-mapping-${value}`} value={mapping[value] ?? ''} onChange={(event) => {
        const index = event.target.value === '' ? null : Number(event.target.value);
        const next = { ...mapping, [value]: index };
        if (value === 'household' && index === null) next.householdKey = null;
        onMapping(next);
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
