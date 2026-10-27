# DropVault

DropVault is a temporary file-sharing app. It uses a React/TypeScript web client, an Express/TypeScript API, PostgreSQL metadata, Supabase Auth, and a private Supabase Storage bucket.

## Requirements and setup

- Node.js 20 or newer and npm
- A Supabase project with email/password Auth enabled, a private Storage bucket, and its PostgreSQL database

1. Copy `.env.example` to `.env` and supply the Supabase and database values listed below.
2. Create a **private** Storage bucket named by `SUPABASE_STORAGE_BUCKET` (default `dropvault-files`). Set its maximum object size to at least `MAX_UPLOAD_BYTES`.
3. In Supabase Auth, enable email/password sign-in and set the site URL and allowed redirect URL to `http://localhost:5173` for local development.
4. Apply `supabase/migrations/0001_initial_schema.sql`, then `supabase/migrations/0002_file_expiration.sql` to the Supabase PostgreSQL database.
5. From the project root, install and start the apps:

   ```sh
   npm install
   npm run dev
   ```

   The web app runs at <http://localhost:5173> and the API at <http://localhost:3000>. Vite reads the root `.env` and embeds only the public Supabase URL, anon key, and upload-size setting for the browser. The service-role key stays in the API process. Restart the web dev server after changing Vite environment values.

On Windows PowerShell, use `npm.cmd` if the execution policy blocks `npm.ps1`.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | API port; defaults to `3000` |
| `WEB_ORIGIN` | No | Allowed browser origin; defaults to `http://localhost:5173` |
| `DATABASE_URL` | Yes | Supabase PostgreSQL connection string |
| `SUPABASE_URL` | Yes | Supabase project URL; public client configuration |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon/publishable key; public client configuration |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Backend only; privileged private Storage operations |
| `SUPABASE_STORAGE_BUCKET` | No | Private bucket name; defaults to `dropvault-files` |
| `MAX_UPLOAD_BYTES` | No | API upload limit; defaults to `10485760` (10 MiB), maximum `52428800` (50 MiB) |
| `VITE_MAX_UPLOAD_BYTES` | No | Optional frontend cap; defaults to the API limit and is clamped so it cannot exceed that limit |
| `VITE_API_BASE_URL` | No | API origin for split-origin deployments, without a trailing `/api`; defaults to same-origin `/api` |
| `VITE_WEB_ORIGIN` | No | Canonical frontend origin used in newly generated recipient links; defaults to the current web origin |

Never put `SUPABASE_SERVICE_ROLE_KEY` in frontend code, `VITE_` variables, or browser configuration. The browser only talks directly to Supabase Auth using the anon key; all file bytes and metadata go through the API.

## Implemented API

- `GET /api/health` is an unauthenticated health check.
- `GET /api/files` lists metadata owned by the authenticated user.
- `POST /api/files` accepts multipart fields `file` and optional ISO-8601 `expiresAt`. Files are available for at most seven days from upload; an omitted expiration defaults to seven days, and an explicit expiration must be in the future and within that limit.
- `DELETE /api/files/:id` removes an owned object and its metadata.
- `POST /api/files/:id/share-links` creates an owner-only share link with a required future `expiresAt` no more than seven days away and no later than the file's expiration; the raw token is returned once and only its SHA-256 hash is stored.
- `GET /api/files/:id/share-links` lists up to the 100 most recently created links and returns `hasMore` when additional links exist. It never returns tokens or hashes.
- `DELETE /api/files/:id/share-links/:linkId` revokes only the specified owned link and is safe to repeat.
- `GET /api/share/:token` is public to recipients holding an active token and returns only `{ "filename", "contentType", "sizeBytes", "expiresAt" }`. It returns the same generic unavailable response for malformed, unknown, expired, revoked, or removed shares. It never returns token hashes, owner IDs, storage paths, or file contents.
- `GET /api/share/:token/download` is public to recipients holding a valid share token. It streams the associated file through the API and does not require a Supabase session.

Private file routes verify the Supabase access token server-side and derive ownership from its user ID. Recipient downloads hash the supplied token and check revocation plus both expiration timestamps against PostgreSQL time. The API enforces a seven-day availability maximum from upload, including for older rows without an expiration timestamp or with a longer legacy expiration. The API creates a private Storage signed URL internally with a maximum 30-second lifetime and a 5-second safety margin, then streams the object to the recipient without returning that URL. The route rechecks share authorization before fetching, but cannot cancel a stream already in progress if a link is revoked or expires. Storage and PostgreSQL behavior has not been verified against live services.

The share token is a bearer credential in the request path. The API does not log requests, but deployment access logs should redact `/api/share/*/download` paths.

Uploads are capped by `MAX_UPLOAD_BYTES` and limited to PDF, JPEG, PNG, WebP, and UTF-8 plain text. Binary file signatures are checked against the declared MIME type. API responses do not expose private Storage paths. Automatic removal of expired objects and rate limiting for recipient downloads are not implemented.

## Tests, lint, and builds

```sh
npm test
npm run lint
npm run build
```

Tests mock Supabase and PostgreSQL boundaries; they verify authentication UI behavior, protected API routes, owner scoping, upload validation, share-link authorization, download streaming, storage cleanup, and file listing/deletion without requiring live service credentials. They do not verify real signed URLs, database locking/time behavior, or live Storage policies. For manual integration checks, use a confirmed non-production project, verify the migrations and private bucket, and test with dedicated accounts and files.

## Deployment preparation

The repository does not include a provider-specific deployment manifest. Deploy the API as a Node.js service and the web build as static files, or put both behind a host/reverse proxy that routes `/api` to the API. Use Node.js 20 or newer. No migration runs automatically at API startup.

### Supabase project

Configure the target Supabase project before starting the API:

1. Enable email/password sign-in in Auth. Set the Auth site URL to the deployed HTTPS web origin and allow that origin in the Auth redirect URL settings. For local development, the existing values remain `http://localhost:5173`.
2. Apply `supabase/migrations/0001_initial_schema.sql` followed by `supabase/migrations/0002_file_expiration.sql` to that project's PostgreSQL database using your migration workflow. Migration 0001 creates `files` and `share_links`, enables row-level security, and adds owner policies; migration 0002 adds file expiration. Back up/target the intended project before applying migrations.
3. Create the Storage bucket named by `SUPABASE_STORAGE_BUCKET` (default `dropvault-files`) and keep it private. Set its maximum object size to at least `MAX_UPLOAD_BYTES`. API startup checks that the configured bucket exists and is private, and exits if that check fails. The browser does not access Storage directly.
4. Use the database connection string for this same project and preserve the SSL/connection options supplied for the selected Supabase connection method. Confirm the deployed API can reach PostgreSQL.

### Runtime and build configuration

Set API variables in the API host's secret/configuration store. `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are required by the API's startup validation. Set `WEB_ORIGIN` to the exact web origin, including `https://` and with no path or trailing slash; its default is local development. The stable `https://drop-vault-nine.vercel.app` origin is allowed by the API, while Vercel preview deployment URLs are intentionally ignored even if supplied as `WEB_ORIGIN`. For another frontend host, set `WEB_ORIGIN` to its origin. `PORT` may be supplied by the host. `SUPABASE_STORAGE_BUCKET` and `MAX_UPLOAD_BYTES` may use their documented defaults. Keep the service-role key only in the API environment; never name it with a `VITE_` prefix.

The web build reads the root environment at build time. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` to the public project URL and anon/publishable key; the Vite configuration embeds these public Auth settings, the upload cap, and the API origin only when `VITE_API_BASE_URL` is set. `VITE_MAX_UPLOAD_BYTES` is optional and cannot raise the API's `MAX_UPLOAD_BYTES` limit. `VITE_API_BASE_URL` is optional and must be the API origin only (for example, `https://api.example.test`), without `/api` or a trailing slash. Without it, the browser uses same-origin `/api`; production hosting must then route `/api` to the API. The Vite development proxy is local-development configuration and is not included in the production web server.

For separate web and API origins, serve both over HTTPS, set `VITE_API_BASE_URL` at web build time, and set API `WEB_ORIGIN` to the exact web origin. Set `VITE_WEB_ORIGIN` when share links should use a canonical frontend domain; otherwise links use the current frontend origin. New links use `/?share=<token>` and the recipient page calls the public metadata endpoint before initiating a direct browser download from `/api/share/:token/download`. For same-origin hosting, configure the host/reverse proxy to forward `/api/*` to the API. The API streams downloads and does not return Supabase signed URLs. Ensure hosting access logs redact `/api/share/*` paths because they contain bearer tokens.

For the Render API service, keep the repository root as Root Directory and use `npm ci --include=dev && npm run build --workspace @dropvault/api` as the Build Command. The explicit `--include=dev` keeps TypeScript and the API's `@types/*` packages available if `NODE_ENV=production` or npm omit settings would otherwise exclude build-time development dependencies. Use `npm run start --workspace @dropvault/api` as the Start Command. A full local monorepo build can be run from the repository root with `npm run build`; this produces the API in `apps/api/dist` and static web assets in `apps/web/dist`. Configure the web host to serve `apps/web/dist`. The API exposes `GET /api/health` for a process liveness check. It does not check database readiness on that endpoint; successful API startup checks configuration and the private bucket, while schema/database behavior must be checked through the integration procedure below. There is no automatic expired-object cleanup, so plan storage cleanup/retention before a larger production rollout.

## Non-production integration procedure

Run these checks only against a dedicated non-production Supabase project, database, and private bucket. Use test accounts and disposable files. Do not place credentials or access tokens in source control, shared logs, or this README.

1. Confirm the Supabase project is non-production. Enable email/password Auth, configure its site/redirect origins, apply both migrations in order, create the private bucket, and verify the bucket size limit covers `MAX_UPLOAD_BYTES`.
2. Configure the API runtime variables and web build-time variables from the tables above using non-production values. Start the API and check `GET https://<api-origin>/api/health`; then open the deployed/staged web app. For split origins, confirm the browser's `/api` calls go to `VITE_API_BASE_URL` and are allowed by `WEB_ORIGIN`; for same-origin hosting, confirm the proxy forwards `/api` correctly.
3. Sign up and sign in as test user A. Upload a small allowed file (PDF, JPEG, PNG, WebP, or UTF-8 plain text). Confirm it appears in A's dashboard and as an object in the private bucket. As an unauthenticated request, attempt to read that known object through the Storage endpoint; it must not be publicly readable.
4. Create a share link in the dashboard. Open its public download URL in a private/incognito browser with no Supabase session and confirm the downloaded contents match. Revoke it in A's dashboard and confirm the same URL no longer downloads the file (the API returns the generic unavailable response).
5. Verify link expiration independently using A's authenticated `POST /api/files/:id/share-links` endpoint with the documented `{ "expiresAt": "<future ISO-8601 timestamp>" }` body and a short future expiry. Confirm the download works before expiry and is unavailable after expiry. Also upload a file with a short future file expiration, create a link that expires at the file's expiration, and confirm the file/link becomes unavailable after that time. Use only short expirations on disposable non-production data.
6. Sign in as test user B in a separate session. Confirm B's file list does not include A's file. Using B's access token and A's known file ID, call the authenticated file deletion endpoint; it must return not found and leave A's object intact. B must likewise not be able to list A's share links.
7. As A, delete the test file in the dashboard. Confirm the metadata row is gone and the object is gone from the private bucket. Check the bucket and `public.files` records for unmatched objects/rows to catch orphans; repeat after a failed upload if testing the upload-cleanup path. Remove remaining disposable test data.
8. Review browser network requests and API logs for successful frontend/API communication, expected CORS behavior, HTTPS origins, and redaction of share-token paths. Do not treat the liveness endpoint alone as proof that database queries, migrations, or Storage operations work.

These steps are a procedure only; no remote project, migration, bucket, or live integration test has been checked by this repository review.

## Project layout

```text
apps/api/       Express API, auth middleware, upload routes, PostgreSQL access, tests
apps/web/       React dashboard and Supabase Auth UI
supabase/       PostgreSQL migrations
```

Automatic expiration cleanup remains a future milestone.
