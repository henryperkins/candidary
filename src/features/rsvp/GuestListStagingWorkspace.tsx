import { useEffect, useMemo, useRef, useState } from 'react';

import { MAX_RSVP_BATCH_BYTES } from '../../../shared/constants';
import type {
  RsvpHouseholdDetail,
  RsvpRosterBatchCommitResponse,
  RsvpRosterBatchDraft,
  RsvpRosterBatchIssue,
  RsvpRosterBatchPreviewResponse,
} from '../../../shared/contracts';
import type { RsvpRosterBatchConflictDetails } from '../../../shared/errors';
import { api, ClientApiError } from '../../app/api';

import {
  clientId,
  defaultMapping,
  materializePlainGuests,
  materializeStructuredSource,
  parseGuestListSource,
  plainGuests,
  serializedBatchBytes,
  validateMapping,
  type GuestListMapping,
  type GuestListSourceKind,
} from './guest-list-intake';
import { GuestListBatchReview, GuestListIssueSummary } from './GuestListBatchReview';
import { GuestListCapture } from './GuestListCapture';
import { GuestListColumnMapper } from './GuestListColumnMapper';
import { GuestListCommitReceipt, type AffectedHousehold } from './GuestListCommitReceipt';
import { countLabel } from './guest-list-copy';
import { GuestListGroupingBoard } from './GuestListGroupingBoard';
import { GuestListHouseholdTargetPicker } from './GuestListHouseholdTargetPicker';
import { GuestListInvitationDetails, type PlusOneResponseDraft } from './GuestListInvitationDetails';
import { useGuestListDraft } from './useGuestListDraft';

type Step = 'capture' | 'organize' | 'details' | 'review' | 'receipt';
type ConflictState = 'changed' | 'archived' | 'missing';

function rememberedId(ids: Map<string, string>, key: string): string {
  const previous = ids.get(key);
  if (previous) return previous;
  const next = clientId();
  ids.set(key, next);
  return next;
}

function appendTarget(
  batch: RsvpRosterBatchDraft,
  target: RsvpHouseholdDetail,
  ids: Map<string, string>,
): RsvpRosterBatchDraft {
  const namedInvitees = batch.creates.flatMap((create) => create.namedInvitees);
  const plusOneSlotsToAdd = batch.creates.reduce((total, create) => total + create.plusOneSlots, 0);
  return {
    creates: [],
    appends: [{
      clientHouseholdId: rememberedId(ids, `append:${target.id}`),
      householdId: target.id,
      expectedHouseholdVersion: target.version,
      namedInvitees,
      plusOneSlotsToAdd,
    }],
  };
}

function conflictMap(details: RsvpRosterBatchConflictDetails): Map<string, ConflictState> {
  return new Map(details.targets.map((target) => [target.clientHouseholdId, target.state]));
}

function sameBatch(
  left: RsvpRosterBatchDraft | null,
  right: RsvpRosterBatchDraft,
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function preservePlainDetailEdits(
  next: RsvpRosterBatchDraft,
  previous: RsvpRosterBatchDraft | null,
): RsvpRosterBatchDraft {
  if (!previous) return next;
  const previousCreates = new Map(previous.creates.map((create) => [create.clientHouseholdId, create]));
  const previousAppends = new Map(previous.appends.map((append) => [append.clientHouseholdId, append]));
  const previousInvitees = new Map(
    [...previous.creates, ...previous.appends]
      .flatMap((household) => household.namedInvitees)
      .map((invitee) => [invitee.clientInviteeId, invitee]),
  );
  return {
    creates: next.creates.map((create) => {
      const previousCreate = previousCreates.get(create.clientHouseholdId);
      return {
        ...create,
        ...(previousCreate ? {
          label: previousCreate.label,
          plusOneSlots: previousCreate.plusOneSlots,
        } : {}),
        namedInvitees: create.namedInvitees.map((invitee) => previousInvitees.get(invitee.clientInviteeId) ?? invitee),
      };
    }),
    appends: next.appends.map((append) => {
      const previousAppend = previousAppends.get(append.clientHouseholdId);
      return {
        ...append,
        ...(previousAppend ? {
          plusOneSlotsToAdd: previousAppend.plusOneSlotsToAdd,
          ...(previousAppend.newPlusOneResponses
            ? { newPlusOneResponses: previousAppend.newPlusOneResponses }
            : {}),
        } : {}),
        namedInvitees: append.namedInvitees.map((invitee) => previousInvitees.get(invitee.clientInviteeId) ?? invitee),
      };
    }),
  };
}

export function GuestListStagingWorkspace({
  eventId,
  rosterVersion,
  hasHouseholds,
  onClose,
  onDirtyChange,
  discardEpoch,
  onEventWrite,
  onCommitted,
  onRosterVersionObserved,
  onOpenHousehold,
  onCommitPendingChange,
}: {
  eventId: string;
  rosterVersion: number;
  hasHouseholds: boolean;
  onClose(): void;
  onDirtyChange(dirty: boolean): void;
  discardEpoch: number;
  onEventWrite<T>(request: () => Promise<T>): Promise<T>;
  onCommitted(): void;
  onRosterVersionObserved(version: number): void;
  onOpenHousehold(householdId: string): void;
  onCommitPendingChange?(pending: boolean): void;
}) {
  const draft = useGuestListDraft();
  const [step, setStep] = useState<Step>('capture');
  const [kind, setKind] = useState<GuestListSourceKind>('ambiguous');
  const [parsed, setParsed] = useState(() => parseGuestListSource(''));
  const [mapping, setMapping] = useState<GuestListMapping>(() => defaultMapping(parseGuestListSource('')));
  const [mappingIssues, setMappingIssues] = useState<ReturnType<typeof validateMapping>>([]);
  const [organizationChanged, setOrganizationChanged] = useState(true);
  const [target, setTarget] = useState<RsvpHouseholdDetail | null>(null);
  const [targetPending, setTargetPending] = useState(false);
  const [preview, setPreview] = useState<RsvpRosterBatchPreviewResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<RsvpRosterBatchCommitResponse | null>(null);
  const [receiptAffected, setReceiptAffected] = useState<AffectedHousehold[]>([]);
  const [conflicts, setConflicts] = useState<Map<string, ConflictState>>(() => new Map());
  const [plusOneDrafts, setPlusOneDrafts] = useState<Record<string, PlusOneResponseDraft[]>>({});
  const [issueFocus, setIssueFocus] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const discardedEpoch = useRef(0);
  const observedRosterVersion = useRef(rosterVersion);
  const materializedIds = useRef(new Map<string, string>());
  const previewTicket = useRef(0);

  useEffect(() => { onDirtyChange(draft.dirty); }, [draft.dirty, onDirtyChange]);
  useEffect(() => {
    if (!discardEpoch || discardedEpoch.current === discardEpoch) return;
    discardedEpoch.current = discardEpoch;
    previewTicket.current += 1;
    draft.reset();
    setPreview(null);
    setReceipt(null);
    setReceiptAffected([]);
    setIdempotencyKey(null);
    setOrganizationChanged(true);
    setTargetPending(false);
    setBusy(false);
    onDirtyChange(false);
  }, [discardEpoch, draft.reset, onDirtyChange]);
  useEffect(() => {
    if (step !== 'review' || !preview?.issues.some((issue) => issue.severity === 'blocking')) {
      heading.current?.focus();
    }
  }, [preview?.issues, step]);
  useEffect(() => {
    if (observedRosterVersion.current === rosterVersion) return;
    observedRosterVersion.current = rosterVersion;
    previewTicket.current += 1;
    setPreview(null);
    setIdempotencyKey(null);
    setBusy(false);
    setStep((current) => current === 'review' ? 'details' : current);
  }, [rosterVersion]);
  useEffect(() => () => { previewTicket.current += 1; }, []);
  useEffect(() => {
    if (!issueFocus) return;
    const frame = requestAnimationFrame(() => document.getElementById(issueFocus)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [issueFocus, step]);

  const issues = preview?.issues ?? [];
  const blocking = issues.filter((issue) => issue.severity === 'blocking');
  const automaticIndividuals = useMemo(() => {
    const grouped = new Set(draft.groups.flatMap((group) => group.memberIds));
    return draft.people.filter((person) => !grouped.has(person.id));
  }, [draft.groups, draft.people]);

  function invalidate() {
    previewTicket.current += 1;
    setPreview(null);
    setIdempotencyKey(null);
    setReceipt(null);
    setReceiptAffected([]);
    setError('');
    setIssueFocus(null);
    setBusy(false);
  }

  function setSource(source: string) {
    materializedIds.current.clear();
    const next = parseGuestListSource(source);
    draft.setSource(source);
    draft.setPeople(plainGuests(source));
    draft.setGroups([]);
    draft.setBatch(null);
    setParsed(next);
    setMapping(defaultMapping(next));
    setMappingIssues([]);
    setKind(next.kind);
    setOrganizationChanged(true);
    setConflicts(new Map());
    invalidate();
  }

  function selectTarget(next: RsvpHouseholdDetail | null) {
    setTarget(next);
    setOrganizationChanged(true);
    setConflicts(new Map());
    invalidate();
  }

  function ensurePlusOneDraftRows(batch: RsvpRosterBatchDraft) {
    setPlusOneDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const append of batch.appends) {
        const rows = [...(next[append.clientHouseholdId] ?? [])];
        while (rows.length < append.plusOneSlotsToAdd) {
          rows.push({ clientInviteeId: clientId(), attendance: null, displayName: '' });
          changed = true;
        }
        if (changed || !next[append.clientHouseholdId]) next[append.clientHouseholdId] = rows;
      }
      return changed ? next : current;
    });
  }

  function materialize() {
    if (targetPending) return;
    if (!organizationChanged && draft.batch) {
      setStep('details');
      return;
    }
    if (kind === 'structured') {
      const nextIssues = validateMapping(parsed, mapping);
      setMappingIssues(nextIssues);
      if (nextIssues.length > 0) {
        setError(nextIssues[0]?.message ?? 'Correct the mapped columns before continuing.');
        setStep('organize');
        return;
      }
    }
    let batch = kind === 'structured'
      ? materializeStructuredSource(parsed, mapping, materializedIds.current)
      : materializePlainGuests(draft.people, draft.groups, materializedIds.current);
    if (target) batch = appendTarget(batch, target, materializedIds.current);
    if (kind === 'plain') batch = preservePlainDetailEdits(batch, draft.batch);
    const changed = !sameBatch(draft.batch, batch);
    if (changed) draft.setBatch(batch);
    if (target?.firstRespondedAt) ensurePlusOneDraftRows(batch);
    if (changed) invalidate();
    setOrganizationChanged(false);
    setStep('details');
  }

  function updateBatch(next: RsvpRosterBatchDraft) {
    draft.setBatch(next);
    if (kind === 'plain') {
      draft.setGroups(draft.groups.map((group) => {
        const edited = next.creates.find((create) => create.clientHouseholdId === group.id);
        return edited ? { ...group, label: edited.label } : group;
      }));
    }
    invalidate();
  }

  function batchWithPlusOneResponses(batch: RsvpRosterBatchDraft): RsvpRosterBatchDraft {
    return {
      ...batch,
      appends: batch.appends.map((append) => {
        if (!target?.firstRespondedAt || append.plusOneSlotsToAdd === 0) return append;
        const rows = (plusOneDrafts[append.clientHouseholdId] ?? []).slice(0, append.plusOneSlotsToAdd);
        if (rows.length !== append.plusOneSlotsToAdd
          || rows.some((row) => row.attendance === null || (row.attendance === 'attending' && !row.displayName.trim()))) {
          return append;
        }
        return {
          ...append,
          newPlusOneResponses: rows.flatMap((row) => row.attendance
            ? [{
              clientInviteeId: row.clientInviteeId,
              attendance: row.attendance,
              displayName: row.attendance === 'attending' ? row.displayName.trim() : null,
            }]
            : []),
        };
      }),
    };
  }

  function respondedTargetIncomplete(batch: RsvpRosterBatchDraft): boolean {
    if (!target?.firstRespondedAt) return false;
    return batch.appends.some((append) => {
      if (append.namedInvitees.some((invitee) => !invitee.attendance)) return true;
      const rows = (plusOneDrafts[append.clientHouseholdId] ?? []).slice(0, append.plusOneSlotsToAdd);
      return rows.length !== append.plusOneSlotsToAdd
        || rows.some((row) => row.attendance === null || (row.attendance === 'attending' && !row.displayName.trim()));
    });
  }

  async function previewBatch() {
    const batch = draft.batch;
    if (!batch) return;
    if (conflicts.size > 0) {
      setError('Resolve every highlighted household before reviewing this batch again.');
      return;
    }
    if (respondedTargetIncomplete(batch)) {
      setError('Choose attendance for every new guest and plus-one. Attending plus-ones need a name.');
      return;
    }
    const candidate = batchWithPlusOneResponses(batch);
    if (serializedBatchBytes(candidate, rosterVersion) > MAX_RSVP_BATCH_BYTES) {
      setError('This guest-list batch is too large to review. Split it into smaller additions.');
      return;
    }
    const ticket = previewTicket.current + 1;
    previewTicket.current = ticket;
    setBusy(true);
    setError('');
    try {
      const result = await api<RsvpRosterBatchPreviewResponse>(
        `/api/manage/events/${eventId}/rsvp/roster/preview`,
        { method: 'POST', body: JSON.stringify({ batch: candidate, expectedRosterVersion: rosterVersion }) },
      );
      if (previewTicket.current !== ticket) return;
      const changedTargets = result.targetVersions.flatMap((version) => {
        const append = candidate.appends.find((item) => item.clientHouseholdId === version.clientHouseholdId);
        return append && append.expectedHouseholdVersion !== version.version
          ? [{
              clientHouseholdId: version.clientHouseholdId,
              householdId: version.householdId,
              currentHouseholdVersion: version.version,
              state: 'changed' as const,
            }]
          : [];
      });
      if (result.rosterVersion !== rosterVersion || changedTargets.length > 0) {
        setPreview(null);
        setIdempotencyKey(null);
        setStep('details');
        if (changedTargets.length > 0) {
          const details: RsvpRosterBatchConflictDetails = {
            currentRosterVersion: result.rosterVersion,
            targets: changedTargets,
          };
          const refreshed = await fetchConflictTargets(details);
          if (previewTicket.current !== ticket) return;
          setConflicts(conflictMap(details));
          adoptConflictTargets(details, refreshed);
          setError('A selected household changed. Review the highlighted addition before previewing again.');
          setIssueFocus(`guest-list-card-${changedTargets[0]!.clientHouseholdId}`);
        } else {
          setError('The guest list changed since this batch was started. Review this batch again.');
        }
        onRosterVersionObserved(result.rosterVersion);
        return;
      }
      setPreview(result);
      if (result.canCommit) setIdempotencyKey((current) => current ?? clientId());
      setStep('review');
    } catch (caught) {
      if (previewTicket.current !== ticket) return;
      setError(caught instanceof Error ? caught.message : 'The guest list could not be reviewed.');
    } finally {
      if (previewTicket.current === ticket) setBusy(false);
    }
  }

  async function fetchConflictTargets(details: RsvpRosterBatchConflictDetails) {
    return Promise.all(details.targets.map(async (item) => {
      try {
        return await api<RsvpHouseholdDetail>(`/api/manage/events/${eventId}/rsvp/households/${item.householdId}`);
      } catch {
        return null;
      }
    }));
  }

  function adoptConflictTargets(
    details: RsvpRosterBatchConflictDetails,
    refreshed: Array<RsvpHouseholdDetail | null>,
  ) {
    const activeTarget = refreshed.find((detail) => detail?.id === target?.id) ?? null;
    if (activeTarget) {
      setTarget(activeTarget);
      if (activeTarget.firstRespondedAt && draft.batch) ensurePlusOneDraftRows(draft.batch);
    }
    else if (details.targets.some((item) => item.householdId === target?.id)) setTarget(null);
  }

  async function commit() {
    if (!preview || !preview.canCommit || !idempotencyKey) return;
    setBusy(true);
    setCommitting(true);
    onCommitPendingChange?.(true);
    setError('');
    try {
      const result = await onEventWrite(() => api<RsvpRosterBatchCommitResponse>(
        `/api/manage/events/${eventId}/rsvp/roster/commit`,
        {
          method: 'POST',
          body: JSON.stringify({
            canonicalBatch: preview.canonicalBatch,
            previewDigest: preview.previewDigest,
            expectedRosterVersion: preview.rosterVersion,
            idempotencyKey,
          }),
        },
      ));
      onRosterVersionObserved(result.currentRosterVersion);
      setReceiptAffected(affectedHouseholds(result, preview));
      setReceipt(result);
      draft.setDirty(false);
      setStep('receipt');
      onCommitted();
    } catch (caught) {
      if (caught instanceof ClientApiError && caught.code === 'RSVP_ROSTER_BATCH_CONFLICT') {
        const details = caught.details;
        if (details) {
          onRosterVersionObserved(details.currentRosterVersion);
          setConflicts(conflictMap(details));
          setPreview(null);
          setIdempotencyKey(null);
          adoptConflictTargets(details, await fetchConflictTargets(details));
          setError(`${caught.message} Review the highlighted household additions again.`);
          const firstTarget = details.targets[0];
          if (firstTarget) setIssueFocus(`guest-list-card-${firstTarget.clientHouseholdId}`);
        } else {
          setError(caught.message);
        }
        setStep('details');
      } else if (caught instanceof ClientApiError) {
        setError(caught.message);
      } else {
        // Only an actual transport loss is uncertain. Retain this exact key and
        // digest so the next unchanged submission can replay the receipt.
        setError('Completion could not be confirmed. Retry this unchanged batch to check safely.');
      }
    } finally {
      setBusy(false);
      setCommitting(false);
      onCommitPendingChange?.(false);
    }
  }

  function acceptConflict(appendId: string) {
    if (!target) return;
    const current = draft.batch;
    if (!current) return;
    const changed = current.appends.map((append) => append.clientHouseholdId === appendId
      ? { ...append, expectedHouseholdVersion: target.version }
      : append);
    draft.setBatch({ ...current, appends: changed });
    setConflicts((currentConflicts) => {
      const next = new Map(currentConflicts);
      next.delete(appendId);
      return next;
    });
    invalidate();
    setError('Current household accepted. Review the unchanged additions before previewing again.');
  }

  function focusIssue(issue: RsvpRosterBatchIssue) {
    if (issue.field === 'householdKey.value') {
      setIssueFocus('guest-list-mapping-householdKey');
      setStep('organize');
      return;
    }
    if (issue.field === 'householdId' || issue.code.startsWith('target_household_')) {
      setIssueFocus('guest-list-target');
      setStep('organize');
      return;
    }
    const id = issue.clientInviteeId
      ? `guest-list-field-${issue.clientInviteeId}-${issue.field}`
      : issue.clientHouseholdId
        ? `guest-list-card-${issue.clientHouseholdId}`
        : 'guest-list-workspace-title';
    setIssueFocus(id);
    setStep('details');
  }

  function affectedHouseholds(
    result: RsvpRosterBatchCommitResponse,
    reviewed: RsvpRosterBatchPreviewResponse,
  ): AffectedHousehold[] {
    const labels = new Map<string, string>();
    for (const create of reviewed.canonicalBatch.creates) labels.set(create.clientHouseholdId, create.label);
    for (const append of reviewed.canonicalBatch.appends) labels.set(append.clientHouseholdId, target?.label ?? 'existing household');
    const candidates = [...result.createdHouseholds, ...result.updatedHouseholds].map((item) => ({
      householdId: item.householdId,
      label: labels.get(item.clientHouseholdId) ?? `affected household ${item.householdId}`,
    }));
    const labelCounts = new Map<string, number>();
    return candidates.map((candidate) => {
      const occurrence = (labelCounts.get(candidate.label) ?? 0) + 1;
      labelCounts.set(candidate.label, occurrence);
      const duplicate = candidates.filter(({ label }) => label === candidate.label).length > 1;
      return {
        ...candidate,
        label: duplicate ? `${candidate.label} (household ${occurrence})` : candidate.label,
      };
    });
  }

  const batch = draft.batch;
  return <section className="guest-list-workspace" aria-labelledby="guest-list-workspace-title">
    <div className="guest-list-workspace__heading">
      <h3 id="guest-list-workspace-title" tabIndex={-1} ref={heading}>
        {step === 'capture' ? 'Add guests' : step === 'organize' ? 'Organize invitations' : step === 'details' ? 'Invitation details' : step === 'review' ? 'Review guest list' : 'Guests added'}
      </h3>
      {step !== 'receipt' && <button type="button" className="text-button" disabled={committing} onClick={onClose}>Close</button>}
    </div>
    {error && <p className="guest-list-workspace__error" role="alert">{error}</p>}

    {step === 'capture' && <GuestListCapture
      eventId={eventId}
      source={draft.source}
      sourceError={parsed.error}
      kind={kind}
      hasHouseholds={hasHouseholds}
      target={target}
      targetPending={targetPending}
      onSource={setSource}
      onSourceInvalid={invalidate}
      onKind={(next) => { setKind(next); setOrganizationChanged(true); invalidate(); }}
      onTarget={selectTarget}
      onTargetPending={setTargetPending}
      onContinue={() => {
        if (parsed.strictHeader && parsed.firstRowIsHeader && kind === 'structured') materialize();
        else setStep('organize');
      }}
    />}

    {step === 'organize' && (kind === 'structured'
      ? <GuestListColumnMapper
        parsed={parsed}
        mapping={mapping}
        issues={mappingIssues}
        onHeaderChange={(firstRowIsHeader) => {
          const nextParsed = { ...parsed, firstRowIsHeader };
          const nextMapping = defaultMapping(nextParsed);
          setParsed(nextParsed);
          setMapping(nextMapping);
          setMappingIssues(validateMapping(nextParsed, nextMapping));
          setOrganizationChanged(true);
          invalidate();
        }}
        onMapping={(next) => {
          setMapping(next);
          setMappingIssues(validateMapping(parsed, next));
          setOrganizationChanged(true);
          invalidate();
        }}
      />
      : <GuestListGroupingBoard
        people={draft.people}
        groups={draft.groups}
        onGroups={(next) => { draft.setGroups(next); setOrganizationChanged(true); invalidate(); }}
        automaticIndividuals={target === null ? automaticIndividuals : undefined}
      />)}

    {step === 'organize' && hasHouseholds && <GuestListHouseholdTargetPicker
      eventId={eventId}
      target={target}
      onTarget={selectTarget}
      onSelectionPendingChange={setTargetPending}
    />}

    {step === 'organize' && <div className="guest-list-workspace__actions">
      <button type="button" className="button button--secondary" onClick={() => setStep('capture')}>Back</button>
      <button type="button" className="button button--primary" disabled={targetPending} onClick={materialize}>Continue to details</button>
    </div>}

    {step === 'details' && issues.length > 0 && <GuestListIssueSummary
      issues={issues}
      onIssue={focusIssue}
    />}

    {step === 'details' && batch && <GuestListInvitationDetails
      batch={batch}
      target={target}
      plusOneDrafts={plusOneDrafts}
      onPlusOneDrafts={(appendId, rows) => {
        setPlusOneDrafts((current) => ({ ...current, [appendId]: rows }));
        invalidate();
      }}
      onChange={updateBatch}
      onBack={() => setStep('organize')}
      onReview={() => void previewBatch()}
      onAcceptConflict={acceptConflict}
      busy={busy}
      conflicts={conflicts}
      issues={issues}
    />}

    {step === 'review' && preview && <GuestListBatchReview
      preview={preview}
      automaticIndividuals={kind === 'plain' && target === null ? automaticIndividuals : []}
      target={target}
      onBack={() => setStep('details')}
      onCommit={() => void commit()}
      onIssue={focusIssue}
      busy={busy}
      issues={issues}
    />}

    {step === 'receipt' && receipt && <GuestListCommitReceipt
      receipt={receipt}
      affected={receiptAffected}
      onReturn={onClose}
      onOpenHousehold={onOpenHousehold}
      onAddMore={() => {
        materializedIds.current.clear();
        draft.reset();
        const empty = parseGuestListSource('');
        setParsed(empty);
        setMapping(defaultMapping(empty));
        setMappingIssues([]);
        setKind('ambiguous');
        setPreview(null);
        setReceipt(null);
        setReceiptAffected([]);
        setIdempotencyKey(null);
        setTarget(null);
        setTargetPending(false);
        setOrganizationChanged(true);
        setPlusOneDrafts({});
        setConflicts(new Map());
        setStep('capture');
      }}
    />}
    {blocking.length > 0 && <p className="sr-only" aria-live="polite">{countLabel(blocking.length, 'blocking issue')} {blocking.length === 1 ? 'needs' : 'need'} attention.</p>}
  </section>;
}
