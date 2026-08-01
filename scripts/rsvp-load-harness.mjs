/* global console, fetch, performance, process, TextEncoder, URL */

// A guarded rehearsal for the RSVP half of the wedding-day contract.
//
// It proves three things a unit test cannot: that a 500-capacity additive batch
// stays inside the production JSON envelope, commits and replays its durable
// manager receipt, and reconciles against the server's own totals; and that the
// durable D1 lookup boundary actually refuses the twenty-first attempt from one
// address with a generic 429. It is deliberately NOT a concurrency test — every
// request comes from one IP, and pretending otherwise would either mean
// weakening a production abuse control or reporting a number that means
// nothing. A true distributed lookup test needs separately provisioned source
// addresses and its own authorized rehearsal.

const baseUrl = process.env.CANDIDARY_RSVP_BASE_URL?.replace(/\/$/u, '');
const eventLink = process.env.CANDIDARY_RSVP_EVENT_LINK;
const managerCookie = process.env.CANDIDARY_RSVP_MANAGER_COOKIE;
const managerCsrf = process.env.CANDIDARY_RSVP_MANAGER_CSRF;
const live = process.env.CANDIDARY_RSVP_CONFIRM === 'I_UNDERSTAND';

// The approved shape of a 500-person rehearsal roster: one named guest and one
// plus-one slot per household, which is the largest capacity the contract allows.
const HOUSEHOLDS = 250;
const CAPACITY = HOUSEHOLDS * 2;
// Keep in sync with MAX_RSVP_BATCH_BYTES in shared/constants.ts. This standalone
// Node harness does not load the application's TypeScript modules.
const MAX_BATCH_BYTES = 512 * 1024;
// The D1 per-event/IP budget. The attempt after it must be refused.
const IP_ATTEMPT_BUDGET = 20;
const D1_RETRY_AFTER = '900';

const plan = {
  households: HOUSEHOLDS,
  namedInvitees: HOUSEHOLDS,
  plusOneCapacity: HOUSEHOLDS,
  invitedCapacity: CAPACITY,
  lookupAttempts: IP_ATTEMPT_BUDGET,
  expectedRefusedAttempt: IP_ATTEMPT_BUDGET + 1,
  expectedRefusalStatus: 429,
  expectedRetryAfterSeconds: Number(D1_RETRY_AFTER),
  expectedRespondedHouseholds: IP_ATTEMPT_BUDGET,
  expectedAttending: IP_ATTEMPT_BUDGET,
  expectedDeclined: IP_ATTEMPT_BUDGET,
  expectedAwaitingResponse: CAPACITY - IP_ATTEMPT_BUDGET * 2,
};

function householdKey(index) {
  return `rehearsal-${String(index + 1).padStart(3, '0')}`;
}

function guestName(index) {
  return `Rehearsal Guest ${String(index + 1).padStart(3, '0')}`;
}

function fixtureUuid(prefix, index) {
  return `${prefix}000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

function rosterBatch() {
  return {
    creates: Array.from({ length: HOUSEHOLDS }, (_, index) => ({
      clientHouseholdId: fixtureUuid('10', index),
      householdKey: {
        value: householdKey(index),
        provenance: 'supplied',
      },
      label: `Rehearsal household ${index + 1}`,
      namedInvitees: [{
        clientInviteeId: fixtureUuid('20', index),
        displayName: guestName(index),
      }],
      plusOneSlots: 1,
    })),
    appends: [],
  };
}

function serializedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const candidateBatch = rosterBatch();
const modeledPreview = {
  batch: candidateBatch,
  expectedRosterVersion: 0,
};
const modeledCommit = {
  canonicalBatch: candidateBatch,
  previewDigest: 'a'.repeat(64),
  expectedRosterVersion: 0,
  idempotencyKey: 'rsvp-load-capacity-v1',
};
const previewBytes = serializedBytes(modeledPreview);
const commitBytes = serializedBytes(modeledCommit);
if (previewBytes > MAX_BATCH_BYTES || commitBytes > MAX_BATCH_BYTES) {
  throw new Error('The modeled maximum-capacity roster no longer fits the RSVP batch envelope.');
}

if (!live) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    ...plan,
    maxBatchBytes: MAX_BATCH_BYTES,
    previewBytes,
    modeledCommitBytes: commitBytes,
  }, null, 2));
  console.log('Set CANDIDARY_RSVP_BASE_URL, CANDIDARY_RSVP_EVENT_LINK, CANDIDARY_RSVP_MANAGER_COOKIE, CANDIDARY_RSVP_MANAGER_CSRF, and CANDIDARY_RSVP_CONFIRM=I_UNDERSTAND to run against a dedicated, disposable rehearsal event.');
  process.exit(0);
}
if (!baseUrl || !eventLink || !managerCookie || !managerCsrf) {
  throw new Error('A base URL, rehearsal event link, and manager credentials are required for a live run.');
}

function cookiesFrom(response, sessionName, csrfName) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? ''];
  const joined = values.join('; ');
  const session = new RegExp(`${sessionName}=([^;,]+)`, 'u').exec(joined)?.[1];
  const csrf = new RegExp(`${csrfName}=([^;,]+)`, 'u').exec(joined)?.[1];
  if (!session || !csrf) throw new Error(`Expected ${sessionName} and ${csrfName} cookies.`);
  return {
    cookie: `${sessionName}=${session}; ${csrfName}=${csrf}`,
    csrf: decodeURIComponent(csrf),
  };
}

const latencies = [];
const errors = new Map();

async function call(path, init = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', origin: baseUrl, ...init.headers },
  });
  latencies.push(performance.now() - startedAt);
  return response;
}

// Never the message and never the body: a refusal is counted by its code alone so
// no name, roster row, or credential can reach the console.
function recordError(code) {
  errors.set(code, (errors.get(code) ?? 0) + 1);
}

async function json(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    recordError(body?.code ?? String(response.status));
    throw new Error(`Request refused with ${body?.code ?? response.status}.`);
  }
  return body.data;
}

function manageHeaders() {
  return { cookie: managerCookie, 'x-candidary-csrf': managerCsrf };
}

const eventId = process.env.CANDIDARY_RSVP_EVENT_ID;
if (!eventId) throw new Error('CANDIDARY_RSVP_EVENT_ID is required so the harness never guesses which event it is loading.');

const startedAt = performance.now();

// 1. Commit the full 500-capacity roster through the additive batch path, then
// replay the exact request to prove a lost manager response is recoverable.
const current = await json(await call(`/api/manage/events/${eventId}`, {
  headers: manageHeaders(),
}));
if (current.event.rsvpRosterVersion !== 0) {
  throw new Error('The RSVP rehearsal requires a pristine disposable event.');
}

const previewRequest = {
  batch: candidateBatch,
  expectedRosterVersion: current.event.rsvpRosterVersion,
};
const preview = await json(await call(`/api/manage/events/${eventId}/rsvp/roster/preview`, {
  method: 'POST',
  headers: manageHeaders(),
  body: JSON.stringify(previewRequest),
}));
if (!preview.canCommit) {
  throw new Error(`The rehearsal roster did not validate: ${preview.issues.length} issues.`);
}
const commitRequest = {
  canonicalBatch: preview.canonicalBatch,
  previewDigest: preview.previewDigest,
  expectedRosterVersion: preview.rosterVersion,
  idempotencyKey: 'rsvp-load-capacity-v1',
};
const liveCommitBytes = serializedBytes(commitRequest);
if (liveCommitBytes > MAX_BATCH_BYTES) {
  throw new Error('The canonical rehearsal commit exceeds the RSVP batch envelope.');
}

const committed = await json(await call(`/api/manage/events/${eventId}/rsvp/roster/commit`, {
  method: 'POST',
  headers: manageHeaders(),
  body: JSON.stringify(commitRequest),
}));
if (committed.replayed) {
  throw new Error('A pristine rehearsal event unexpectedly replayed its first batch commit.');
}
const replayed = await json(await call(`/api/manage/events/${eventId}/rsvp/roster/commit`, {
  method: 'POST',
  headers: manageHeaders(),
  body: JSON.stringify(commitRequest),
}));
if (
  !replayed.replayed
  || replayed.committedRosterVersion !== committed.committedRosterVersion
  || replayed.currentRosterVersion !== committed.currentRosterVersion
) {
  throw new Error('The additive roster receipt did not replay the original commit.');
}

const imported = await json(await call(`/api/manage/events/${eventId}/rsvp/summary`, {
  headers: manageHeaders(),
}));

// 2. One scanned entry, then exactly the permitted number of lookups from it.
const entryToken = new URL(eventLink).hash.slice(1);
const exchange = await call('/api/entry/exchange', {
  method: 'POST', body: JSON.stringify({ token: entryToken }),
});
const guest = cookiesFrom(exchange, 'candidary_session', 'candidary_csrf');
const slug = (await exchange.json()).data.location.split('/').pop();

let matched = 0;
let submitted = 0;
for (let index = 0; index < IP_ATTEMPT_BUDGET; index += 1) {
  const response = await call(`/api/event/${slug}/rsvp/lookup`, {
    method: 'POST',
    headers: { cookie: guest.cookie, 'x-candidary-csrf': guest.csrf },
    body: JSON.stringify({ firstName: guestName(index) }),
  });
  const body = await json(response);
  if (body.status !== 'matched') {
    recordError(`lookup_${body.status}`);
    continue;
  }
  matched += 1;
  const rsvp = cookiesFrom(response, 'candidary_rsvp', 'candidary_rsvp_csrf');
  const household = body.household;
  const saved = await call(`/api/event/${slug}/rsvp/household`, {
    method: 'PUT',
    headers: { cookie: rsvp.cookie, 'x-candidary-rsvp-csrf': rsvp.csrf },
    body: JSON.stringify({
      version: household.version,
      idempotencyKey: `rehearsal-${index + 1}`,
      invitees: household.invitees.map((invitee) => ({
        id: invitee.id,
        // The named guest attends and the plus-one slot declines, so both
        // attendance values are exercised and no name has to be invented.
        attendance: invitee.kind === 'named' ? 'attending' : 'declined',
        displayName: null,
      })),
    }),
  });
  await json(saved);
  submitted += 1;
}

// 3. The attempt past the budget must be refused generically, by D1 rather than
//    by the edge, and must say when to come back.
const refused = await call(`/api/event/${slug}/rsvp/lookup`, {
  method: 'POST',
  headers: { cookie: guest.cookie, 'x-candidary-csrf': guest.csrf },
  body: JSON.stringify({ firstName: guestName(IP_ATTEMPT_BUDGET) }),
});
const refusedRetryAfter = refused.headers.get('retry-after');
if (refused.status !== 429 || refusedRetryAfter !== D1_RETRY_AFTER) {
  throw new Error(`The durable lookup boundary did not refuse attempt ${IP_ATTEMPT_BUDGET + 1}.`);
}
recordError('RATE_LIMITED');

const reconciled = await json(await call(`/api/manage/events/${eventId}/rsvp/summary`, {
  headers: manageHeaders(),
}));

const sorted = [...latencies].sort((left, right) => left - right);
const percentile = (fraction) => Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0).toFixed(1));

const reconciliation = {
  importedMatchesPlan:
    imported.invitedCapacity === CAPACITY
    && imported.namedInvitees === HOUSEHOLDS
    && imported.plusOneCapacity === HOUSEHOLDS
    && imported.awaitingResponse === CAPACITY,
  respondedMatchesPlan:
    reconciled.householdsResponded === plan.expectedRespondedHouseholds
    && reconciled.attending === plan.expectedAttending
    && reconciled.declined === plan.expectedDeclined
    && reconciled.awaitingResponse === plan.expectedAwaitingResponse,
};

// Counts, codes, and timings only — no names, cookies, tokens, or URLs.
console.log(JSON.stringify({
  mode: 'live',
  ...plan,
  previewBytes,
  commitBytes: liveCommitBytes,
  receiptReplayed: replayed.replayed,
  matched,
  submitted,
  summaryAfterImport: imported,
  summaryAfterResponses: reconciled,
  reconciliation,
  requests: latencies.length,
  latencyMsP50: percentile(0.5),
  latencyMsP95: percentile(0.95),
  latencyMsMax: Number((sorted.at(-1) ?? 0).toFixed(1)),
  errorsByCode: Object.fromEntries(errors),
  elapsedSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(2)),
}, null, 2));

if (!reconciliation.importedMatchesPlan || !reconciliation.respondedMatchesPlan) {
  throw new Error('The rehearsal totals did not reconcile against the server summary.');
}
