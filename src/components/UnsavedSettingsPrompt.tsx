import { useEffect, useRef } from 'react';

import type { DomainAutosaveState } from '../features/settings/autosave-queue';

interface UnsavedSettingsPromptProps {
  domains: readonly DomainAutosaveState[];
  onLeave(): void;
  leaveDisabled?: boolean;
  // Offered only when staying would achieve something: a draft that cannot be
  // sent, or a save that failed. A request merely in flight has nothing to fix.
  onStay?(): void;
}

export function UnsavedSettingsPrompt({
  domains,
  onLeave,
  leaveDisabled = false,
  onStay,
}: UnsavedSettingsPromptProps) {
  const container = useRef<HTMLDivElement>(null);
  // The host asked to navigate, so this answers their own action and focus
  // belongs on it. Background save errors never move focus.
  useEffect(() => { container.current?.focus(); }, []);
  const names = domains.map((domain) => domain.label).join(' and ');
  return <div
    className="unsaved-settings-prompt"
    role="region"
    aria-labelledby="unsaved-settings-title"
    aria-describedby="unsaved-settings-body"
    tabIndex={-1}
    ref={container}
  >
    <h2 id="unsaved-settings-title">
      {names || 'Your settings'} {domains.length > 1 ? 'are' : 'is'} not saved yet
    </h2>
    {/* Honest about what leaving can and cannot undo: a request already sent may
        still commit, and no button here can recall it. */}
    <p id="unsaved-settings-body">
      A change already sent may still finish saving after you leave. Leaving now discards anything
      that has not been sent.
    </p>
    <div className="button-row">
      <button
        type="button"
        className="button button--secondary"
        disabled={leaveDisabled}
        onClick={onLeave}
      >Leave now</button>
      {onStay && <button type="button" className="button button--primary" onClick={onStay}>
        Stay and fix settings
      </button>}
    </div>
  </div>;
}
