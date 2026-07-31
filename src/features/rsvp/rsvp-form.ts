import type {
  RsvpHouseholdView,
  RsvpSubmissionInvitee,
} from '../../../shared/contracts';

export interface RsvpDraftValue {
  attendance: 'attending' | 'declined' | null;
  displayName: string;
}
export type RsvpDraft = Record<string, RsvpDraftValue>;

export function createHouseholdDraft(household: RsvpHouseholdView): RsvpDraft {
  return Object.fromEntries(household.invitees.map((invitee) => [
    invitee.id,
    {
      attendance: invitee.attendance === 'pending' ? null : invitee.attendance,
      displayName: invitee.displayName ?? '',
    },
  ]));
}

export function validateHouseholdDraft(
  household: RsvpHouseholdView,
  draft: Record<string, RsvpDraftValue>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const invitee of household.invitees) {
    const value = draft[invitee.id];
    if (!value?.attendance) {
      errors[invitee.id] = 'Choose attending or not attending.';
    } else if (
      invitee.kind === 'plus_one'
      && value.attendance === 'attending'
      && (value.displayName.trim().length < 1 || value.displayName.trim().length > 80)
    ) {
      errors[`${invitee.id}.displayName`] = 'Enter this guest’s name.';
    }
  }
  return errors;
}

export function submissionInvitees(
  household: RsvpHouseholdView,
  draft: RsvpDraft,
): RsvpSubmissionInvitee[] {
  return household.invitees.map((invitee) => {
    const value = draft[invitee.id]!;
    return {
      id: invitee.id,
      attendance: value.attendance!,
      displayName: invitee.kind === 'plus_one' && value.attendance === 'attending'
        ? value.displayName.trim()
        : invitee.kind === 'named'
          ? invitee.displayName
          : null,
    };
  });
}
