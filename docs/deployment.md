# Deployment

## Provision Cloudflare resources

Create one D1 database and one private R2 bucket, enable Cloudflare Images for the account, then confirm the IDs, names, and public origin in `wrangler.jsonc`.

```powershell
npx wrangler d1 create candidary-core
npx wrangler r2 bucket create candidary-media
```

The Worker uses an `IMAGES` binding for metadata-free browser previews, including HEIC and HEIF. Confirm the account plan and Images availability before deploying; preview failure never removes an already delivered original, but hosts need the binding to view phone formats cross-browser.

The R2 CORS policy names the application origin, so it has to be reset whenever `APP_ORIGIN` changes — a signed browser `PUT` comes from the page, not from the Worker, and a stale origin fails every upload while leaving the rest of the app working. Set it after replacing the example origin:

```powershell
Copy-Item config/r2-cors.example.json config/r2-cors.json
npx wrangler r2 bucket cors set candidary-media --file config/r2-cors.json
```

The bucket remains private. CORS permits signed browser PUT requests from the application origin with the signed `content-type` header. Originals are manager-only; previews are authorization-checked; export links are short-lived and manager-only.

## Transport security

Enable **SSL/TLS → Edge Certificates → Always Use HTTPS** for the zone. A plain-HTTP request is then redirected at the edge and never reaches the Worker. Leave the **HSTS** card in that same panel switched off — the policy ships from the repo instead, and the check at the end of this section catches it if both are on.

Both response surfaces send `Strict-Transport-Security: max-age=31536000; includeSubDomains`: `worker/http/security-headers.ts` for the paths in `assets.run_worker_first`, and `public/_headers` for everything the asset server answers directly — including `/`, which is where most first visits land. The Worker emits it only when the request URL scheme is `https:`, as RFC 6797 requires, so its absence under `npm run dev` over localhost is correct rather than a regression.

The value is pinned once per surface — `tests/unit/static-headers.test.ts` reads `public/_headers` off disk, and `tests/worker/security-headers.test.ts` exercises the middleware in workerd. Neither test can see the other's surface, so a green `npm run test:unit` says nothing about the Worker's copy; only `npm test` covers both.

Before changing the apex, confirm no subdomain is expected to answer over plain HTTP. `includeSubDomains` commits every subdomain to HTTPS for a year and cannot be withdrawn from browsers that already saw it. The 2026-07-28 audit found only the mail return-path subdomain `cf-bounce`, which carried DNS records rather than an HTTP service; recheck the zone before any later policy change. `preload` is omitted on purpose.

After deploying, confirm exactly one policy is in force:

```powershell
(curl.exe -sSI https://candidary.online/ | Select-String 'strict-transport-security').Count
```

Expected `1`. A `2` means the zone's own HSTS setting is on as well and is appending a second policy, which may carry a different max-age — switch the dashboard setting off rather than reconciling the two. Keeping one source in the repo is what keeps the value under version control and under test.

## Secrets

Generate independent 32-byte values and store them with Wrangler. The guest encryption value is base64url-encoded for AES-256-GCM.

```powershell
npx wrangler secret put TOKEN_HMAC_KEY
npx wrangler secret put SESSION_HMAC_KEY
npx wrangler secret put GUEST_TOKEN_ENCRYPTION_KEY
npx wrangler secret put LOGIN_HMAC_KEY
npx wrangler secret put ENTRY_HMAC_KEY
npx wrangler secret put ENTRY_ENCRYPTION_KEY
npx wrangler secret put RSVP_LOOKUP_HMAC_KEY
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Scope the R2 credentials to the single Candidary bucket with object read/write permissions. Never reuse the token or session HMAC key. Both encryption values are base64url-encoded 32-byte keys.

Three of these are **persisted-data keys, not rotation controls**. `ENTRY_HMAC_KEY` digests the credential printed on every invitation, `ENTRY_ENCRYPTION_KEY` encrypts the same credential for redisplay, and `RSVP_LOOKUP_HMAC_KEY` keys every stored name digest and rate-limit scope. Rotating any of them without a matching re-digest or re-encryption migration breaks every printed QR or makes every household unreachable by lookup. Signing guest devices out and rotating a management link are the routine controls and must never touch these three. Verify only their names in release evidence, never their values, and provision them through secret-safe tooling rather than shell history.

All nine are listed under `secrets.required` in `wrangler.jsonc`. That declaration is the source of truth for generated binding types and makes Wrangler refuse to deploy a Worker whose required secret is missing, so a forgotten value fails the upload rather than the first host who tries to sign in. Run `npx wrangler types` after changing it.

## Rate-limiting bindings

Two Cloudflare rate-limiting namespaces are declared in `wrangler.jsonc`: `HOST_AUTH_RATE_LIMIT` for
account authentication, and `RSVP_LOOKUP_RATE_LIMIT` at 30 requests per 60 seconds for household
lookup. Confirm both exist in the target account before an event opens; the D1 budgets behind them are
defense in depth, not a replacement.

## Migrate and deploy

```powershell
npx wrangler d1 migrations apply candidary-core --remote
npm run deploy
```

This applies every pending migration, including the private-delivery/publication split,
partitioned-export schema, host accounts, and canonical per-event theme configuration. The deploy
then publishes the export Workflow, Images binding, private asset routing, the daily cleanup
trigger, and the hourly notification-dispatch trigger. Confirm `APP_ORIGIN` exactly matches the
HTTPS origin before printing a QR code.

The two commands are in that order for a reason, and from `0005_media_stored_at.sql` onward the
order is load-bearing rather than tidy: the manager's intake queries select and order by
`media.stored_at` (`worker/db/media.ts`), so Worker code deployed against a database without that
column fails the manager's first request. The opposite order strands nobody — `0005` carries a
compatibility trigger that stamps `stored_at` for any finalization performed by Worker code older
than the column, so a migrated database serving the previous deployment is a state the schema was
written to sit in.

Production is migrated through `0007_event_theme.sql` as of 2026-07-29, confirmed by the apply
command reporting nothing to do. The apply command is the only thing that answers what is true of
the database you are actually pointed at, so run it before every deploy regardless of what this
paragraph remembers.

### 0008 is a clean-launch migration with no backfill

`0008_event_rsvp.sql` is purely additive — new columns on `events`, two deadline triggers, and the
entry, household, invitee, receipt, session, and rate-limit tables — so applying it to a populated
database succeeds. What it deliberately does **not** do is create an entry credential for events that
already exist. There is no backfill and no compatibility fallback for the old `/join/:token` URL, by
design: existing data is not a supported input to this first product shape.

An event created before 0008 therefore has no printed entry after the deploy, and its guests cannot
reach it at all. Before applying 0008, count what would be affected on the pre-0008 ledger:

```powershell
npx wrangler d1 execute candidary-core --remote --command "SELECT count(*) AS active FROM events WHERE deleted_at IS NULL"
```

If the result is zero, apply 0008 and deploy normally. If it is not zero, do not ship mixed-version
behaviour. Use the authorized clean-D1 or fresh-D1 binding procedure instead, and before doing so:

1. Confirm the exact account, Worker, D1 database ID **and** name, and R2 bucket you are pointed at.
   A destructive operation aimed at the wrong database is not recoverable.
2. Record whether existing R2 objects are preserved or deleted. That is a **separate** explicit
   decision: permission to reset D1 is never permission to delete objects, and objects whose D1 rows
   are gone can no longer be discovered by any cleanup pass.
3. Only then apply 0008 to the chosen target.

After applying, prove there are no pending migrations and that referential integrity is intact:

```powershell
npx wrangler d1 migrations list candidary-core --remote
npx wrangler d1 execute candidary-core --remote --command "PRAGMA foreign_key_check"
```

Both must come back empty.

## Wedding rehearsal gate

Do not describe a deployment as wedding-ready until a dedicated rehearsal event passes all of the following:

1. Print the actual QR at intended reception size and scan it from normal guest distance. Decode the
   printed artefact locally and record only a SHA-256 fingerprint plus the non-secret origin and path
   prefix — never the raw credential URL.
2. On current iPhone Safari and Android Chrome, scan that same physical artefact during RSVP-primary,
   again after an ordinary **Sign out guest devices** rotation, and again during photos-primary.
   Confirm the credential disappears from the address bar each time, and compare the local SHA-256
   fingerprints: they must not change.
3. Enter a name, take a new photo, append recent photos, send, and reach the exact terminal receipt.
4. Repeat over deliberately degraded reception; recover one partial failure and one expired signed URL without duplicating a delivery or re-uploading an already transferred original.
5. Upload JPEG, PNG, WebP, HEIC, and HEIF samples, including vendor-specific phone MIME values; view metadata-free private previews while retaining byte-identical originals. Confirm preview requests fail safely when the Images binding is intentionally unavailable.
6. Confirm a different guest cannot read unpublished previews or any original, and a host can download every original.
7. Enable the gallery, publish one preview, hide it again, and confirm hiding never removes it from intake or export.
8. Run both opt-in load harnesses against the disposable event at the intended target, monitor Worker/D1/R2/Images/Workflow telemetry, then delete the event. Reconcile the RSVP harness's imported and responded totals against the manager summary.
9. Prepare the manifest and every export part, download them with a common ZIP tool, and reconcile counts.
10. Sign guest devices out, confirm old sessions stop while the printed link is unchanged, and test scheduled reservation/export cleanup.
11. Import a guest list, then rehearse the RSVP journey end to end: an exact-name match, an ambiguous first name resolved by a second name, individual attend/decline with an attending plus-one name, a revision, deadline closure, and a host correction afterwards.
12. Rehearse **Disable printed event QR** on a disposable event only. Prove that future scans and existing guest and household sessions all stop while manager access still works, and that no replacement is offered.
13. Review live logs for the rehearsal window and confirm no line carries a raw credential, ciphertext, submitted name, RSVP body, or CSV row.

Desktop emulation is supplementary. Physical iPhone and Android evidence, Images availability, load evidence, and this production-like rehearsal are release gates.

## Device and assistive-technology rehearsal gate

These are **production rehearsal gates performed by a person on real hardware**. They are not covered
by the automated suite and nothing below may be recorded as passed on the strength of a green
`npm run test:e2e`. The suite runs one Chromium engine under viewport emulation on Windows: it can
prove geometry, containment, target size, focus order, resolved contrast, reduced motion, and
`axe-core` 4.12.1's default rule set plus `target-size` — 90 of the 105 rules it ships, nothing
scoped away, with the omissions and complete global/event-theme surface matrix enumerated in
`design-qa.md` — and it can prove none of the following.

The engine currently reports zero accessibility violations, but note what that is and is not. It
means computed colour pairings clear WCAG AA arithmetically on the states the suite renders. Muted
ink on parchment clears it by 0.0046 — see `design-qa.md`. Arithmetic is not legibility: check the
guest captions, the disclosure summaries, and the footer on a real phone screen at reception
brightness, outdoors, and at whatever the device's own contrast and text-size settings are set to.

14. **Physical iPhone Safari.** Scan the printed code on a current iPhone. Confirm the RSVP lookup's
    first fold before the event and the photo drop's first fold on the day, that both photo sources
    are reachable without scrolling, that the dynamic toolbar appearing and disappearing never hides
    a control or introduces horizontal scrolling, and that rotating to landscape keeps a full camera
    target on screen. Repeat on the manager link and step through all six sections.
15. **Physical Android Chrome.** Repeat the same pass on a current Android phone, including the
    address bar collapsing on scroll and the on-screen keyboard opening over the RSVP name field, the
    guest name field, and the note field.
16. **Real HEIC selection.** From the iPhone's own photo library, select genuine HEIC and HEIF
    captures — not files copied through a desktop — and send them. Confirm the picker accepts them,
    the vendor MIME value is accepted, private previews render, and the originals stay byte-identical.
17. **VoiceOver on iOS.** With VoiceOver on, reach and operate the guest name field, both photo
    sources, the review list, and the send action; confirm each upload state change is announced and
    that a failure announces both what happened and the way out of it. On the RSVP household form,
    confirm every person is announced as a named group with two labelled radios, that an incomplete
    row announces its own error, and that a refused write announces the review heading it moves to.
    On the manager, confirm the six destinations announce their names and selected state, and that a
    refused write announces through the live region without moving focus.
18. **TalkBack on Android.** Repeat the guest, RSVP, and manager passes with TalkBack, including swipe
    navigation through the section rail and the full-screen gallery's close control.
19. **10,000-photo disposable event.** On a disposable event loaded to the documented per-event cap,
    confirm on a phone that intake still pages rather than loading everything, that the count badge
    renders the full five-digit number, that scrolling stays smooth, and that a complete export can
    be prepared and downloaded. Delete the event afterwards.
20. **Degraded-network RSVP retry.** On the venue network, drop a submission mid-flight and confirm
    the retry either commits once or replays the same successful response — never a second, different
    answer for the same household.

Record the device models, OS versions, and browser versions with the result. A gate exercised on an
emulator, a simulator, or a desktop browser's device mode does not count.

## Public-launch gate

The event-creation endpoint is suitable for a controlled deployment. Before unrestricted public traffic, add Cloudflare rate limiting and Turnstile to `POST /api/events`, alert on creation/upload spikes, and assign an abuse-response owner.

## Email

Host accounts send confirmation codes, password resets, and lifecycle notifications through the `EMAIL` binding (Cloudflare Email Service).

`candidary.online` is onboarded as a sending domain with DNS status `ready`: SPF and DKIM on the `cf-bounce` return-path subdomain, and `_dmarc` at `p=reject`. Mail is sent as `hello@candidary.online`, set in `EMAIL_FROM`. The account quota is 1,000 messages per day.

Setting up a different domain means repeating three things:

1. Create a sending subdomain for the zone and let Cloudflare write its SPF, DKIM, and DMARC records. A `workers.dev` subdomain cannot be used — those records need DNS you control.
2. Point `EMAIL_FROM` at an address on that domain.
3. Confirm the account is on the Workers Paid plan. The free plan can only send to verified destination addresses in your own account, which is not enough for real hosts.

`LOGIN_HMAC_KEY` is a secret like the others and is required whether or not mail is configured — it signs the emailed codes and the unsubscribe links.

Without remote bindings, `wrangler dev` simulates sending and writes each message to a local file, so local development needs no mail configuration at all. Add `"remote": true` to the `send_email` binding to send real mail from a local Worker.
