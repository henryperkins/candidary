import { describe, expect, it } from 'vitest';

import { autosaveStatusText } from '../../src/components/AutosaveStatus';

const blocking = { label: 'Event name', message: 'Enter an event name.' };

describe('autosave status text', () => {
  it('keeps the visible chip short and the announcement domain-specific', () => {
    expect(autosaveStatusText('Event settings', { status: 'saved', failure: null }, null))
      .toEqual({ visible: 'Saved', announcement: 'Event settings saved' });
    expect(autosaveStatusText('Event appearance', { status: 'saved', failure: null }, null).announcement)
      .toBe('Event appearance saved');
  });

  it('reads scheduled and saving as the same in-progress state', () => {
    const scheduled = autosaveStatusText('Event settings', { status: 'scheduled', failure: null }, null);
    const saving = autosaveStatusText('Event settings', { status: 'saving', failure: null }, null);
    expect(scheduled).toEqual({ visible: 'Saving…', announcement: 'Saving event settings' });
    expect(saving).toEqual(scheduled);
  });

  it('names the blocking field when the draft cannot be sent', () => {
    expect(autosaveStatusText('Event settings', { status: 'invalid', failure: null }, blocking))
      .toEqual({
        visible: 'Fix the highlighted field to save.',
        announcement: 'Event settings can’t save. Event name: Enter an event name.',
      });
  });

  it('falls back to the generic invalid announcement when no field is named', () => {
    expect(autosaveStatusText('Event appearance', { status: 'invalid', failure: null }, null).announcement)
      .toBe('Event appearance can’t save. Fix the highlighted field.');
  });

  it('announces a failure with its domain and its message', () => {
    expect(autosaveStatusText(
      'Event settings',
      { status: 'failed', failure: { message: 'The network dropped.', retryable: true } },
      null,
    )).toEqual({
      visible: 'Couldn’t save.',
      announcement: 'Event settings couldn’t save. The network dropped.',
    });
  });
});
