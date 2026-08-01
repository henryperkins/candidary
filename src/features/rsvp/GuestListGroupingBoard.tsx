import { useState } from 'react';

import { clientId, type GuestListGroup } from './guest-list-intake';

export function GuestListGroupingBoard({ people, groups, onGroups, automaticIndividuals }: {
  people: Array<{ id: string; name: string }>; groups: GuestListGroup[]; onGroups(value: GuestListGroup[]): void;
  automaticIndividuals?: Array<{ id: string; name: string }>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const grouped = new Set(groups.flatMap((group) => group.memberIds));
  function group() {
    if (selected.length < 2) return;
    const names = people.filter((person) => selected.includes(person.id)).map((person) => person.name);
    onGroups([...groups, { id: clientId(), label: names.join(' and '), memberIds: selected }]);
    setSelected([]);
  }
  return <div className="guest-list-grouping">
    <p>Select two or more people to make one invitation. We never infer households.</p>
    <ul aria-label="Ungrouped people">
      {people.filter((person) => !grouped.has(person.id)).map((person) => <li key={person.id}>
        <label><input type="checkbox" checked={selected.includes(person.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, person.id] : current.filter((id) => id !== person.id))} /> {person.name}</label>
      </li>)}
    </ul>
    <button type="button" className="button button--secondary" disabled={selected.length < 2} onClick={group}>Group as one invitation</button>
    {groups.length > 0 && <ul aria-label="Staged invitations">{groups.map((groupedPeople) => <li key={groupedPeople.id}>
      <strong>{groupedPeople.label}</strong> · {groupedPeople.memberIds.length} guests
      <button type="button" className="text-button" onClick={() => onGroups(groups.filter((group) => group.id !== groupedPeople.id))}>Ungroup {groupedPeople.label}</button>
    </li>)}</ul>}
    {automaticIndividuals && <p><strong>Will become individual invitations:</strong> {automaticIndividuals.map((person) => person.name).join(', ') || 'None'}</p>}
  </div>;
}
