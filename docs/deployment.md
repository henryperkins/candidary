# Deployment

## Provision Cloudflare resources

Create one D1 database and one private R2 bucket, then replace the placeholder D1 UUID in `wrangler.jsonc` and confirm the deployed origin and bucket names.

```powershell
npx wrangler d1 create candidary-core
npx wrangler r2 bucket create candidary-media
```

Set the R2 CORS policy after replacing the example origin:

```powershell
Copy-Item config/r2-cors.example.json config/r2-cors.json
npx wrangler r2 bucket cors set candidary-media --file config/r2-cors.json
```

The bucket must remain private. CORS permits only browser PUT requests from the application origin with the signed `content-type` header. Original and export reads remain authorization-checked Worker responses or manager-only signed GETs.

## Secrets

Generate three independent 32-byte secrets and store them with Wrangler. The guest encryption value must be base64url-encoded because it is imported as an AES-256-GCM key.

```powershell
npx wrangler secret put TOKEN_HMAC_KEY
npx wrangler secret put SESSION_HMAC_KEY
npx wrangler secret put GUEST_TOKEN_ENCRYPTION_KEY
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

The R2 credentials should be scoped to the single Candidary bucket with object read/write permissions. Do not reuse the token or session HMAC key.

## Migrate and deploy

```powershell
npx wrangler d1 migrations apply candidary-core --remote
npm run deploy
```

The deploy includes the `candidary-export` Workflow binding, private asset/Worker routing, and the daily `17 3 * * *` cleanup trigger. Confirm the generated `APP_ORIGIN` exactly matches the public HTTPS origin before sharing links.

## Public-launch gate

The unauthenticated event-creation endpoint is intended for a controlled pilot. Before unrestricted traffic, put Cloudflare rate limiting and Turnstile in front of `POST /api/events`, add alerting for creation/upload spikes, and confirm the abuse response owner. This repository deliberately does not simulate those deployment-layer controls.

## Post-deploy checks

1. Create an event and save both one-time links.
2. Open the guest link in a separate browser profile; verify the secret disappears after exchange.
3. Upload JPEG, PNG, and WebP samples and reject one.
4. Confirm the rejected object fails through the old content URL.
5. Approve one original, confirm gallery visibility, then prepare and download its ZIP.
6. Rotate the guest link and verify the old guest session stops immediately.
7. Inspect Workflow, Worker, D1, and R2 telemetry before allowing pilot participants.
