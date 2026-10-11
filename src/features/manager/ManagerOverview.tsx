import type { HostEventLifecycleView, RsvpSummary } from '../../../shared/contracts';
import type { ExportView } from '../../app/types';
import { ErrorState } from '../../components/States';
import type { ResourceState } from './resources';
import { type OverviewRecommendation, type OverviewDestination } from './overview-policy';

const WORKFLOWS: { destination: OverviewDestination; label: string; explanation: string }[] = [
  { destination: 'rsvp', label: 'Guest list and RSVPs', explanation: 'Set up optional RSVPs and review attendance.' },
  { destination: 'share', label: 'Share your event', explanation: 'Copy your guest link or download its QR.' },
  { destination: 'library', label: 'Library and sharing', explanation: 'View private originals and choose what to share.' },
  { destination: 'originals', label: 'Keep your originals', explanation: 'Download originals through Exports.' },
  { destination: 'settings', label: 'Event details and access', explanation: 'Review event details, RSVP availability, and photo delivery settings.' },
];

export function ManagerOverview({ lifecycle, summary, exports, recommendation, phaseLabel, onRetryLifecycle, onRetrySummary, onRetryExports, onNavigate, onShowIntroduction, onTakeTour }: {
  lifecycle: ResourceState<HostEventLifecycleView>;
  summary: ResourceState<RsvpSummary>;
  exports: ResourceState<ExportView[]>;
  recommendation: OverviewRecommendation;
  phaseLabel: string;
  onRetryLifecycle: () => void;
  onRetrySummary: () => void;
  onRetryExports: () => void;
  onNavigate: (destination: OverviewDestination) => void;
  onShowIntroduction?: () => void;
  onTakeTour?: () => void;
}) {
  const completeExport = exports.value?.find(job => job.kind === 'complete');
  return <div className="manager-overview">
    <section className="manager-overview__task" data-host-tour-anchor="overview-task" aria-labelledby="overview-task-title">
      <h2 id="overview-task-title">Choose your next task</h2>
      <p className="manager-overview__phase" role="status">{phaseLabel}</p>
      <p>{recommendation.reason}</p>
      <button type="button" className="button button--primary" data-host-tour-recommended-action onClick={() => onNavigate(recommendation.destination)}>{recommendation.label}</button>
      {onShowIntroduction && <button type="button" className="button button--quiet" onClick={onShowIntroduction}>Show me how to collect photos</button>}
      {lifecycle.status === 'loading' && <p className="form-note">Checking the current phase…</p>}
      {lifecycle.failure && <ErrorState {...lifecycle.failure} onRetry={onRetryLifecycle} />}
    </section>
    <section className="manager-overview__workflows" aria-labelledby="overview-workflows-title">
      <div className="button-row">
        <h2 id="overview-workflows-title">Your event tools</h2>
        {onTakeTour && <button type="button" className="button button--quiet" onClick={onTakeTour}>Tour event tools</button>}
      </div>
      <ul>{WORKFLOWS.map(workflow => <li key={workflow.destination}>
        <div><h3>{workflow.label}</h3><p>{workflow.explanation}</p></div>
        <button type="button" className="button button--secondary" onClick={() => onNavigate(workflow.destination)}>Open {workflow.destination === 'originals' ? 'Exports' : workflow.destination === 'library' ? 'Library' : workflow.destination === 'rsvp' ? 'RSVP' : workflow.destination === 'share' ? 'Share' : 'Settings'}</button>
      </li>)}</ul>
    </section>
    <section className="manager-overview__confirmed" aria-label="Confirmed event information">
      {summary.value && <p>{summary.value.namedInvitees.toLocaleString()} named guests · {summary.value.attending.toLocaleString()} attending · {summary.value.awaitingResponse.toLocaleString()} awaiting response</p>}
      {summary.status === 'loading' && <p className="form-note">Checking RSVP totals…</p>}
      {summary.failure && <ErrorState {...summary.failure} onRetry={onRetrySummary} />}
      {completeExport && <p>{completeExport.state === 'ready' ? 'Your complete export is ready. Open Exports to download it.' : `Complete export: ${completeExport.state.replaceAll('-', ' ')}.`}</p>}
      {exports.failure && <ErrorState {...exports.failure} onRetry={onRetryExports} />}
    </section>
  </div>;
}
