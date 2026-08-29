import { X } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';

import { MANAGER_BULK_SELECTION_MAX } from '../../../shared/constants';
import { selectionCapacityMessage, selectionCountMessage } from './selection-state';

interface SelectionTrayAction {
  /** Already resolved for `busy`, because each axis names its own work: `Working…`, `Publishing…`. */
  label: string;
  icon: ReactNode;
  /**
   * Weight, when the slot's own is not the right one. Guest gallery's Publish is `approve` outside
   * the `Published` filter, matching the per-card verb it duplicates in bulk; a bulk action drawn
   * in a different colour from the card action it repeats reads as a different action.
   */
  variant?: 'primary' | 'secondary' | 'approve';
  onClick(input: SelectionTrayInput): void;
}

interface SelectionTrayProps {
  count: number;
  /** True while a write is in flight; both verbs disable and relabel together. */
  busy: boolean;
  /** A running Manager Undo owns the mutation slot; Clear remains a local escape. */
  mutationLocked?: boolean;
  /** Names the axis the tray acts on: `Album` in Library, `Guest gallery` in Guest gallery. */
  label?: string;
  primary: SelectionTrayAction;
  secondary: SelectionTrayAction;
  note: string;
  onClear(): void;
}

export type SelectionTrayInput = 'keyboard' | 'pointer';

function activationInput(event: MouseEvent<HTMLButtonElement>): SelectionTrayInput {
  return event.detail === 0 ? 'keyboard' : 'pointer';
}

/**
 * The two verbs of whichever axis is selecting, shown only while a selection exists.
 *
 * Idle it would be an opaque bar holding a zero, docked over the controls that start a
 * selection in the first place — at 320×568 it covered `Album picks` and `Select photos`
 * outright. The count therefore lives in the filter that owns it, which is in the flow and
 * covers nothing, and this appears only when it has something to say.
 *
 * Both verbs ship because a selection is a *set*, not an intention: `Select all results`
 * over a partly-picked page has to be able to go either way, and the write reports which
 * photos it actually changed so neither verb has to guess. Which verb takes the primary
 * slot is the caller's, because the useful one depends on the filter being looked at.
 */
export function SelectionTray({
  count,
  busy,
  mutationLocked = false,
  label = 'Album',
  primary,
  secondary,
  note,
  onClear,
}: SelectionTrayProps) {
  const countMessage = count >= MANAGER_BULK_SELECTION_MAX
    ? selectionCapacityMessage()
    : selectionCountMessage(count);
  return <div className="selection-tray" role="region" aria-label={label} aria-busy={busy || undefined}>
    <div className="selection-tray__inner">
      {/* The id is the one a capacity-blocked checkbox points `aria-describedby` at, and the tray
          is guaranteed to be on screen when it does: the block only happens at the ceiling, which
          cannot be reached without a selection. */}
      <div className="selection-tray__count" id="bulk-selection-status">
        <strong>{countMessage}</strong>
        <span>{note}</span>
      </div>
      <div className="selection-tray__actions">
        <button
          type="button"
          className={`button button--${primary.variant ?? 'primary'}`}
          disabled={busy || mutationLocked}
          onClick={(event) => primary.onClick(activationInput(event))}
        >{primary.icon} {primary.label}</button>
        <button
          type="button"
          className={`button button--${secondary.variant ?? 'secondary'}`}
          disabled={busy || mutationLocked}
          onClick={(event) => secondary.onClick(activationInput(event))}
        >{secondary.icon} {secondary.label}</button>
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
