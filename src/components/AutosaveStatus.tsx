import type { AutosaveState } from '../features/settings/autosave-queue';

/**
 * One status surface for both persistence domains. The chip stays short enough
 * to sit beside a heading at 320px; the announcement names its domain, because
 * Saved on its own is meaningless when two of these can be live at once.
 */

interface BlockingField {
  label: string;
  message: string;
}

export function autosaveStatusText(
  label: string,
  state: AutosaveState,
  blockingField: BlockingField | null,
): { visible: string; announcement: string } {
  const domain = label.toLowerCase();
  if (state.status === 'invalid') {
    return {
      visible: 'Fix the highlighted field to save.',
      announcement: blockingField
        ? label + ' can’t save. ' + blockingField.label + ': ' + blockingField.message
        : label + ' can’t save. Fix the highlighted field.',
    };
  }
  if (state.status === 'failed') {
    return {
      visible: 'Couldn’t save.' + (state.failure ? ' ' + state.failure.message : ''),
      announcement: label + ' couldn’t save.' + (state.failure ? ' ' + state.failure.message : ''),
    };
  }
  if (state.status === 'saved') {
    return { visible: 'Saved', announcement: label + ' saved' };
  }
  return { visible: 'Saving…', announcement: 'Saving ' + domain };
}

interface AutosaveStatusProps {
  label: string;
  state: AutosaveState;
  blockingField?: BlockingField | null;
  onRetry(): void;
  className?: string;
  live?: boolean;
}

export function AutosaveStatus({
  label,
  state,
  blockingField = null,
  onRetry,
  className,
  live = true,
}: AutosaveStatusProps) {
  const { visible, announcement } = autosaveStatusText(label, state, blockingField);
  // Retry is a real button and lives outside the live region: inserting it must
  // not re-announce the message, and a credential or lifecycle failure escalates
  // to the manager's recovery notice instead of offering a repeat that cannot work.
  const retryable = state.status === 'failed' && state.failure?.retryable === true;
  return <div className={className ? 'autosave-status ' + className : 'autosave-status'}>
    <div
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      aria-atomic={live ? 'true' : undefined}
    >
      <span className={'autosave-status__chip autosave-status__chip--' + state.status} aria-hidden="true">
        {visible}
      </span>
      <span className="sr-only">{announcement}</span>
    </div>
    {retryable && <button
      type="button"
      className="autosave-status__retry"
      aria-label={'Retry ' + label.toLocaleLowerCase()}
      onClick={onRetry}
    >Retry</button>}
  </div>;
}
