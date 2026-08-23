import { Minus, Plus, X } from 'lucide-react';

interface SelectionTrayProps {
  count: number;
  /** True while a pick write is in flight; both verbs disable and relabel together. */
  busy: boolean;
  onAdd(): void;
  onRemove(): void;
  onClear(): void;
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
export function SelectionTray({ count, busy, onAdd, onRemove, onClear }: SelectionTrayProps) {
  const photos = `${count} photo${count === 1 ? '' : 's'}`;
  return <div className="selection-tray" role="region" aria-label="Album">
    <div className="selection-tray__inner">
      <div className="selection-tray__count">
        <strong>{photos} selected</strong>
        <span>Adding does not publish anything, and removing keeps the delivered original.</span>
      </div>
      <div className="selection-tray__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={onAdd}
        ><Plus aria-hidden="true" /> {busy ? 'Working…' : `Add ${count} to album`}</button>
        <button
          type="button"
          className="button button--secondary"
          disabled={busy}
          onClick={onRemove}
        ><Minus aria-hidden="true" /> {busy ? 'Working…' : `Remove ${count} from album`}</button>
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
