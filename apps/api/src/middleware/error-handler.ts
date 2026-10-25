import type { ErrorRequestHandler, RequestHandler } from "express";
import { MulterError } from "multer";
import { ZodError } from "zod";

export const notFoundHandler: RequestHandler = (_request, response) => {
  response.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
};

function getInternalErrorDetails(error: unknown) {
  if (!(error instanceof Error)) {
    return { name: "Error", message: "A non-Error value was thrown" };
  }

  const errorWithCode = error as Error & { code?: unknown };
  const message = error.message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, "[REDACTED_TOKEN]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/((?:password|secret|access[_-]?token|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 1000);
  const code = errorWithCode.code;

  return {
    name: error.name.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80) || "Error",
    message,
    ...(typeof code === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(code) ? { code } : {}),
  };
}

export const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof MulterError && error.code === "LIMIT_FILE_SIZE") {
    response.status(413).json({ error: { code: "FILE_TOO_LARGE", message: "File exceeds the upload size limit" } });
    return;
  }

  if (error instanceof ApiError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.issues.map(({ path, message }) => ({ path, message })),
      },
    });
    return;
  }

  console.error("[api] Unhandled request error", getInternalErrorDetails(error));
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
};

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}
