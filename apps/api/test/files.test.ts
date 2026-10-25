import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { SupabaseClients } from "../src/lib/supabase.js";

const ownerId = "8a4ac96c-7347-43b0-bdda-6247b65cdf9f";
const fileId = "3b898d67-c89b-407c-a922-f89d0afbb595";
const mebibyte = 1024 * 1024;
const configuredUploadLimit = 10 * mebibyte;
const fileRow = {
  id: fileId,
  original_name: "notes.pdf",
  content_type: "application/pdf",
  size_bytes: "10",
  created_at: "2026-10-01T00:00:00.000Z",
  expires_at: null,
};

interface TestOptions {
  maxUploadBytes?: number;
  selectedRows?: Record<string, unknown>[];
  uploadError?: Error;
  removeError?: Error;
  removeReject?: Error;
  insertError?: Error;
  deleteError?: Error;
}

function pdfBuffer(size = 16): Buffer {
  const contents = Buffer.alloc(size);
  Buffer.from("%PDF-1.7\n").copy(contents);
  return contents;
}

function makeApp(options: TestOptions = {}) {
  const database = {
    query: vi.fn(async (...args: [string, unknown[]?]) => {
      const [sql] = args;
      if (sql.startsWith("select storage_path")) {
        return { rows: options.selectedRows ?? [{ storage_path: `${ownerId}/stored-file` }], rowCount: 1 };
      }
      if (sql.startsWith("select id")) return { rows: [fileRow], rowCount: 1 };
      if (sql.startsWith("insert")) {
        if (options.insertError) throw options.insertError;
        return { rows: [fileRow], rowCount: 1 };
      }
      if (sql.startsWith("delete") && options.deleteError) throw options.deleteError;
      return { rows: [], rowCount: 1 };
    }),
  };
  const authClient = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: ownerId } }, error: null })),
    },
  } as unknown as SupabaseClients["auth"];
  const storageBucket = {
    upload: vi.fn(async () => ({ data: {}, error: options.uploadError ?? null })),
    remove: vi.fn(async () => {
      if (options.removeReject) throw options.removeReject;
      return { data: {}, error: options.removeError ?? null };
    }),
  } as unknown as SupabaseClients["privateBucket"];

  return {
    app: createApp({
      database: database as never,
      authClient,
      storageBucket,
      maxUploadBytes: options.maxUploadBytes ?? configuredUploadLimit,
    }),
    database,
    storageBucket,
  };
}

function expectNoInsert(database: ReturnType<typeof makeApp>["database"]) {
  expect(database.query.mock.calls.some(([sql]) => sql.startsWith("insert"))).toBe(false);
}

function expectGenericServerError(response: request.Response) {
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
}

afterEach(() => vi.restoreAllMocks());

describe("authenticated file routes", () => {
  it("stores uploads for the authenticated owner without exposing storage paths", async () => {
    const { app, database, storageBucket } = makeApp();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .field("owner_id", "99999999-9999-4999-8999-999999999999")
      .attach("file", pdfBuffer(), { filename: "notes.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(response.body.file.originalName).toBe("notes.pdf");
    expect(response.body.file).not.toHaveProperty("storage_path");
    expect(database.query.mock.calls.at(-1)?.[1]?.[0]).toBe(ownerId);
    expect(storageBucket.upload).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${ownerId}/`)), expect.any(Buffer), expect.objectContaining({ upsert: false }));
  });

  it("accepts a valid future expiration timestamp", async () => {
    const { app, database, storageBucket } = makeApp();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .field("expiresAt", expiresAt)
      .attach("file", pdfBuffer(), { filename: "notes.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(storageBucket.upload).toHaveBeenCalledOnce();
    expect(database.query.mock.calls.at(-1)?.[1]?.[5]).toBe(expiresAt);
  });

  it.each([
    ["past", new Date(Date.now() - 60 * 1000).toISOString()],
    ["invalid", "not-a-timestamp"],
  ])("rejects a %s expiration without storage or metadata writes", async (_case, expiresAt) => {
    const { app, database, storageBucket } = makeApp();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .field("expiresAt", expiresAt)
      .attach("file", pdfBuffer(), { filename: "notes.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(400);
    expect(storageBucket.upload).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it("lists rows scoped to the authenticated owner", async () => {
    const { app, database } = makeApp();
    const response = await request(app).get("/api/files").set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body.files[0].originalName).toBe("notes.pdf");
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("where owner_id = $1"), [ownerId]);
  });

  it("rejects an unsupported MIME type before storage or metadata writes", async () => {
    const { app, database, storageBucket } = makeApp();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", Buffer.from("<html></html>"), { filename: "page.html", contentType: "text/html" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("UNSUPPORTED_FILE_TYPE");
    expect(response.body.error.message).toContain("PDF, JPEG, PNG, WebP, and plain text");
    expect(storageBucket.upload).not.toHaveBeenCalled();
    expectNoInsert(database);
  });

  it("rejects a PDF whose bytes do not match its declared MIME type", async () => {
    const { app, database, storageBucket } = makeApp();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", Buffer.from("not a pdf"), { filename: "notes.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("UNSUPPORTED_FILE_TYPE");
    expect(storageBucket.upload).not.toHaveBeenCalled();
    expectNoInsert(database);
  });

  it("accepts valid UTF-8 plain text", async () => {
    const { app, database, storageBucket } = makeApp();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", Buffer.from("hello, DropVault\n", "utf8"), { filename: "notes.txt", contentType: "text/plain" });

    expect(response.status).toBe(201);
    expect(storageBucket.upload).toHaveBeenCalledOnce();
    expect(database.query.mock.calls.some(([sql]) => sql.startsWith("insert"))).toBe(true);
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0xff, 0xfe, 0xc3, 0x28])],
    ["disallowed control bytes", Buffer.from([0x61, 0x00, 0x62])],
  ])("rejects plain text with %s before storage or metadata writes", async (_case, contents) => {
    const { app, database, storageBucket } = makeApp();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", contents, { filename: "notes.txt", contentType: "text/plain" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("UNSUPPORTED_FILE_TYPE");
    expect(storageBucket.upload).not.toHaveBeenCalled();
    expectNoInsert(database);
  });

  it("accepts a 9 MiB file under the default 10 MiB limit", async () => {
    const { app, storageBucket } = makeApp();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", pdfBuffer(9 * mebibyte), { filename: "nine-mib.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(storageBucket.upload).toHaveBeenCalledOnce();
  });

  it("accepts a file exactly at the configured 10 MiB limit", async () => {
    const { app, storageBucket } = makeApp({ maxUploadBytes: configuredUploadLimit });
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", pdfBuffer(configuredUploadLimit), { filename: "limit.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(storageBucket.upload).toHaveBeenCalledOnce();
  });

  it("rejects a file one byte over the configured 10 MiB limit", async () => {
    const { app, database, storageBucket } = makeApp({ maxUploadBytes: configuredUploadLimit });
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", pdfBuffer(configuredUploadLimit + 1), { filename: "over-limit.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("FILE_TOO_LARGE");
    expect(storageBucket.upload).not.toHaveBeenCalled();
    expectNoInsert(database);
  });

  it("maps a Supabase upload failure to the existing storage error response", async () => {
    const { app, database, storageBucket } = makeApp({ uploadError: new Error("storage unavailable") });
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", pdfBuffer(), { filename: "notes.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("STORAGE_UPLOAD_FAILED");
    expect(database.query).not.toHaveBeenCalled();
    expect(storageBucket.remove).not.toHaveBeenCalled();
  });

  it("attempts storage cleanup and does not report success when metadata insertion fails", async () => {
    const { app, storageBucket } = makeApp({ insertError: Object.assign(new Error("insert failed"), { code: "23505" }) });
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", pdfBuffer(), { filename: "notes.pdf", contentType: "application/pdf" });

    expectGenericServerError(response);
    expect(storageBucket.upload).toHaveBeenCalledOnce();
    expect(storageBucket.remove).toHaveBeenCalledWith([expect.stringMatching(new RegExp(`^${ownerId}/`))]);
  });

  it.each([
    ["an error response", { removeError: new Error("cleanup failed: Bearer cleanup-secret-token; postgres://db-user:db-password@db.example/files") }],
    ["a rejected cleanup request", { removeReject: new Error("cleanup request failed: Bearer cleanup-secret-token; postgres://db-user:db-password@db.example/files") }],
  ])("logs %s safely while preserving the metadata failure response", async (_case, cleanupFailure) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, storageBucket } = makeApp({
      insertError: Object.assign(new Error("insert failed"), { code: "23505" }),
      ...cleanupFailure,
    });
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", pdfBuffer(), { filename: "notes.pdf", contentType: "application/pdf" });

    expectGenericServerError(response);
    expect(storageBucket.remove).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("[api] Storage cleanup after failed upload failed", expect.objectContaining({ message: expect.stringContaining("cleanup") }));
    const diagnosticOutput = JSON.stringify(log.mock.calls);
    expect(diagnosticOutput).not.toContain("cleanup-secret-token");
    expect(diagnosticOutput).not.toContain("db-password");
  });

  it("does not remove another owner's file", async () => {
    const { app, database, storageBucket } = makeApp({ selectedRows: [] });
    const response = await request(app)
      .delete(`/api/files/${fileId}`)
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(404);
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("owner_id = $2"), [fileId, ownerId]);
    expect(storageBucket.remove).not.toHaveBeenCalled();
  });

  it("does not delete metadata if private storage deletion fails", async () => {
    const { app, database, storageBucket } = makeApp({ removeError: new Error("storage deletion failed") });
    const response = await request(app)
      .delete(`/api/files/${fileId}`)
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("STORAGE_DELETE_FAILED");
    expect(storageBucket.remove).toHaveBeenCalledWith([`${ownerId}/stored-file`]);
    expect(database.query.mock.calls.some(([sql]) => sql.startsWith("delete"))).toBe(false);
  });

  it("returns a generic error if metadata deletion fails after the storage object is removed", async () => {
    const { app, database, storageBucket } = makeApp({ deleteError: Object.assign(new Error("delete failed"), { code: "40001" }) });
    const response = await request(app)
      .delete(`/api/files/${fileId}`)
      .set("Authorization", "Bearer valid-token");

    expectGenericServerError(response);
    expect(storageBucket.remove).toHaveBeenCalledWith([`${ownerId}/stored-file`]);
    expect(database.query).toHaveBeenLastCalledWith(expect.stringContaining("delete from public.files"), [fileId, ownerId]);
  });

  it("deletes an owned file from private storage and metadata", async () => {
    const { app, database, storageBucket } = makeApp();
    const response = await request(app)
      .delete(`/api/files/${fileId}`)
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(204);
    expect(storageBucket.remove).toHaveBeenCalledWith([`${ownerId}/stored-file`]);
    expect(database.query).toHaveBeenLastCalledWith(expect.stringContaining("delete from public.files"), [fileId, ownerId]);
  });
});
