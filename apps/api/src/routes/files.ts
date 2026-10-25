import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { Router } from "express";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import type { AppDependencies } from "../app.js";
import { ApiError, logInternalError } from "../middleware/error-handler.js";
import { requireAuth } from "../middleware/require-auth.js";
import { validateRequest } from "../middleware/validate-request.js";

const allowedBinaryTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const uploadSchema = z.object({
  expiresAt: z.string().datetime().optional(),
}).refine((value) => !value.expiresAt || new Date(value.expiresAt).getTime() > Date.now(), {
  path: ["expiresAt"],
  message: "Expiration must be in the future",
});
const idSchema = z.object({ id: z.string().uuid() });

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

export function createFilesRouter(dependencies: FileRouteDependencies) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: dependencies.maxUploadBytes, files: 1, fields: 1 },
  });

  router.use(requireAuth(dependencies.authClient));

  router.get("/", async (request, response, next) => {
    try {
      const result = await dependencies.database.query(
        "select id, original_name, content_type, size_bytes, created_at, expires_at from public.files where owner_id = $1 order by created_at desc",
        [request.user!.id],
      );
      response.json({ files: result.rows.map(toFileResponse) });
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
      const expiresAt = (request.validated as { body: z.infer<typeof uploadSchema> }).body.expiresAt ?? null;
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
