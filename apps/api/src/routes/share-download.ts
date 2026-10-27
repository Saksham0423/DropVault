import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import type { Pool } from "pg";
import type { SupabaseClients } from "../lib/supabase.js";
import { ApiError } from "../middleware/error-handler.js";

const shareTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const shareTokenBytes = 32;
const signedUrlMaximumSeconds = 30;
const signedUrlSafetyMarginSeconds = 5;
const allowedDownloadTypes = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain"]);

const authorizedShareQuery = `with authorization_time as materialized (
  select clock_timestamp() as checked_at
)
select file.owner_id, file.storage_path, file.original_name, file.content_type,
  file.size_bytes, share_link.expires_at,
  least($2::numeric, floor(extract(epoch from (
    least(share_link.expires_at, coalesce(file.expires_at, share_link.expires_at)) - authorization_time.checked_at
  ))) - $3::numeric)::integer as signed_url_ttl_seconds
from public.share_links as share_link
join public.files as file on file.id = share_link.file_id
cross join authorization_time
where share_link.token_hash = $1
  and share_link.revoked_at is null
  and share_link.expires_at > authorization_time.checked_at
  and (file.expires_at is null or file.expires_at > authorization_time.checked_at)
limit 1`;

interface ShareDownloadDependencies {
  database: Pick<Pool, "query">;
  storageBucket: SupabaseClients["privateBucket"];
}

interface AuthorizedShare {
  owner_id: string;
  storage_path: string;
  original_name: string;
  content_type: string;
  size_bytes: string | number;
  expires_at: Date | string;
  signed_url_ttl_seconds: number;
}

function isCanonicalShareToken(token: string): boolean {
  if (!shareTokenPattern.test(token)) return false;
  const decoded = Buffer.from(token, "base64url");
  return decoded.length === shareTokenBytes && decoded.toString("base64url") === token;
}

function isOwnedStoragePath(ownerId: string, storagePath: string): boolean {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  return new RegExp(`^${uuid}/${uuid}$`, "i").test(storagePath) && storagePath.startsWith(`${ownerId}/`);
}

function getSafeDownloadFilename(filename: string): string {
  const normalized = [...filename.replaceAll("\\", "/").split("/").pop() ?? ""]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && (code < 127 || code > 159);
    })
    .join("")
    .replace(/[";]/g, "_")
    .trim();
  const safe = [...normalized].slice(0, 180).join("");
  return safe || "download";
}

function makeContentDisposition(filename: string): string {
  const asciiFallback = [...filename]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code <= 126 && character !== "\\" && character !== '"' ? character : "_";
    })
    .join("");
  const encodedName = encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`;
}

function unavailableShare(): ApiError {
  return new ApiError(404, "SHARE_UNAVAILABLE", "This share link is unavailable");
}

async function findAuthorizedShare(database: Pick<Pool, "query">, tokenHash: string): Promise<AuthorizedShare | undefined> {
  const result = await database.query(authorizedShareQuery, [
    tokenHash,
    signedUrlMaximumSeconds,
    signedUrlSafetyMarginSeconds,
  ]);
  const row = result.rows[0] as AuthorizedShare | undefined;
  if (
    !row
    || !isOwnedStoragePath(row.owner_id, row.storage_path)
    || !Number.isInteger(row.signed_url_ttl_seconds)
    || row.signed_url_ttl_seconds < 1
  ) return undefined;
  return row;
}

export function createShareDownloadRouter(dependencies: ShareDownloadDependencies) {
  const router = Router();
  router.use((_request, response, next) => {
    response.set({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });

  router.get("/:token", async (request, response, next) => {
    const token = request.params.token;
    if (!isCanonicalShareToken(token)) {
      next(unavailableShare());
      return;
    }
    try {
      const share = await findAuthorizedShare(dependencies.database, createHash("sha256").update(token).digest("hex"));
      if (!share) throw unavailableShare();
      response.json({
        filename: getSafeDownloadFilename(share.original_name),
        contentType: allowedDownloadTypes.has(share.content_type) ? share.content_type : "application/octet-stream",
        sizeBytes: Number(share.size_bytes),
        expiresAt: new Date(share.expires_at).toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:token/download", async (request, response, next) => {
    const token = request.params.token;
    if (!isCanonicalShareToken(token)) {
      next(unavailableShare());
      return;
    }

    const tokenHash = createHash("sha256").update(token).digest("hex");

    try {
      const authorizedShare = await findAuthorizedShare(dependencies.database, tokenHash);
      if (!authorizedShare) throw unavailableShare();

      const filename = getSafeDownloadFilename(authorizedShare.original_name);
      let signedUrl: string;
      try {
        const signed = await dependencies.storageBucket.createSignedUrl(
          authorizedShare.storage_path,
          authorizedShare.signed_url_ttl_seconds,
          { download: filename },
        );
        if (signed.error || !signed.data?.signedUrl) {
          throw new Error("Storage did not provide a signed download");
        }
        signedUrl = signed.data.signedUrl;
      } catch {
        throw new ApiError(502, "DOWNLOAD_UNAVAILABLE", "File could not be prepared for download");
      }

      const stillAuthorized = await findAuthorizedShare(dependencies.database, tokenHash);
      if (!stillAuthorized || stillAuthorized.signed_url_ttl_seconds < authorizedShare.signed_url_ttl_seconds) {
        throw unavailableShare();
      }

      if (request.aborted || response.destroyed) return;

      const abortController = new AbortController();
      const abortOnDisconnect = () => {
        if (!response.writableEnded) abortController.abort();
      };
      request.once("aborted", abortOnDisconnect);
      response.once("close", abortOnDisconnect);

      try {
        let storageResponse: Response;
        try {
          storageResponse = await fetch(signedUrl, { signal: abortController.signal, redirect: "error" });
        } catch {
          throw new ApiError(502, "DOWNLOAD_UNAVAILABLE", "File could not be prepared for download");
        }

        if (storageResponse.status === 404) {
          await storageResponse.body?.cancel().catch(() => undefined);
          throw unavailableShare();
        }
        if (!storageResponse.ok || !storageResponse.body) {
          await storageResponse.body?.cancel().catch(() => undefined);
          throw new ApiError(502, "DOWNLOAD_UNAVAILABLE", "File could not be prepared for download");
        }

        response.status(200);
        response.set({
          "Content-Type": allowedDownloadTypes.has(authorizedShare.content_type)
            ? authorizedShare.content_type
            : "application/octet-stream",
          "Content-Disposition": makeContentDisposition(filename),
        });
        await pipeline(Readable.from(storageResponse.body as AsyncIterable<Uint8Array>), response);
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        next(error);
      } finally {
        request.off("aborted", abortOnDisconnect);
        response.off("close", abortOnDisconnect);
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
}
