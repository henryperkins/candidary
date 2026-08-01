import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTOSAVE_DEBOUNCE_MS,
  createAutosaveQueue,
  type AutosaveFailure,
  type AutosaveOutcome,
  type AutosaveState,
} from '../../src/features/settings/autosave-queue';

interface Deferred {
  promise: Promise<AutosaveOutcome>;
  confirm(key?: string): void;
  rebase(): void;
  reject(error: unknown): void;
}

function deferred(sentKey: string): Deferred {
  let resolve!: (outcome: AutosaveOutcome) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<AutosaveOutcome>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {
    promise,
    confirm: (key = sentKey) => { resolve({ status: 'confirmed', key }); },
    rebase: () => { resolve({ status: 'rebased' }); },
    reject,
  };
}

const RETRYABLE: AutosaveFailure = { message: 'That change could not be saved.', retryable: true };

function harness(baselineKey = 'v0') {
  const sent: string[] = [];
  const intents: string[] = [];
  const snapshots: string[] = [];
  const gates: Deferred[] = [];
  const states: AutosaveState[] = [];
  const queue = createAutosaveQueue<string>({
    baselineKey,
    save(snapshot, draft) {
      sent.push(draft.key);
      intents.push(draft.intent);
      snapshots.push(snapshot);
      const gate = deferred(draft.key);
      gates.push(gate);
      return gate.promise;
    },
    describeFailure: () => RETRYABLE,
    onChange: (state) => { states.push(state); },
  });
  // Intent defaults to the key: most drafts move both together, and the tests
  // that care about them diverging pass it explicitly.
  const draft = (key: string, intent = key, snapshot = key) => ({ key, intent, snapshot });
  return { queue, sent, intents, snapshots, gates, states, draft };
}

// Vitest's fake timers must be installed before the queue schedules anything.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('autosave queue', () => {
  it('waits the full debounce before sending, and sends once', () => {
    const { queue, sent, draft } = harness();
    queue.submit(draft('v1'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(['v1']);
    expect(queue.state().status).toBe('saving');
  });

  it('collapses intermediate drafts into the newest one', () => {
    const { queue, sent, draft } = harness();
    queue.submit(draft('v1'));
    vi.advanceTimersByTime(300);
    queue.submit(draft('v2'));
    vi.advanceTimersByTime(300);
    queue.submit(draft('v3'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(sent).toEqual(['v3']);
  });

  it('flushes the newest valid draft immediately', () => {
    const { queue, sent, draft } = harness();
    queue.submit(draft('v1'));
    queue.flush();
    expect(sent).toEqual(['v1']);
  });

  it('sends immediate drafts without waiting', () => {
    const { queue, sent, draft } = harness();
    queue.submit(draft('v1'), true);
    expect(sent).toEqual(['v1']);
  });

  it('keeps one request in flight and starts only the newest pending snapshot', async () => {
    const { queue, sent, gates, draft } = harness();
    queue.submit(draft('v1'), true);
    queue.submit(draft('v2'), true);
    queue.submit(draft('v3'), true);
    expect(sent).toEqual(['v1']);

    gates[0]!.confirm();
    await vi.waitFor(() => expect(sent).toEqual(['v1', 'v3']));
    gates[1]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
    expect(sent).toEqual(['v1', 'v3']);
  });

  it('drops a pending snapshot when the host returns to the value being written', async () => {
    const { queue, sent, gates, draft } = harness('v0');
    queue.submit(draft('v1'), true);
    queue.submit(draft('v2'), true);
    // Back to exactly what is in flight. What was queued behind it described
    // intent the host has since abandoned, and sending it would make older
    // intent final.
    queue.submit(draft('v1'), true);

    gates[0]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
    expect(sent).toEqual(['v1']);
  });

  it('cancels a scheduled snapshot when the host returns to the confirmed baseline', () => {
    const { queue, sent, draft } = harness('v0');
    queue.submit(draft('v1'));
    queue.submit(draft('v0'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(sent).toEqual([]);
    expect(queue.state().status).toBe('saved');
  });

  it('still queues a baseline reversion behind an in-flight snapshot', async () => {
    const { queue, sent, gates, draft } = harness('v0');
    queue.submit(draft('v1'), true);
    queue.submit(draft('v0'), true);
    expect(sent).toEqual(['v1']);
    gates[0]!.confirm();
    // v1 may already have committed, so v0 has to be stated rather than assumed.
    await vi.waitFor(() => expect(sent).toEqual(['v1', 'v0']));
  });

  it('cancels scheduled and pending work when the latest draft becomes invalid', async () => {
    const { queue, sent, gates, draft } = harness();
    queue.submit(draft('v1'), true);
    queue.submit(draft('v2'));
    queue.submit({ key: 'v3-invalid', intent: 'v3-invalid', snapshot: null });
    expect(queue.state().status).toBe('invalid');
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    gates[0]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('invalid'));
    expect(sent).toEqual(['v1']);
  });

  it('suppresses a superseded failure and starts the pending snapshot', async () => {
    const { queue, sent, gates, states, draft } = harness();
    queue.submit(draft('v1'), true);
    queue.submit(draft('v2'), true);
    gates[0]!.reject(new Error('offline'));
    await vi.waitFor(() => expect(sent).toEqual(['v1', 'v2']));
    expect(states.some((state) => state.status === 'failed')).toBe(false);
    gates[1]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
  });

  it('reports a current failure, and a newer valid edit clears it and queues normally', async () => {
    const { queue, sent, gates, draft } = harness();
    queue.submit(draft('v1'), true);
    gates[0]!.reject(new Error('offline'));
    await vi.waitFor(() => expect(queue.state()).toEqual({ status: 'failed', failure: RETRYABLE }));

    queue.submit(draft('v2'));
    expect(queue.state().status).toBe('scheduled');
    expect(queue.state().failure).toBeNull();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(sent).toEqual(['v1', 'v2']);
    gates[1]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
  });

  it('resends the current draft immediately when Retry submits it again', async () => {
    const { queue, sent, gates, draft } = harness();
    queue.submit(draft('v1'), true);
    gates[0]!.reject(new Error('offline'));
    await vi.waitFor(() => expect(queue.state().status).toBe('failed'));

    // Retry is an immediate resubmit of whatever the host can see now. There is
    // no second entry point that could resend the snapshot that failed.
    queue.submit(draft('v1'), true);
    expect(sent).toEqual(['v1', 'v1']);
    expect(queue.state()).toEqual({ status: 'saving', failure: null });
    gates[1]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
  });

  it('advances the baseline on success so an unchanged redraft sends nothing', async () => {
    const { queue, sent, gates, draft } = harness('v0');
    queue.submit(draft('v1'), true);
    gates[0]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
    queue.submit(draft('v1'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(sent).toEqual(['v1']);
  });

  it('adopts the key the Worker says it stored, not the key that was sent', async () => {
    const { queue, sent, gates, draft } = harness('v0');
    queue.submit(draft('v1-raw'), true);
    // The Worker normalized what it was sent and reports the stored form.
    gates[0]!.confirm('v1');
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));

    queue.submit(draft('v1'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    // The normalized value is the baseline, so it is not dirty and sends nothing.
    expect(sent).toEqual(['v1-raw']);
  });

  it('keeps reporting that it is saving when a request resolved without committing', async () => {
    const { queue, gates, states, draft } = harness('v0');
    queue.submit(draft('v1'), true);
    gates[0]!.rebase();

    // Nothing committed, so nothing may say Saved — something newer is coming.
    await vi.waitFor(() => expect(queue.state().status).toBe('saving'));
    expect(states.some((state) => state.status === 'saved')).toBe(false);

    queue.submit(draft('v2'), true);
    gates[1]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('saved'));
  });

  it('tells a response whether the screen moved on, even when the payload did not', async () => {
    const { queue, sent, intents, gates, draft } = harness('v0');
    queue.submit(draft('v1', 'v1-raw'), true);
    // Raw input that leaves the canonical value alone: same key, new intent.
    queue.submit({ key: 'v1', intent: 'v1-typed', snapshot: null });

    gates[0]!.confirm();
    await vi.waitFor(() => expect(queue.state().status).toBe('invalid'));
    expect(sent).toEqual(['v1']);
    expect(intents).toEqual(['v1-raw']);
  });

  it('suppresses a same-key failure after raw input becomes invalid', async () => {
    const { queue, gates, draft } = harness('v0');
    queue.submit(draft('v1', 'v1-valid'), true);
    // The canonical color is still v1, but the host is now looking at raw text
    // that cannot be sent. A refusal for the former intent must not overwrite
    // the syntax error for the latter.
    queue.submit({ key: 'v1', intent: 'v1-invalid', snapshot: null });

    gates[0]!.reject(new Error('The old request was refused.'));
    await expect(gates[0]!.promise).rejects.toThrow('The old request was refused.');
    expect(queue.state()).toEqual({ status: 'invalid', failure: null });
  });

  it('reports an in-flight failure when the latest valid intent has the same key', async () => {
    const { queue, gates, draft } = harness('v0');
    queue.submit(draft('v1', 'v1-raw'), true);
    // Blur can normalize the visible draft without changing the complete
    // payload. No replacement write is needed, so this request still owns any
    // failure for the semantic value on screen.
    queue.submit(draft('v1', 'v1-normalized'), true);

    gates[0]!.reject(new Error('offline'));

    await vi.waitFor(() => expect(queue.state()).toEqual({ status: 'failed', failure: RETRYABLE }));
  });

  it('keeps the debounce deadline but sends the newest same-key scheduled metadata', () => {
    const { queue, sent, intents, snapshots, draft } = harness('v0');
    queue.submit(draft('v1', 'v1-raw', 'snapshot-before-normalization'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS / 2);
    queue.submit(draft('v1', 'v1-normalized', 'snapshot-after-normalization'));

    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS / 2 - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(intents).toEqual(['v1-normalized']);
    expect(snapshots).toEqual(['snapshot-after-normalization']);
  });

  it('sends the newest same-key metadata when replacing a pending snapshot', async () => {
    const { queue, sent, intents, snapshots, gates, draft } = harness('v0');
    queue.submit(draft('v1'), true);
    queue.submit(draft('v2', 'v2-first', 'snapshot-v2-first'), true);
    queue.submit(draft('v2', 'v2-latest', 'snapshot-v2-latest'), true);

    gates[0]!.confirm();

    await vi.waitFor(() => expect(sent).toEqual(['v1', 'v2']));
    expect(intents).toEqual(['v1', 'v2-latest']);
    expect(snapshots).toEqual(['v1', 'snapshot-v2-latest']);
  });

  it('adopts a baseline confirmed elsewhere without sending', () => {
    const { queue, sent, draft } = harness('v0');
    queue.adoptBaseline('v9');
    queue.submit(draft('v9'));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(sent).toEqual([]);
    expect(queue.state().status).toBe('saved');
  });

  it('disposal discards unsent intent but never the request already sent', async () => {
    const { queue, sent, gates, draft } = harness();
    queue.submit(draft('v1'));
    queue.flush();
    // v2 is pending behind the in-flight v1, and v3 has not left the timer.
    queue.submit(draft('v2'), true);
    queue.submit(draft('v3'));
    queue.dispose();
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);

    // The request already in flight still finishes; nothing new is started.
    // This is what makes Leave now honest about what it discards.
    gates[0]!.confirm();
    await expect(gates[0]!.promise).resolves.toEqual({ status: 'confirmed', key: 'v1' });
    await vi.waitFor(() => expect(sent).toEqual(['v1']));
  });
});
