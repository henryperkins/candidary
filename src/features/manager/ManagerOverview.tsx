import type { HostEventLifecycleView, RsvpSummary } from '../../../shared/contracts';
import type { ExportView } from '../../app/types';
import { ErrorState } from '../../components/States';
import type { ResourceState } from './resources';
import { overviewPhaseLabel, resolveOverviewRecommendation, type OverviewDestination } from './overview-policy';

const WORKFLOWS: { destination: OverviewDestination; label: string; explanation: string }[] = [
  { destination: 'rsvp', label: 'Guest list and RSVPs', explanation: 'Prepare named invitations and review household attendance. You send the invitations; RSVP is optional for photo delivery.' },
  { destination: 'share', label: 'Share your event', explanation: 'Use the same permanent QR on invitations and venue signs. Its guest task changes from RSVP to photo delivery with your event.' },
  { destination: 'library', label: 'Library and sharing', explanation: 'Originals arrive privately in Library. Album and Guest gallery are separate, optional sharing choices.' },
  { destination: 'originals', label: 'Keep your originals', explanation: 'Prepare or retrieve exports from Library, whether or not you publish an Album or Guest gallery.' },
  { destination: 'settings', label: 'Event details and access', explanation: 'Review event details, RSVP availability, and photo delivery settings.' },
];

export function ManagerOverview({ lifecycle, summary, exports, deliveredPhotos, onRetryLifecycle, onRetrySummary, onRetryExports, onNavigate, onTakeTour }: {
  lifecycle: ResourceState<HostEventLifecycleView>;
  summary: ResourceState<RsvpSummary>;
  exports: ResourceState<ExportView[]>;
  deliveredPhotos: number | null;
  onRetryLifecycle: () => void;
  onRetrySummary: () => void;
  onRetryExports: () => void;
  onNavigate: (destination: OverviewDestination) => void;
  onTakeTour?: () => void;
}) {
  const recommendation = resolveOverviewRecommendation(lifecycle.value, summary.value?.namedInvitees ?? null, deliveredPhotos);
  const completeExport = exports.value?.find(job => job.kind === 'complete');
  return <div className="manager-overview">
    <section className="manager-overview__task" data-host-tour-anchor="overview-task" aria-labelledby="overview-task-title">
      <h2 id="overview-task-title">Choose your next task</h2>
      <p className="manager-overview__phase" role="status">{overviewPhaseLabel(lifecycle.value)}</p>
      <p>{recommendation.reason}</p>
      <button type="button" className="button button--primary" data-host-tour-recommended-action onClick={() => onNavigate(recommendation.destination)}>{recommendation.label}</button>
      {lifecycle.status === 'loading' && <p className="form-note">Checking the current phase…</p>}
      {lifecycle.failure && <ErrorState {...lifecycle.failure} onRetry={onRetryLifecycle} />}
    </section>
    <section className="manager-overview__workflows" aria-labelledby="overview-workflows-title">
      <h2 id="overview-workflows-title">Your event tools</h2>
      <ul>{WORKFLOWS.map(workflow => <li key={workflow.destination}>
        <div><h3>{workflow.label}</h3><p>{workflow.explanation}</p></div>
        <button type="button" className="button button--secondary" onClick={() => onNavigate(workflow.destination)}>Open {workflow.destination === 'originals' ? 'Exports' : workflow.destination === 'library' ? 'Library' : workflow.destination === 'rsvp' ? 'RSVP' : workflow.destination === 'share' ? 'Share' : 'Settings'}</button>
      </li>)}</ul>
    </section>
    <section className="manager-overview__confirmed" aria-label="Confirmed event information">
      {summary.value && <p>{summary.value.namedInvitees.toLocaleString()} named guests · {summary.value.attending.toLocaleString()} attending · {summary.value.awaitingResponse.toLocaleString()} awaiting response</p>}
      {summary.status === 'loading' && <p className="form-note">Checking RSVP totals…</p>}
      {summary.failure && <ErrorState {...summary.failure} onRetry={onRetrySummary} />}
      {completeExport && <p>Complete export: {completeExport.state === 'ready' ? 'Ready to retrieve in Library. This does not confirm a download.' : completeExport.state.replaceAll('-', ' ')}.</p>}
      {exports.failure && <ErrorState {...exports.failure} onRetry={onRetryExports} />}
      {onTakeTour && <button type="button" className="button button--secondary" onClick={onTakeTour}>Take a tour</button>}
    </section>
  </div>;
}
