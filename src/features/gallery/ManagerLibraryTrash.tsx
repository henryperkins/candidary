import { RotateCcw, Trash2 } from 'lucide-react';
import type { ManagerTrashedMediaView } from '../../../shared/contracts';
import { formatRetentionDate, TIME_UNAVAILABLE } from '../../app/event-date-time';

export interface ManagerLibraryTrashProps {
  rows: readonly ManagerTrashedMediaView[];
  now: number;
  timeZone: string;
  pendingIds: ReadonlySet<string>;
  hasMore: boolean;
  loadingMore: boolean;
  onRestore(row: ManagerTrashedMediaView, origin: HTMLButtonElement): void;
  onLoadMore(): void;
  onBackToLibrary(): void;
}

/** Metadata only: recovery policy, reads, errors and mutations belong to Manager. */
export function ManagerLibraryTrash({ rows, now, timeZone, pendingIds, hasMore, loadingMore,
  onRestore, onLoadMore, onBackToLibrary }: ManagerLibraryTrashProps) {
  return <div className="manager-library-trash">
    <button type="button" className="button button--secondary" onClick={onBackToLibrary}>Back to Library</button>
    {!rows.length ? <div className="empty-state">
      <Trash2 aria-hidden="true" />
      <h3>Nothing in Trash.</h3>
      <p>Photos you remove stay here, and keep using this event's capacity, until you restore them or their recovery ends.</p>
    </div> : <ul className="trash-list">{rows.map(row => {
      const deadline = formatRetentionDate(row.restoreUntil, timeZone);
      const expired = Date.parse(row.restoreUntil) <= now;
      const name = row.caption || row.originalFilename;
      return <li key={row.id} data-intake-card={row.id} data-trash-media-id={row.id}>
        <div>
          <strong title={name}>{name}</strong>
          {row.caption && <small>{row.originalFilename}</small>}
          <small>From {row.guestName}</small>
          {expired ? <small className="trash-list__state">Recovery expired · cleanup pending</small>
            : <small className="trash-list__state">Restore until {deadline === null ? TIME_UNAVAILABLE
              : <time dateTime={row.restoreUntil}>{deadline}</time>}</small>}
        </div>
        {!expired && <button type="button" className="button button--secondary"
          aria-label={`Restore ${row.originalFilename}`} data-restore-media-id={row.id}
          disabled={pendingIds.has(row.id)} onClick={click => onRestore(row, click.currentTarget)}>
          <RotateCcw aria-hidden="true" /> {pendingIds.has(row.id) ? 'Restoring…' : 'Restore'}
        </button>}
      </li>;
    })}</ul>}
    {hasMore && <div className="media-more">
      <button type="button" className="button button--secondary" disabled={loadingMore} onClick={onLoadMore}>Load more</button>
    </div>}
  </div>;
}
