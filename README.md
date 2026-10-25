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

Never put `SUPABASE_SERVICE_ROLE_KEY` in frontend code, `VITE_` variables, or browser configuration. The browser only talks directly to Supabase Auth using the anon key; all file bytes and metadata go through the API.

## Implemented API

- `GET /api/health` is an unauthenticated health check.
- `GET /api/files` lists metadata owned by the authenticated user.
- `POST /api/files` accepts multipart fields `file` and optional ISO-8601 `expiresAt`.
- `DELETE /api/files/:id` removes an owned object and its metadata.

File routes verify the Supabase access token server-side and derive ownership from its user ID. Uploads are capped by `MAX_UPLOAD_BYTES` and limited to PDF, JPEG, PNG, WebP, and UTF-8 plain text. Binary file signatures are checked against the declared MIME type. API responses never include private storage paths. File expiration is stored as metadata; automatic removal of expired objects is not implemented yet.

## Tests, lint, and builds

```sh
npm test
npm run lint
npm run build
```

Tests mock Supabase and PostgreSQL boundaries; they verify authentication UI behavior, protected API routes, owner scoping, upload validation, storage cleanup, and file listing/deletion without requiring live service credentials. For a manual integration check, use the project `.env`, run the database migrations, and confirm the configured Storage bucket is private.

## Project layout

```text
apps/api/       Express API, auth middleware, upload routes, PostgreSQL access, tests
apps/web/       React dashboard and Supabase Auth UI
supabase/       PostgreSQL migrations
```

Share-link creation, recipient downloads, and automatic expiration cleanup remain future milestones.
