import { describe, expect, it } from 'vitest';

import { MANAGER_BULK_SELECTION_MAX } from '../../shared/constants';
import {
  selectionCapacityMessage,
  transitionSelection,
} from '../../src/features/gallery/selection-state';

describe('gallery selection transitions', () => {
  it('selects and deselects without mutating the current set', () => {
    const empty = new Set<string>();
    const selected = transitionSelection(empty, {
      type: 'toggle',
      id: 'photo-a',
      label: 'First dance',
    });

    expect([...empty]).toEqual([]);
    expect([...selected.next]).toEqual(['photo-a']);
    expect(selected.next).not.toBe(empty);
    expect(selected.message).toBe('First dance selected. 1 selected.');

    const deselected = transitionSelection(selected.next, {
      type: 'toggle',
      id: 'photo-a',
      label: 'First dance',
    });
    expect([...selected.next]).toEqual(['photo-a']);
    expect([...deselected.next]).toEqual([]);
    expect(deselected.message).toBe('First dance deselected. 0 selected.');
  });

  it('selects many IDs and reports the resulting total', () => {
    const current = new Set(['photo-a']);
    const transition = transitionSelection(current, {
      type: 'select-many',
      ids: ['photo-a', 'photo-b', 'photo-c'],
      label: 'these results',
    });

    expect([...current]).toEqual(['photo-a']);
    expect([...transition.next]).toEqual(['photo-a', 'photo-b', 'photo-c']);
    expect(transition.message).toBe(
      '2 photos selected from these results. 3 selected in total.',
    );
  });

  it('clears a whole moment when every photo in it is already selected', () => {
    const current = new Set(['before', 'moment-a', 'moment-b']);
    const transition = transitionSelection(current, {
      type: 'toggle-moment',
      ids: ['moment-a', 'moment-b'],
    });

    expect([...current]).toEqual(['before', 'moment-a', 'moment-b']);
    expect([...transition.next]).toEqual(['before']);
    expect(transition.message).toBe(
      '2 photos cleared from this moment. 1 selected in total.',
    );
  });

  it('truncates additions at the cap and derives all capacity copy from the shared limit', () => {
    const current = new Set(Array.from(
      { length: MANAGER_BULK_SELECTION_MAX - 1 },
      (_, index) => `selected-${index}`,
    ));
    const transition = transitionSelection(current, {
      type: 'select-many',
      ids: ['new-a', 'new-b'],
      label: 'these results',
    });

    expect(current.size).toBe(MANAGER_BULK_SELECTION_MAX - 1);
    expect(transition.next.size).toBe(MANAGER_BULK_SELECTION_MAX);
    expect(transition.next.has('new-a')).toBe(true);
    expect(transition.next.has('new-b')).toBe(false);
    expect(transition.message).toBe(
      `1 of 2 these results selected. ${selectionCapacityMessage()}`,
    );
    expect(selectionCapacityMessage()).toBe(
      `${MANAGER_BULK_SELECTION_MAX} photos is the most you can act on at once. Add these first, then select more.`,
    );
  });

  it('returns a new capped set and capacity message when one more photo is selected', () => {
    const current = new Set(Array.from(
      { length: MANAGER_BULK_SELECTION_MAX },
      (_, index) => `selected-${index}`,
    ));
    const transition = transitionSelection(current, {
      type: 'toggle',
      id: 'one-too-many',
      label: 'One too many',
    });

    expect(transition.next).not.toBe(current);
    expect(transition.next).toEqual(current);
    expect(transition.next.has('one-too-many')).toBe(false);
    expect(transition.message).toBe(selectionCapacityMessage());
  });
});
