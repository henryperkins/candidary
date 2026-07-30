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
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Scope the R2 credentials to the single Candidary bucket with object read/write permissions. Never reuse the token or session HMAC key.

All six are listed under `secrets.required` in `wrangler.jsonc`. That declaration is the source of truth for generated binding types and makes Wrangler refuse to deploy a Worker whose required secret is missing, so a forgotten value fails the upload rather than the first host who tries to sign in. Run `npx wrangler types` after changing it.

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

## Wedding rehearsal gate

Do not describe a deployment as wedding-ready until a dedicated rehearsal event passes all of the following:

1. Print the actual QR at intended reception size and scan it from normal guest distance.
2. On current iPhone Safari and Android Chrome, exchange the link and confirm the secret disappears from the address bar.
3. Enter a name, take a new photo, append recent photos, send, and reach the exact terminal receipt.
4. Repeat over deliberately degraded reception; recover one partial failure and one expired signed URL without duplicating a delivery or re-uploading an already transferred original.
5. Upload JPEG, PNG, WebP, HEIC, and HEIF samples, including vendor-specific phone MIME values; view metadata-free private previews while retaining byte-identical originals. Confirm preview requests fail safely when the Images binding is intentionally unavailable.
6. Confirm a different guest cannot read unpublished previews or any original, and a host can download every original.
7. Enable the gallery, publish one preview, hide it again, and confirm hiding never removes it from intake or export.
8. Run the opt-in load harness against the disposable event at the intended target, monitor Worker/D1/R2/Images/Workflow telemetry, then delete the event.
9. Prepare the manifest and every export part, download them with a common ZIP tool, and reconcile counts.
10. Rotate the guest link, confirm old sessions stop, and test scheduled reservation/export cleanup.

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

11. **Physical iPhone Safari.** Open the guest link on a current iPhone. Confirm the photo drop's
    first fold, that both photo sources are reachable without scrolling, that the dynamic toolbar
    appearing and disappearing never hides a control or introduces horizontal scrolling, and that
    rotating to landscape keeps a full camera target on screen. Repeat on the manager link and step
    through all five sections.
12. **Physical Android Chrome.** Repeat the same pass on a current Android phone, including the
    address bar collapsing on scroll and the on-screen keyboard opening over the guest name field and
    the note field.
13. **Real HEIC selection.** From the iPhone's own photo library, select genuine HEIC and HEIF
    captures — not files copied through a desktop — and send them. Confirm the picker accepts them,
    the vendor MIME value is accepted, private previews render, and the originals stay byte-identical.
14. **VoiceOver on iOS.** With VoiceOver on, reach and operate the guest name field, both photo
    sources, the review list, and the send action; confirm each upload state change is announced and
    that a failure announces both what happened and the way out of it. On the manager, confirm the
    five destinations announce their names and selected state, and that a refused write announces
    through the live region without moving focus.
15. **TalkBack on Android.** Repeat the guest and manager passes with TalkBack, including swipe
    navigation through the section rail and the full-screen gallery's close control.
16. **10,000-photo disposable event.** On a disposable event loaded to the documented per-event cap,
    confirm on a phone that intake still pages rather than loading everything, that the count badge
    renders the full five-digit number, that scrolling stays smooth, and that a complete export can
    be prepared and downloaded. Delete the event afterwards.

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
