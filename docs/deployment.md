# Deployment

## Provision Cloudflare resources

Create one D1 database and one private R2 bucket, enable Cloudflare Images for the account, then confirm the IDs, names, and public origin in `wrangler.jsonc`.

```powershell
npx wrangler d1 create candidary-core
npx wrangler r2 bucket create candidary-media
```

The Worker uses an `IMAGES` binding for metadata-free browser previews, including HEIC and HEIF. Confirm the account plan and Images availability before deploying; preview failure never removes an already delivered original, but hosts need the binding to view phone formats cross-browser.

Set the R2 CORS policy after replacing the example origin:

```powershell
Copy-Item config/r2-cors.example.json config/r2-cors.json
npx wrangler r2 bucket cors set candidary-media --file config/r2-cors.json
```

The bucket remains private. CORS permits signed browser PUT requests from the application origin with the signed `content-type` header. Originals are manager-only; previews are authorization-checked; export links are short-lived and manager-only.

## Secrets

Generate independent 32-byte values and store them with Wrangler. The guest encryption value is base64url-encoded for AES-256-GCM.

```powershell
npx wrangler secret put TOKEN_HMAC_KEY
npx wrangler secret put SESSION_HMAC_KEY
npx wrangler secret put GUEST_TOKEN_ENCRYPTION_KEY
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Scope the R2 credentials to the single Candidary bucket with object read/write permissions. Never reuse the token or session HMAC key.

## Migrate and deploy

```powershell
npx wrangler d1 migrations apply candidary-core --remote
npm run deploy
```

This applies the private-delivery/publication split and partitioned-export schema, then deploys the export Workflow, Images binding, private asset routing, and daily cleanup trigger. Confirm `APP_ORIGIN` exactly matches the HTTPS origin before printing a QR code.

## Wedding rehearsal gate

Do not describe a deployment as wedding-ready until a dedicated rehearsal event passes all of the following:

1. Print the actual QR at intended reception size and scan it from normal guest distance.
2. On current iPhone Safari and Android Chrome, exchange the link and confirm the secret disappears from the address bar.
3. Enter a name, take a new photo, append recent photos, send, and reach the exact terminal receipt.
4. Repeat over deliberately degraded reception; recover one partial failure without duplicating a delivery.
5. Upload JPEG, PNG, WebP, HEIC, and HEIF samples; view private previews while retaining byte-identical originals.
6. Confirm a different guest cannot read unpublished previews or any original, and a host can download every original.
7. Enable the gallery, publish one preview, hide it again, and confirm hiding never removes it from intake or export.
8. Run the opt-in load harness against the disposable event at the intended target, monitor Worker/D1/R2/Images/Workflow telemetry, then delete the event.
9. Prepare the manifest and every export part, download them with a common ZIP tool, and reconcile counts.
10. Rotate the guest link, confirm old sessions stop, and test scheduled reservation/export cleanup.

Desktop emulation is supplementary. Physical iPhone and Android evidence, Images availability, load evidence, and this production-like rehearsal are release gates.

## Public-launch gate

The event-creation endpoint is suitable for a controlled deployment. Before unrestricted public traffic, add Cloudflare rate limiting and Turnstile to `POST /api/events`, alert on creation/upload spikes, and assign an abuse-response owner.
