import { Minus, Plus, X } from 'lucide-react';
import type { MouseEvent } from 'react';

import { MANAGER_BULK_SELECTION_MAX } from '../../../shared/constants';
import { selectionCapacityMessage, selectionCountMessage } from './selection-state';

interface SelectionTrayProps {
  count: number;
  /** True while a pick write is in flight; both verbs disable and relabel together. */
  busy: boolean;
  /** A running Manager Undo owns the mutation slot; Clear remains a local escape. */
  mutationLocked?: boolean;
  onAdd(input: SelectionTrayInput): void;
  onRemove(input: SelectionTrayInput): void;
  onClear(): void;
}

export type SelectionTrayInput = 'keyboard' | 'pointer';

function activationInput(event: MouseEvent<HTMLButtonElement>): SelectionTrayInput {
  return event.detail === 0 ? 'keyboard' : 'pointer';
}

/**
 * The two album verbs, shown only while a selection exists.
 *
 * Idle it would be an opaque bar holding a zero, docked over the controls that start a
 * selection in the first place — at 320×568 it covered `Album picks` and `Select photos`
 * outright. The count therefore lives in the `Album picks (n)` filter, which is in the
 * flow and covers nothing, and this appears only when it has something to say.
 *
 * Both verbs ship because a selection is a *set*, not an intention: `Select all results`
 * over a partly-picked page has to be able to go either way, and the write reports which
 * photos it actually changed so neither verb has to guess.
 */
export function SelectionTray({
  count,
  busy,
  mutationLocked = false,
  onAdd,
  onRemove,
  onClear,
}: SelectionTrayProps) {
  const countMessage = count >= MANAGER_BULK_SELECTION_MAX
    ? selectionCapacityMessage()
    : selectionCountMessage(count);
  return <div className="selection-tray" role="region" aria-label="Album">
    <div className="selection-tray__inner">
      <div className="selection-tray__count">
        <strong>{countMessage}</strong>
        <span>Pick changes Album membership only. Remove from Album keeps every delivered photo in Library; neither action publishes to the Guest gallery.</span>
      </div>
      <div className="selection-tray__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy || mutationLocked}
          onClick={(event) => onAdd(activationInput(event))}
        ><Plus aria-hidden="true" /> {busy ? 'Working…' : `Pick for Album (${count})`}</button>
        <button
          type="button"
          className="button button--secondary"
          disabled={busy || mutationLocked}
          onClick={(event) => onRemove(activationInput(event))}
        ><Minus aria-hidden="true" /> {busy ? 'Working…' : `Remove from Album (${count})`}</button>
        <button
          type="button"
          className="selection-tray__clear"
          disabled={busy}
          onClick={onClear}
        ><X aria-hidden="true" /> Clear selection</button>
      </div>
    </div>
  </div>;
}
