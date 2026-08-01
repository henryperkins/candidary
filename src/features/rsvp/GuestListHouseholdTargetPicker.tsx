import { useEffect, useRef, useState } from 'react';

import type {
  RsvpHouseholdDetail,
  RsvpHouseholdListItem,
  RsvpHouseholdListPage,
} from '../../../shared/contracts';
import { api } from '../../app/api';

export function GuestListHouseholdTargetPicker({
  eventId,
  target,
  onTarget,
  onSelectionPendingChange,
}: {
  eventId: string;
  target: RsvpHouseholdDetail | null;
  onTarget(value: RsvpHouseholdDetail | null): void;
  onSelectionPendingChange?(pending: boolean): void;
}) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<RsvpHouseholdListItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [error, setError] = useState('');
  const detailRequest = useRef<AbortController | null>(null);

  useEffect(() => () => {
    detailRequest.current?.abort();
    detailRequest.current = null;
    onSelectionPendingChange?.(false);
  }, [onSelectionPendingChange]);

  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      setSearchLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      setError('');
      const params = new URLSearchParams({ query: query.trim() });
      void api<RsvpHouseholdListPage>(
        `/api/manage/events/${eventId}/rsvp/households?${params.toString()}`,
        { signal: controller.signal },
      ).then((page) => {
        if (!controller.signal.aborted) setMatches(page.households);
      }).catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setMatches([]);
          setError(caught instanceof Error ? caught.message : 'Households could not be searched.');
        }
      }).finally(() => {
        if (!controller.signal.aborted) setSearchLoading(false);
      });
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [eventId, query]);

  const choices = matches;
  async function choose(id: string) {
    detailRequest.current?.abort();
    detailRequest.current = null;
    if (!id) {
      setSelectionLoading(false);
      onSelectionPendingChange?.(false);
      onTarget(null);
      setError('');
      return;
    }
    const choice = choices.find((household) => household.id === id);
    if (!choice) return;
    const controller = new AbortController();
    detailRequest.current = controller;
    setSelectionLoading(true);
    onSelectionPendingChange?.(true);
    setError('');
    try {
      // A list row is not enough to decide whether append attendance is
      // required. Always read the current manager-only household detail.
      const detail = await api<RsvpHouseholdDetail>(
        `/api/manage/events/${eventId}/rsvp/households/${choice.id}`,
        { signal: controller.signal },
      );
      if (detailRequest.current === controller && !controller.signal.aborted) onTarget(detail);
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : 'That household could not be selected.');
      }
    } finally {
      if (detailRequest.current === controller) {
        detailRequest.current = null;
        setSelectionLoading(false);
        onSelectionPendingChange?.(false);
      }
    }
  }

  const loading = searchLoading || selectionLoading;

  return <fieldset className="guest-list-target">
    <legend>Add to an existing household</legend>
    <p>Search the full guest list, then explicitly select the invitation to update.</p>
    <label htmlFor="guest-list-target-search">Search households</label>
    <input
      id="guest-list-target-search"
      value={query}
      onChange={(event) => setQuery(event.target.value)}
    />
    <label htmlFor="guest-list-target">Existing household target</label>
    <select
      id="guest-list-target"
      value={target?.id ?? ''}
      disabled={loading}
      onChange={(event) => void choose(event.target.value)}
    >
      <option value="">Create new invitations</option>
      {target && !choices.some((household) => household.id === target.id) && <option value={target.id}>
        {target.label} — key {target.householdKey} · selected
      </option>}
      {choices.map((household) => <option value={household.id} key={household.id}>
        {household.label} — key {household.householdKey} · {household.invitedCapacity} invited · {household.firstRespondedAt ? 'responded' : 'awaiting RSVP'}
      </option>)}
    </select>
    {searchLoading && <p role="status">Searching households…</p>}
    {selectionLoading && <p role="status">Loading selected household…</p>}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
