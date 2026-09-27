# Operational rehearsal access preflight — 2026-09-27

The owner indicated that preview testing and metrics access should be available now
through the Cloudflare code-mode MCP connection. The owner also confirmed that no
physical phones are available. Device evidence remains missing; the operational
rehearsal cannot qualify the physical iOS/Android lanes or universal compatibility.

## Verified remotely

Read-only calls against the existing Candidary Cloudflare account confirmed:

- Main preview Worker: version `2c42b186-3b75-4d30-81ea-982fcb579079` at 100%.
- Private preview decoder: version `ca4d8ff4-831d-4e92-867c-eafc806277f4` at 100%.
- Main Worker has the preview decoder service, `candidary_image_metrics_preview`
  Analytics Engine binding and all five expected Workflows. The decoder has
  `candidary_image_decoder_preview` and both decoder pool bindings.
- Preview D1 reports schema version 26, protocol 1 and migration
  `0026_mobile_image_compatibility.sql`; 29 of 32 admission rows are enabled.
  The preflight queries wrote no rows.
- The active Cloudflare API MCP connection can read GraphQL. A Workers-usage query
  for `2026-09-27T18:24:31.906Z` through `2026-09-27T18:39:31.906Z` returned an empty
  `main` array with no errors at `2026-09-27T18:44:32.339Z`. This is a recent absence
  of reported traffic, not a reservation or proof that future windows remain idle.

Local checks confirmed all six prepared load inputs match their recorded lengths
and SHA-256 hashes. `lock-image-decoder --verify` passed with fingerprint
`a4c238603f67f9c7ebfd9796fe4c722b773f75611b19d6c5b403db7fd8418651`.

## Metrics transport limitation

The active MCP connection consistently returns `Cloudflare API error: 200` for
Analytics Engine SQL, using both POST text/plain and GET query forms. The probe was
a SELECT count over the preview image metrics dataset for the previous 15 minutes.
No response rows were exposed. Catching the error exposes only its message/stack,
not a response body. A response-normalization problem is the working explanation;
the underlying metrics values and SQL permission are not claimed from this result.

GraphQL succeeds through the same connection. The existing offline instrumentation
builder can accept genuine, sanitized MCP-returned SQL and GraphQL measurements;
it does not require the exporter to have used a shell token. Preserve exact generated
queries, scope, windows and the actual response data. Do not manufacture an export
from HTTP status alone or replace the native resource metrics with Workers usage.

Fallback checks found:

- A second Cloudflare API connection requires reauthentication.
- The catalog's already-authorized `cloudflare-observability` connection fails to
  connect with `Gone` when creating its code-mode tool.
- The local Wrangler OAuth session has no Analytics Read scope, and no process
  `CLOUDFLARE_API_TOKEN` is supplied.
- The Edge Cloudflare dashboard was at sign-in. The owner selected private local
  token provisioning instead, so the unused sign-in tab was closed.

## Continuation

Obtain a working SQL response path through the existing MCP, a signed-in dashboard,
or a privately supplied Account Analytics Read token. Then refresh the idle-window
check, prepare the three dedicated events and scoped authorizations, and run the
[operational rehearsal](mobile-image-operational-rehearsal.md). Keep the genuine
observations and independent measurements even if a scenario fails.

The owner selected the token option. An empty
`output/verification/mobile-image-load/private/analytics-token.txt` was prepared;
`git check-ignore -v` confirms it is excluded by the repository's `output/` rule.
The owner subsequently supplied a token in conversation for an access check. At
`2026-09-27T18:51:44.434Z`, direct read-only HTTPS calls using non-echoing stdin and
process memory returned HTTP 200 and valid data for both preview Analytics Engine
datasets and the Workers/R2 GraphQL queries. This establishes the supplied token's
access to the measurements required by the exporter. During that access check the
credential was not saved to disk; the prepared private file was still empty. The sanitized result is recorded
under `output/verification/mobile-image-operational-20260927/analytics-access-check.json`.
The MCP SQL response limitation remains distinct from this successful direct access.

The owner then explicitly chose to retain and use the same credential. It was supplied
through non-echoing input to the existing ignored private file for the authorized run.
Fresh preflight at 18:54 UTC confirmed unchanged deployments, schema 26 and all five
DNG cases enabled. Both preview datasets had zero points in the 15 minutes preceding
setup. Three dedicated events were created through the normal product API, and the
bounded cold scenario started at `2026-09-27T18:55:54.756Z`. Ongoing results are recorded
separately in [the live rehearsal record](mobile-image-operational-results-20260927.md).

The read-only access preflight itself created no events, ran no load uploads, changed no Cloudflare resource
or admission setting, and produced no operational qualification report. No deployment,
commit or push occurred. Physical-device testing is unavailable under the owner's
current hardware access; it is no longer an unanswered availability question.
