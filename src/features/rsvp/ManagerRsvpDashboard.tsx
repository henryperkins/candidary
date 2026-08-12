import { Search } from 'lucide-react';

import type {
  RsvpHouseholdFilter,
  RsvpHouseholdListItem,
  RsvpSummary,
} from '../../../shared/contracts';

type Total = { key: keyof RsvpSummary; label: string };

// The eight approved totals. All eight are server-derived and none of them is dropped; what changed is
// that two of them lead. Two columns of four put the 844px fold inside this grid, so a phone showed six
// numbers and not one household — and the reason a host opens this on a phone is almost always who
// still has not answered. The two totals that imply an action come first and stay full size; the other
// six follow as a scrolling row of chips. From 761 the stylesheet dissolves both groups and `order`
// restores the sequence below: how many people were invited, then what they have said, then how many
// households are still out.
const LEAD_TOTALS = [
  { key: 'awaitingResponse', label: 'Awaiting response' },
  { key: 'householdsAwaitingResponse', label: 'Households awaiting response' },
] as const satisfies ReadonlyArray<Total>;

const REST_TOTALS = [
  { key: 'invitedCapacity', label: 'Invited capacity' },
  { key: 'namedInvitees', label: 'Named invitees' },
  { key: 'plusOneCapacity', label: 'Plus-one capacity' },
  { key: 'attending', label: 'Attending' },
  { key: 'declined', label: 'Declined' },
  { key: 'householdsResponded', label: 'Households responded' },
] as const satisfies ReadonlyArray<Total>;

// "2 attending · 0 not attending · 0 awaiting" is 44 characters under every household name, and a real
// name wraps to two lines above it. The one number that decides whether to act is last and weighs the
// same as the two that do not. The system's own rule is that numbers are concrete, not exhaustive: a
// zero here is noise a host reads past on every row, so outstanding leads and empty segments go.
function householdCounts(household: RsvpHouseholdListItem): string {
  const segments = [
    household.awaitingResponse > 0 ? `${household.awaitingResponse} awaiting` : null,
    household.attending > 0 ? `${household.attending} attending` : null,
    household.declined > 0 ? `${household.declined} not attending` : null,
  ].filter((segment): segment is string => segment !== null);
  return segments.length > 0 ? segments.join(' · ') : 'No guests yet';
}

const STATES: ReadonlyArray<{ value: RsvpHouseholdFilter; label: string }> = [
  { value: 'all', label: 'All households' },
  { value: 'responded', label: 'Responded' },
  { value: 'awaiting', label: 'Awaiting response' },
  { value: 'archived', label: 'Archived households' },
];

interface ManagerRsvpDashboardProps {
  summary: RsvpSummary | null;
  households: RsvpHouseholdListItem[];
  nextCursor: string | null;
  loading: boolean;
  query: string;
  state: RsvpHouseholdFilter;
  selectedId: string | null;
  exportHref: string;
  onQueryChange: (value: string) => void;
  onStateChange: (value: RsvpHouseholdFilter) => void;
  onOpenHousehold: (householdId: string) => void;
  onLoadMore: () => void;
}

export function ManagerRsvpDashboard({
  summary,
  households,
  nextCursor,
  loading,
  query,
  state,
  selectedId,
  exportHref,
  onQueryChange,
  onStateChange,
  onOpenHousehold,
  onLoadMore,
}: ManagerRsvpDashboardProps) {
  return <div className="rsvp-manager__dashboard">
    <div className="rsvp-manager__totals">
      <div className="rsvp-manager__totals--lead">
        {LEAD_TOTALS.map(({ key, label }) => <div className="rsvp-total" role="group" aria-label={label} key={key}>
          <strong>{summary ? summary[key] : '—'}</strong>
          <span>{label}</span>
        </div>)}
      </div>
      {/* A scrolling region has to be reachable without a pointer, so the row is a labelled group that
          takes focus and answers the arrow keys. From 761 the stylesheet gives it `display: contents`,
          which takes it out of the tab order along with its box — there is nothing left to scroll. */}
      <div
        className="rsvp-manager__totals--rest"
        role="group"
        aria-label="More guest-list totals"
        tabIndex={0}
      >
        {REST_TOTALS.map(({ key, label }) => <div className="rsvp-total" role="group" aria-label={label} key={key}>
          <strong>{summary ? summary[key] : '—'}</strong>
          <span>{label}</span>
        </div>)}
      </div>
    </div>

    <div className="rsvp-manager__filters">
      <div className="rsvp-manager__search">
        <label htmlFor="rsvp-manager-query">Search guest list</label>
        <span className="rsvp-manager__search-field">
          <Search aria-hidden="true" />
          <input
            id="rsvp-manager-query"
            type="search"
            value={query}
            autoComplete="off"
            placeholder="Household or guest name"
            onChange={(change) => onQueryChange(change.target.value)}
          />
        </span>
      </div>
      <div className="rsvp-manager__state">
        <label htmlFor="rsvp-manager-state">Response status</label>
        <select
          id="rsvp-manager-state"
          value={state}
          onChange={(change) => onStateChange(change.target.value as RsvpHouseholdFilter)}
        >
          {STATES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
    </div>

    {households.length === 0
      ? <p className="rsvp-manager__empty">{loading
        ? 'Loading households…'
        : 'No households match these filters yet.'}</p>
      : <ul className="rsvp-household-list">
        {households.map((household) => <li key={household.id}>
          <button
            type="button"
            className={household.id === selectedId ? 'active' : ''}
            aria-pressed={household.id === selectedId}
            onClick={() => onOpenHousehold(household.id)}
          >
            <span className="rsvp-household-list__label">{household.label}</span>
            <span className="rsvp-household-list__counts">{householdCounts(household)}</span>
            {household.archivedAt && <span className="rsvp-household-list__flag">Archived</span>}
          </button>
        </li>)}
      </ul>}

    {nextCursor && <div className="rsvp-manager__more">
      <button
        type="button"
        className="button button--secondary"
        disabled={loading}
        onClick={onLoadMore}
      >Load more households</button>
    </div>}

    {/* A plain link, not a fetch: the CSV is generated by the server for the current roster and
        downloaded by the browser like any other file. It follows the list it exports rather than
        taking a full-width row between the filters and the first household. */}
    <div className="rsvp-manager__export">
      <a className="button button--secondary" href={exportHref} download>Download current CSV</a>
    </div>
  </div>;
}
