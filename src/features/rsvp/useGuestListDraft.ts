import { useCallback, useReducer } from 'react';

import type { RsvpRosterBatchDraft } from '../../../shared/contracts';

import type { GuestListGroup, PlainGuest } from './guest-list-intake';

interface GuestListDraftState {
  source: string;
  people: PlainGuest[];
  groups: GuestListGroup[];
  batch: RsvpRosterBatchDraft | null;
  dirty: boolean;
}

type Action =
  | { type: 'source'; value: string }
  | { type: 'people'; value: PlainGuest[] }
  | { type: 'groups'; value: GuestListGroup[] }
  | { type: 'batch'; value: RsvpRosterBatchDraft | null }
  | { type: 'dirty'; value: boolean }
  | { type: 'reset' };

const initialState: GuestListDraftState = {
  source: '',
  people: [],
  groups: [],
  batch: null,
  dirty: false,
};

function reducer(state: GuestListDraftState, action: Action): GuestListDraftState {
  switch (action.type) {
    case 'source':
      return { ...state, source: action.value, dirty: true };
    case 'people':
      return { ...state, people: action.value, dirty: true };
    case 'groups':
      return { ...state, groups: action.value, dirty: true };
    case 'batch':
      return { ...state, batch: action.value, dirty: true };
    case 'dirty':
      return state.dirty === action.value ? state : { ...state, dirty: action.value };
    case 'reset':
      return initialState;
  }
}

// Network-free reducer state keeps all browser-only client addresses intact
// while the host moves backward and forward through the workspace.
export function useGuestListDraft() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return {
    ...state,
    setSource: (value: string) => dispatch({ type: 'source', value }),
    setPeople: (value: PlainGuest[]) => dispatch({ type: 'people', value }),
    setGroups: (value: GuestListGroup[]) => dispatch({ type: 'groups', value }),
    setBatch: (value: RsvpRosterBatchDraft | null) => dispatch({ type: 'batch', value }),
    setDirty: (value: boolean) => dispatch({ type: 'dirty', value }),
    reset,
  };
}
