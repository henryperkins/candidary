import { MANAGER_BULK_SELECTION_MAX } from '../../../shared/constants';

export type GallerySelectionAction =
  | { type: 'toggle'; id: string; label: string }
  | { type: 'select-many'; ids: readonly string[]; label: string }
  | { type: 'toggle-moment'; ids: readonly string[] }
  | { type: 'clear'; announce?: boolean };

export interface GallerySelectionTransition {
  next: ReadonlySet<string>;
  message: string | null;
}

export function selectionCapacityMessage(): string {
  return `${MANAGER_BULK_SELECTION_MAX} photos is the most you can act on at once. Add these first, then select more.`;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function pluralPhotos(count: number): string {
  return `${count} photo${count === 1 ? '' : 's'}`;
}

/** Pure, bounded selection state transitions for Library event handlers. */
export function transitionSelection(
  current: ReadonlySet<string>,
  action: GallerySelectionAction,
): GallerySelectionTransition {
  const next = new Set(current);
  if (action.type === 'clear') {
    next.clear();
    return {
      next,
      message: current.size > 0 && action.announce !== false ? 'Selection cleared.' : null,
    };
  }

  if (action.type === 'toggle') {
    if (next.has(action.id)) {
      next.delete(action.id);
      return {
        next,
        message: `${action.label} deselected. ${next.size} selected.`,
      };
    }
    if (next.size >= MANAGER_BULK_SELECTION_MAX) {
      return { next, message: selectionCapacityMessage() };
    }
    next.add(action.id);
    return {
      next,
      message: `${action.label} selected. ${next.size} selected.`,
    };
  }

  const ids = uniqueIds(action.ids);
  if (action.type === 'toggle-moment' && ids.every((id) => next.has(id))) {
    for (const id of ids) next.delete(id);
    return {
      next,
      message: `${pluralPhotos(ids.length)} cleared from this moment. ${next.size} selected in total.`,
    };
  }

  const unselected = ids.filter((id) => !current.has(id));
  let added = 0;
  for (const id of unselected) {
    if (next.size >= MANAGER_BULK_SELECTION_MAX) break;
    next.add(id);
    added += 1;
  }
  const capped = added < unselected.length;
  if (action.type === 'select-many') {
    return {
      next,
      message: capped
        ? `${added} of ${ids.length} ${action.label} selected. ${selectionCapacityMessage()}`
        : `${pluralPhotos(added)} selected from ${action.label}. ${next.size} selected in total.`,
    };
  }
  return {
    next,
    message: capped
      ? `${added} of ${ids.length} photos in this moment selected. ${selectionCapacityMessage()}`
      : `${pluralPhotos(added)} selected from this moment. ${next.size} selected in total.`,
  };
}
