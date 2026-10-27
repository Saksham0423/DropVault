import { createHash, randomBytes, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { Router } from "express";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { AppDependencies } from "../app.js";
import { ApiError, logInternalError } from "../middleware/error-handler.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validateRequest } from "../middleware/validate-request.js";

const allowedBinaryTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const maxExpirationMilliseconds = 7 * 24 * 60 * 60 * 1000;
const uploadSchema = z
  .object({ expiresAt: z.string().datetime().optional() })
  .strict()
  .refine((value) => !value.expiresAt || new Date(value.expiresAt).getTime() > Date.now(), {
    path: ["expiresAt"],
    message: "Expiration must be in the future",
  })
  .refine((value) => !value.expiresAt || new Date(value.expiresAt).getTime() <= Date.now() + maxExpirationMilliseconds, {
    path: ["expiresAt"],
    message: "Expiration cannot be more than 7 days away",
  });
const idSchema = z.object({ id: z.string().uuid() });
const shareLinkCreateSchema = z.object({ expiresAt: z.string().datetime() }).strict();
const shareLinkRouteSchema = z.object({ id: z.string().uuid(), linkId: z.string().uuid() }).strict();
const shareLinkListLimit = 100;
const shareTokenAttempts = 3;

interface FileRouteDependencies {
  database: NonNullable<AppDependencies["database"]>;
  authClient: NonNullable<AppDependencies["authClient"]>;
  storageBucket: NonNullable<AppDependencies["storageBucket"]>;
  maxUploadBytes: number;
}

function getSafeFilename(filename: string): string {
  const safe = [...filename.replaceAll("\\", "/").split("/").pop() ?? ""]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("")
    .trim();
  if (!safe || safe.length > 255) {
    throw new ApiError(400, "INVALID_FILENAME", "Filename is invalid or too long");
  }
  return safe;
}

async function validateFileContent(buffer: Buffer, reportedType: string): Promise<void> {
  if (reportedType === "text/plain") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      if ([...text].some((character) => {
        const code = character.charCodeAt(0);
        return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
      })) throw new Error("Binary content");
      return;
    } catch {
      throw new ApiError(400, "UNSUPPORTED_FILE_TYPE", "File content does not match an allowed type");
    }
  }

  if (!allowedBinaryTypes.has(reportedType)) {
    throw new ApiError(400, "UNSUPPORTED_FILE_TYPE", "Allowed file types are PDF, JPEG, PNG, WebP, and plain text");
  }

  const detected = await fileTypeFromBuffer(buffer);
  if (detected?.mime !== reportedType) {
    throw new ApiError(400, "UNSUPPORTED_FILE_TYPE", "File content does not match its declared type");
  }
}

function toFileResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    originalName: row.original_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function toIsoTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("Database returned an invalid timestamp");
  return date.toISOString();
}

function rollbackTransaction(client: PoolClient): Promise<void> {
  return client.query("ROLLBACK").then(() => undefined);
}

export function createFilesRouter(dependencies: FileRouteDependencies) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: dependencies.maxUploadBytes, files: 1, fields: 1 },
  });

  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  router.use(requireAuth(dependencies.authClient));

  router.get("/", async (request, response, next) => {
    try {
      const result = await dependencies.database.query(
        `select id, original_name, content_type, size_bytes, created_at,
           least(coalesce(expires_at, created_at + interval '7 days'), created_at + interval '7 days') as expires_at
         from public.files where owner_id = $1 order by created_at desc`,
        [request.user!.id],
      );
      response.json({ files: result.rows.map(toFileResponse) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/share-links", validateRequest(z.object({ params: idSchema, body: shareLinkCreateSchema })), async (request, response, next) => {
    const { id } = (request.validated as { params: z.infer<typeof idSchema> }).params;
    const { expiresAt } = (request.validated as { body: z.infer<typeof shareLinkCreateSchema> }).body;
    let client: PoolClient | undefined;
    let transactionStarted = false;
    const generatedSecrets: string[] = [];

    try {
      client = await dependencies.database.connect();
      await client.query("BEGIN");
      transactionStarted = true;

      const file = await client.query(
        "select id from public.files where id = $1 and owner_id = $2 for update",
        [id, request.user!.id],
      );
      if (!file.rows[0]) throw new ApiError(404, "FILE_NOT_FOUND", "File not found");

      const expirationCheck = await client.query(
        `select
           least(coalesce(expires_at, created_at + interval '7 days'), created_at + interval '7 days') <= clock_timestamp() as file_expired,
           $2::timestamptz <= clock_timestamp() as link_expired,
           $2::timestamptz > least(coalesce(expires_at, created_at + interval '7 days'), created_at + interval '7 days') as exceeds_file_expiration,
           $2::timestamptz > clock_timestamp() + interval '7 days' as exceeds_max_lifetime
         from public.files
         where id = $1 and owner_id = $3`,
        [id, expiresAt, request.user!.id],
      );
      const expiration = expirationCheck.rows[0] as {
        file_expired: boolean;
        link_expired: boolean;
        exceeds_file_expiration: boolean;
        exceeds_max_lifetime: boolean;
      };
      if (expiration.file_expired) throw new ApiError(409, "FILE_EXPIRED", "Expired files cannot receive new share links");
      if (expiration.link_expired) throw new ApiError(400, "INVALID_EXPIRATION", "Share link expiration must be in the future");
      if (expiration.exceeds_max_lifetime) throw new ApiError(400, "INVALID_EXPIRATION", "Share links cannot last more than 7 days");
      if (expiration.exceeds_file_expiration) {
        throw new ApiError(400, "INVALID_EXPIRATION", "Share link expiration cannot exceed file expiration");
      }

      let createdLink: { id: string; created_at: Date | string; expires_at: Date | string } | undefined;
      let rawToken: string | undefined;
      for (let attempt = 0; attempt < shareTokenAttempts; attempt += 1) {
        rawToken = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");
        generatedSecrets.push(rawToken, tokenHash);
        const inserted = await client.query(
          `insert into public.share_links (file_id, token_hash, expires_at)
           values ($1, $2, $3)
           on conflict (token_hash) do nothing
           returning id, created_at, expires_at`,
          [id, tokenHash, expiresAt],
        );
        if (inserted.rows[0]) {
          createdLink = inserted.rows[0] as typeof createdLink;
          break;
        }
      }

      if (!createdLink || !rawToken) {
        throw new ApiError(503, "SHARE_LINK_CREATE_FAILED", "Share link could not be created");
      }

      const finalExpirationCheck = await client.query(
        `select
           share_link.expires_at > clock_timestamp() as link_not_expired,
           least(coalesce(file.expires_at, file.created_at + interval '7 days'), file.created_at + interval '7 days') > clock_timestamp() as file_not_expired,
           share_link.expires_at <= share_link.created_at + interval '7 days' as within_max_lifetime
         from public.share_links as share_link
         join public.files as file on file.id = share_link.file_id
         where share_link.id = $1 and file.owner_id = $2`,
        [createdLink.id, request.user!.id],
      );
      const finalExpiration = finalExpirationCheck.rows[0] as { link_not_expired: boolean; file_not_expired: boolean; within_max_lifetime: boolean };
      if (!finalExpiration.file_not_expired) throw new ApiError(409, "FILE_EXPIRED", "Expired files cannot receive new share links");
      if (!finalExpiration.within_max_lifetime) throw new ApiError(400, "INVALID_EXPIRATION", "Share links cannot last more than 7 days");
      if (!finalExpiration.link_not_expired) {
        throw new ApiError(400, "INVALID_EXPIRATION", "Share link expiration must be in the future");
      }

      await client.query("COMMIT");
      transactionStarted = false;
      response.status(201).json({
        link: {
          id: createdLink.id,
          token: rawToken,
          createdAt: toIsoTimestamp(createdLink.created_at),
          expiresAt: toIsoTimestamp(createdLink.expires_at),
        },
      });
    } catch (error) {
      if (error instanceof Error) {
        for (const secret of generatedSecrets) error.message = error.message.split(secret).join("[REDACTED]");
      }
      if (client && transactionStarted) {
        try {
          await rollbackTransaction(client);
        } catch (rollbackError) {
          logInternalError("Share link transaction rollback failed", rollbackError);
        }
      }
      next(error);
    } finally {
      client?.release();
    }
  });

  router.get("/:id/share-links", validateRequest(z.object({ params: idSchema })), async (request, response, next) => {
    try {
      const { id } = (request.validated as { params: z.infer<typeof idSchema> }).params;
      const ownerId = request.user!.id;
      const file = await dependencies.database.query(
        "select id from public.files where id = $1 and owner_id = $2",
        [id, ownerId],
      );
      if (!file.rows[0]) throw new ApiError(404, "FILE_NOT_FOUND", "File not found");

      const result = await dependencies.database.query(
        `select share_link.id, share_link.created_at, share_link.expires_at, share_link.revoked_at,
           case
             when share_link.revoked_at is not null then 'revoked'
             when least(share_link.expires_at, coalesce(file.expires_at, file.created_at + interval '7 days'), file.created_at + interval '7 days') <= statement_timestamp() then 'expired'
             else 'active'
           end as status
         from public.share_links as share_link
         join public.files as file on file.id = share_link.file_id
         where share_link.file_id = $1
         order by share_link.created_at desc, share_link.id desc
         limit $2`,
        [id, shareLinkListLimit + 1],
      );
      const rows = result.rows as Array<{
        id: string;
        created_at: Date | string;
        expires_at: Date | string;
        revoked_at: Date | string | null;
        status: "active" | "expired" | "revoked";
      }>;
      response.json({
        links: rows.slice(0, shareLinkListLimit).map((row) => ({
          id: row.id,
          createdAt: toIsoTimestamp(row.created_at),
          expiresAt: toIsoTimestamp(row.expires_at),
          revokedAt: row.revoked_at === null ? null : toIsoTimestamp(row.revoked_at),
          status: row.status,
        })),
        hasMore: rows.length > shareLinkListLimit,
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id/share-links/:linkId", validateRequest(z.object({ params: shareLinkRouteSchema })), async (request, response, next) => {
    try {
      const { id, linkId } = (request.validated as { params: z.infer<typeof shareLinkRouteSchema> }).params;
      const result = await dependencies.database.query(
        `update public.share_links as share_link
         set revoked_at = coalesce(share_link.revoked_at, clock_timestamp())
         from public.files as file
         where share_link.id = $1
           and share_link.file_id = $2
           and file.id = share_link.file_id
           and file.owner_id = $3
         returning share_link.id`,
        [linkId, id, request.user!.id],
      );
      if (!result.rows[0]) throw new ApiError(404, "SHARE_LINK_NOT_FOUND", "Share link not found");
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/", upload.single("file"), validateRequest(z.object({ body: uploadSchema })), async (request, response, next) => {
    try {
      const file = request.file;
      if (!file) throw new ApiError(400, "FILE_REQUIRED", "Choose a file to upload");
      await validateFileContent(file.buffer, file.mimetype);

      const ownerId = request.user!.id;
      const storagePath = `${ownerId}/${randomUUID()}`;
      const originalName = getSafeFilename(file.originalname);
      const expiresAt = (request.validated as { body: z.infer<typeof uploadSchema> }).body.expiresAt
        ?? new Date(Date.now() + maxExpirationMilliseconds).toISOString();
      const uploadResult = await dependencies.storageBucket.upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });
      if (uploadResult.error) throw new ApiError(502, "STORAGE_UPLOAD_FAILED", "File could not be stored");

      try {
        const result = await dependencies.database.query(
          "insert into public.files (owner_id, storage_path, original_name, content_type, size_bytes, expires_at) values ($1, $2, $3, $4, $5, $6) returning id, original_name, content_type, size_bytes, created_at, expires_at",
          [ownerId, storagePath, originalName, file.mimetype, file.size, expiresAt],
        );
        response.status(201).json({ file: toFileResponse(result.rows[0]) });
      } catch (error) {
        try {
          const cleanup = await dependencies.storageBucket.remove([storagePath]);
          if (cleanup.error) logInternalError("Storage cleanup after failed upload failed", cleanup.error);
        } catch (cleanupError) {
          logInternalError("Storage cleanup after failed upload failed", cleanupError);
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", validateRequest(z.object({ params: idSchema })), async (request, response, next) => {
    try {
      const { id } = (request.validated as { params: z.infer<typeof idSchema> }).params;
      const ownerId = request.user!.id;
      const selected = await dependencies.database.query(
        "select storage_path from public.files where id = $1 and owner_id = $2",
        [id, ownerId],
      );
      if (!selected.rows[0]) throw new ApiError(404, "FILE_NOT_FOUND", "File not found");

      const storagePath = String(selected.rows[0].storage_path);
      const removal = await dependencies.storageBucket.remove([storagePath]);
      if (removal.error) throw new ApiError(502, "STORAGE_DELETE_FAILED", "File could not be deleted from storage");

      await dependencies.database.query("delete from public.files where id = $1 and owner_id = $2", [id, ownerId]);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
