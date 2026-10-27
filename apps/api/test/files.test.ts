import { createHash } from "node:crypto";
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
  created_at: new Date().toISOString(),
  expires_at: null,
};
const recipientToken = Buffer.alloc(32, 0x5a).toString("base64url");
const recipientTokenHash = createHash("sha256").update(recipientToken).digest("hex");
const authorizedShareDownload = {
  owner_id: ownerId,
  storage_path: `${ownerId}/00000000-0000-4000-8000-000000000001`,
  original_name: "notes.txt",
  content_type: "text/plain",
  size_bytes: "13",
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  signed_url_ttl_seconds: 25,
};

interface TestOptions {
  authUserId?: string;
  fileExpiresAt?: Date | string | null;
  expireBeforeCommit?: "file" | "link";
  shareLinks?: ShareLinkRow[];
  shareInsertError?: Error | ((tokenHash: string) => Error);
  shareLinkConflicts?: number;
  revokeError?: Error;
  shareDownloadRows?: Array<Record<string, unknown> | null>;
  shareDownloadError?: Error;
  signedUrlError?: Error;
  signedUrlReject?: Error;
  maxUploadBytes?: number;
  selectedRows?: Record<string, unknown>[];
  uploadError?: Error;
  removeError?: Error;
  removeReject?: Error;
  insertError?: Error;
  deleteError?: Error;
}

interface ShareLinkRow {
  id: string;
  token_hash: string;
  created_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
}

function pdfBuffer(size = 16): Buffer {
  const contents = Buffer.alloc(size);
  Buffer.from("%PDF-1.7\n").copy(contents);
  return contents;
}

function makeApp(options: TestOptions = {}) {
  const authenticatedUserId = options.authUserId ?? ownerId;
  const shareLinks = options.shareLinks ?? [];
  let remainingShareLinkConflicts = options.shareLinkConflicts ?? 0;
  let shareDownloadQueryCount = 0;
  const database = {
    query: vi.fn(async (...args: [string, unknown[]?]) => {
      const [sql, params] = args;
      if (sql.toLowerCase().includes("with authorization_time as materialized")) {
        if (options.shareDownloadError) throw options.shareDownloadError;
        const row = options.shareDownloadRows?.[shareDownloadQueryCount] ?? null;
        shareDownloadQueryCount += 1;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.startsWith("select storage_path")) {
        const rows = options.selectedRows ?? (params?.[1] === ownerId ? [{ storage_path: `${ownerId}/stored-file` }] : []);
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("select id, original_name")) {
        const rows = params?.[0] === ownerId ? [fileRow] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("select id from public.files")) {
        const rows = params?.[0] === fileId && params?.[1] === ownerId ? [{ id: fileId }] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("select share_link.id, share_link.created_at,")) {
        const rows = shareLinks
          .filter(() => params?.[0] === fileId)
          .slice(0, Number(params?.[1]))
          .map((link) => ({
            id: link.id,
            created_at: link.created_at,
            expires_at: link.expires_at,
            revoked_at: link.revoked_at,
            status: link.revoked_at !== null
              ? "revoked"
              : new Date(link.expires_at).getTime() <= Date.now() ? "expired" : "active",
          }));
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("update public.share_links as share_link")) {
        if (options.revokeError) throw options.revokeError;
        const link = shareLinks.find((item) => item.id === params?.[0]);
        if (!link || params?.[1] !== fileId || params?.[2] !== ownerId) return { rows: [], rowCount: 0 };
        link.revoked_at ??= new Date();
        return { rows: [{ id: link.id }], rowCount: 1 };
      }
      if (sql.startsWith("insert")) {
        if (options.insertError) throw options.insertError;
        return { rows: [fileRow], rowCount: 1 };
      }
      if (sql.startsWith("delete") && options.deleteError) throw options.deleteError;
      return { rows: [], rowCount: 1 };
    }),
  };
  const transactionClient = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const normalizedSql = sql.trim().toLowerCase();
      if (["begin", "commit", "rollback"].includes(normalizedSql)) return { rows: [], rowCount: 0 };
      if (normalizedSql.startsWith("select id from public.files") && normalizedSql.includes("for update")) {
        const rows = params[0] === fileId && params[1] === ownerId ? [{ id: fileId }] : [];
        return { rows, rowCount: rows.length };
      }
      if (normalizedSql.startsWith("select") && normalizedSql.includes("file_expired")) {
        const configuredExpiry = options.fileExpiresAt == null ? null : new Date(options.fileExpiresAt);
        const fileMaximum = new Date(new Date(fileRow.created_at).getTime() + 7 * 24 * 60 * 60 * 1000);
        const effectiveFileExpiration = configuredExpiry && configuredExpiry < fileMaximum ? configuredExpiry : fileMaximum;
        const rows = params[0] === fileId && params[1] === ownerId
          ? [{
            expires_at: effectiveFileExpiration,
            file_expired: effectiveFileExpiration.getTime() <= Date.now(),
          }]
          : [];
        return { rows, rowCount: rows.length };
      }
      if (normalizedSql.startsWith("insert into public.share_links")) {
        if (options.shareInsertError) {
          throw typeof options.shareInsertError === "function"
            ? options.shareInsertError(String(params[1]))
            : options.shareInsertError;
        }
        if (remainingShareLinkConflicts > 0) {
          remainingShareLinkConflicts -= 1;
          return { rows: [], rowCount: 0 };
        }
        const row: ShareLinkRow = {
          id: `00000000-0000-4000-8000-${String(shareLinks.length + 1).padStart(12, "0")}`,
          token_hash: String(params[1]),
          created_at: new Date(),
          expires_at: options.fileExpiresAt ?? new Date(new Date(fileRow.created_at).getTime() + 7 * 24 * 60 * 60 * 1000),
          revoked_at: null,
        };
        shareLinks.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (normalizedSql.startsWith("select") && normalizedSql.includes("link_not_expired")) {
        const link = shareLinks.find((item) => item.id === params[0]);
        const fileExpiresAt = options.fileExpiresAt == null ? null : new Date(options.fileExpiresAt);
        const now = Date.now();
        return {
          rows: link ? [{
            link_not_expired: options.expireBeforeCommit !== "link" && new Date(link.expires_at).getTime() > now,
            file_not_expired: options.expireBeforeCommit !== "file" && (fileExpiresAt === null || fileExpiresAt.getTime() > now),
            within_max_lifetime: new Date(link.expires_at).getTime() <= new Date(link.created_at).getTime() + 7 * 24 * 60 * 60 * 1000,
            matches_file_expiration: true,
          }] : [],
          rowCount: link ? 1 : 0,
        };
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    }),
    release: vi.fn(),
  };
  const authClient = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: authenticatedUserId } }, error: null })),
    },
  } as unknown as SupabaseClients["auth"];
  const storageBucket = {
    upload: vi.fn(async () => ({ data: {}, error: options.uploadError ?? null })),
    createSignedUrl: vi.fn(async () => {
      if (options.signedUrlReject) throw options.signedUrlReject;
      if (options.signedUrlError) return { data: null, error: options.signedUrlError };
      return { data: { signedUrl: "https://storage.example.test/signed/object?token=storage-only-token" }, error: null };
    }),
    remove: vi.fn(async () => {
      if (options.removeReject) throw options.removeReject;
      return { data: {}, error: options.removeError ?? null };
    }),
  } as unknown as SupabaseClients["privateBucket"];
  const databaseWithConnection = Object.assign(database, { connect: vi.fn(async () => transactionClient) });

  return {
    app: createApp({
      database: databaseWithConnection as never,
      authClient,
      storageBucket,
      maxUploadBytes: options.maxUploadBytes ?? configuredUploadLimit,
    }),
    database: databaseWithConnection,
    transactionClient,
    storageBucket,
    shareLinks,
  };
}

function expectNoInsert(database: ReturnType<typeof makeApp>["database"]) {
  expect(database.query.mock.calls.some(([sql]) => sql.startsWith("insert"))).toBe(false);
}

function expectGenericServerError(response: request.Response) {
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
}

function makeShareLink(index: number, options: { expiresAt?: Date | string; revokedAt?: Date | string | null } = {}): ShareLinkRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    token_hash: `stored-hash-${index}`,
    created_at: new Date(Date.now() - 60 * 1000),
    expires_at: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    revoked_at: options.revokedAt ?? null,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("authenticated file routes", () => {
  it("stores uploads for the authenticated owner without exposing storage paths", async () => {
    const { app, database, storageBucket } = makeApp();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", pdfBuffer(), { filename: "notes.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(response.body.file.originalName).toBe("notes.pdf");
    expect(response.body.file).not.toHaveProperty("storage_path");
    expect(database.query.mock.calls.at(-1)?.[1]?.[0]).toBe(ownerId);
    expect(storageBucket.upload).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${ownerId}/`)), expect.any(Buffer), expect.objectContaining({ upsert: false }));
    const savedExpiry = new Date(String(database.query.mock.calls.at(-1)?.[1]?.[5])).getTime();
    expect(savedExpiry).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(savedExpiry).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60 * 1000);
  });

  it("rejects client-supplied ownership fields before storage or database writes", async () => {
    const { app, database, storageBucket } = makeApp();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .field("owner_id", "99999999-9999-4999-8999-999999999999")
      .attach("file", pdfBuffer(), { filename: "notes.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(400);
    expect(storageBucket.upload).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
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
    ["more than seven days", new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString()],
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
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("where owner_id = $1"), [ownerId]);
  });

  it("lists no files belonging to another authenticated user", async () => {
    const secondUserId = "2d7c67d8-7ab2-4c91-9f89-4a3638bc253f";
    const { app, database } = makeApp({ authUserId: secondUserId });
    const response = await request(app).get("/api/files").set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body.files).toEqual([]);
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("where owner_id = $1"), [secondUserId]);
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
    const secondUserId = "2d7c67d8-7ab2-4c91-9f89-4a3638bc253f";
    const { app, database, storageBucket } = makeApp({ authUserId: secondUserId });
    const response = await request(app)
      .delete(`/api/files/${fileId}`)
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(404);
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("owner_id = $2"), [fileId, secondUserId]);
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

describe("authenticated share-link routes", () => {
  const createPath = `/api/files/${fileId}/share-links`;

  it("creates a no-store link, returns its raw token once, and persists only its SHA-256 hash", async () => {
    const { app, transactionClient, shareLinks } = makeApp();
    const response = await request(app)
      .post(createPath)
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(response.body.link).sort()).toEqual(["createdAt", "expiresAt", "id", "token"]);
    expect(response.body.link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.body.link.expiresAt).toBe(new Date(shareLinks[0].expires_at).toISOString());
    expect(shareLinks).toHaveLength(1);
    expect(shareLinks[0].token_hash).toBe(createHash("sha256").update(response.body.link.token).digest("hex"));
    expect(response.body).not.toHaveProperty("link.token_hash");

    const queries = transactionClient.query.mock.calls.map(([sql]) => sql.trim().toLowerCase());
    expect(queries[0]).toBe("begin");
    expect(queries[1]).toContain("for update");
    expect(queries[2]).toContain("clock_timestamp()");
    expect(queries[3]).toContain("on conflict (token_hash) do nothing");
    expect(queries[3]).toContain("least(coalesce(file.expires_at");
    expect(queries[4]).toContain("link_not_expired");
    expect(queries.at(-1)).toBe("commit");
  });

  it("allows multiple active links for one non-expiring file", async () => {
    const { app, shareLinks } = makeApp();
    const first = await request(app).post(createPath).set("Authorization", "Bearer valid-token").send({});
    const second = await request(app).post(createPath).set("Authorization", "Bearer valid-token").send({});

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.link.token).not.toBe(second.body.link.token);
    expect(shareLinks).toHaveLength(2);
  });

  it("derives the link expiration from the associated file expiration", async () => {
    const fileExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { app } = makeApp({ fileExpiresAt });
    const response = await request(app)
      .post(createPath)
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(201);
    expect(response.body.link.expiresAt).toBe(new Date(fileExpiresAt).toISOString());
  });

  it("retries token-hash collisions with a new token", async () => {
    const { app, shareLinks, transactionClient } = makeApp({ shareLinkConflicts: 1 });
    const response = await request(app)
      .post(createPath)
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(201);
    expect(transactionClient.query.mock.calls.filter(([sql]) => sql.toLowerCase().includes("insert into public.share_links"))).toHaveLength(2);
    expect(shareLinks[0].token_hash).toBe(createHash("sha256").update(response.body.link.token).digest("hex"));
  });

  it("bounds token-collision retries and rolls back if no unique token is available", async () => {
    const { app, transactionClient } = makeApp({ shareLinkConflicts: 3 });
    const response = await request(app)
      .post(createPath)
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("SHARE_LINK_CREATE_FAILED");
    expect(transactionClient.query.mock.calls.filter(([sql]) => sql.toLowerCase().includes("insert into public.share_links"))).toHaveLength(3);
    expect(transactionClient.query).toHaveBeenCalledWith("ROLLBACK");
    expect(response.body).not.toHaveProperty("link.token");
  });

  it("rejects a separately supplied expiration instead of accepting a second setting", async () => {
    const { app, transactionClient } = makeApp();
    const response = await request(app)
      .post(createPath)
      .set("Authorization", "Bearer valid-token")
      .send({ expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });

    expect(response.status).toBe(400);
    expect(transactionClient.query).not.toHaveBeenCalled();
  });

  it("rejects a link for a file that has already expired", async () => {
    const { app, transactionClient } = makeApp({ fileExpiresAt: new Date(Date.now() - 60 * 1000) });
    const response = await request(app)
      .post(createPath)
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("FILE_EXPIRED");
    expect(transactionClient.query.mock.calls.some(([sql]) => sql.toLowerCase().includes("insert into public.share_links"))).toBe(false);
  });

  it("rolls back if the file or derived share expires during creation", async () => {
    for (const expireBeforeCommit of ["file", "link"] as const) {
      const { app, transactionClient } = makeApp({ expireBeforeCommit });
      const response = await request(app)
        .post(createPath)
        .set("Authorization", "Bearer valid-token")
        .send({});

      expect(response.status).toBe(expireBeforeCommit === "file" ? 409 : 400);
      expect(transactionClient.query).toHaveBeenCalledWith("ROLLBACK");
      expect(transactionClient.query).not.toHaveBeenCalledWith("COMMIT");
    }
  });

  it("does not create a link for another owner's file", async () => {
    const secondUserId = "2d7c67d8-7ab2-4c91-9f89-4a3638bc253f";
    const { app, transactionClient } = makeApp({ authUserId: secondUserId });
    const response = await request(app)
      .post(createPath)
      .set("Authorization", "Bearer valid-token")
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("FILE_NOT_FOUND");
    expect(transactionClient.query.mock.calls.some(([sql]) => sql.toLowerCase().includes("insert into public.share_links"))).toBe(false);
  });

  it("rejects unauthenticated create, list, and revoke requests before database access", async () => {
    const { app, database } = makeApp();
    const linkId = makeShareLink(1).id;
    const responses = await Promise.all([
      request(app).post(createPath).send({}),
      request(app).get(createPath),
      request(app).delete(`${createPath}/${linkId}`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    expect(database.connect).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it("lists links without hashes and derives active, expired, and revoked statuses", async () => {
    const links = [
      makeShareLink(1),
      makeShareLink(2, { expiresAt: new Date(Date.now() - 1000) }),
      makeShareLink(3, { revokedAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60 * 1000) }),
    ];
    const { app } = makeApp({ shareLinks: links });
    const response = await request(app).get(createPath).set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.links.map((link: { status: string }) => link.status)).toEqual(["active", "expired", "revoked"]);
    expect(response.body.links[0]).toEqual(expect.objectContaining({ id: links[0].id, revokedAt: null }));
    expect(response.body.links[0]).not.toHaveProperty("token_hash");
    expect(JSON.stringify(response.body)).not.toContain("stored-hash");
    expect(response.body.hasMore).toBe(false);
  });

  it("rejects malformed file and link IDs before database access", async () => {
    const { app, database } = makeApp();
    const badFileId = await request(app)
      .get("/api/files/not-a-uuid/share-links")
      .set("Authorization", "Bearer valid-token");
    const badLinkId = await request(app)
      .delete(`/api/files/${fileId}/share-links/not-a-uuid`)
      .set("Authorization", "Bearer valid-token");

    expect(badFileId.status).toBe(400);
    expect(badLinkId.status).toBe(400);
    expect(database.query).not.toHaveBeenCalled();
  });

  it("bounds link listings to 100 and reports whether more exist", async () => {
    const links = Array.from({ length: 101 }, (_, index) => makeShareLink(index + 1));
    const { app } = makeApp({ shareLinks: links });
    const response = await request(app).get(createPath).set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body.links).toHaveLength(100);
    expect(response.body.hasMore).toBe(true);
  });

  it("allows a second user to see no links and not revoke another owner's link", async () => {
    const secondUserId = "2d7c67d8-7ab2-4c91-9f89-4a3638bc253f";
    const links = [makeShareLink(1)];
    const { app, database } = makeApp({ authUserId: secondUserId, shareLinks: links });
    const list = await request(app).get(createPath).set("Authorization", "Bearer valid-token");
    const revoke = await request(app)
      .delete(`${createPath}/${links[0].id}`)
      .set("Authorization", "Bearer valid-token");

    expect(list.status).toBe(404);
    expect(list.body.error.code).toBe("FILE_NOT_FOUND");
    expect(revoke.status).toBe(404);
    expect(revoke.body.error.code).toBe("SHARE_LINK_NOT_FOUND");
    expect(links[0].revoked_at).toBeNull();
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("file.owner_id = $3"), [links[0].id, fileId, secondUserId]);
  });

  it("revokes only the specified link and makes repeated revocation idempotent", async () => {
    const links = [makeShareLink(1), makeShareLink(2)];
    const { app } = makeApp({ shareLinks: links });
    const revokeUrl = `${createPath}/${links[0].id}`;
    const first = await request(app).delete(revokeUrl).set("Authorization", "Bearer valid-token");
    const revokedAt = links[0].revoked_at;
    const repeated = await request(app).delete(revokeUrl).set("Authorization", "Bearer valid-token");

    expect(first.status).toBe(204);
    expect(repeated.status).toBe(204);
    expect(links[0].revoked_at).toBe(revokedAt);
    expect(links[1].revoked_at).toBeNull();
  });

  it("returns a generic server error and rolls back when link insertion fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, transactionClient } = makeApp({
      shareInsertError: (tokenHash) => new Error(`database insert failed for ${tokenHash}`),
    });
    const response = await request(app)
      .post(createPath)
      .set("Authorization", "Bearer valid-token")
      .send({});

    expectGenericServerError(response);
    expect(transactionClient.query).toHaveBeenCalledWith("ROLLBACK");
    const diagnostics = JSON.stringify(log.mock.calls);
    expect(diagnostics).toContain("database insert failed for [REDACTED]");
    expect(diagnostics).not.toMatch(/[a-f0-9]{64}/);
  });
});

describe("public recipient downloads", () => {
  const downloadPath = `/api/share/${recipientToken}/download`;

  it("returns minimal public metadata only for an authorized active share", async () => {
    const row = { ...authorizedShareDownload, original_name: "notes.txt" };
    const { app, database } = makeApp({ shareDownloadRows: [row] });
    const response = await request(app).get(`/api/share/${recipientToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ filename: "notes.txt", contentType: "text/plain", sizeBytes: 13, expiresAt: row.expires_at });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).not.toHaveProperty("token_hash");
    expect(response.body).not.toHaveProperty("storage_path");
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("share_link.token_hash = $1"), [recipientTokenHash, 30, 5]);
  });

  it("does not distinguish unavailable shares or accept malformed tokens", async () => {
    const { app, database } = makeApp({ shareDownloadRows: [null] });
    const unknown = await request(app).get(`/api/share/${recipientToken}`);
    const malformed = await request(app).get("/api/share/not-a-token");
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(unknown.body).toEqual(malformed.body);
    expect(database.query).toHaveBeenCalledOnce();
  });

  it("streams the authorized object without requiring an application session", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("file contents", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, database, storageBucket } = makeApp({ shareDownloadRows: [authorizedShareDownload, authorizedShareDownload] });
    const response = await request(app).get(downloadPath);

    expect(response.status).toBe(200);
    expect(response.text).toBe("file contents");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-disposition"]).toContain('filename="notes.txt"');
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(storageBucket.createSignedUrl).toHaveBeenCalledWith(
      authorizedShareDownload.storage_path,
      authorizedShareDownload.signed_url_ttl_seconds,
      { download: "notes.txt" },
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).not.toContain(recipientToken);
    expect(database.query).toHaveBeenCalledTimes(2);
    expect(database.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("share_link.token_hash = $1"),
      [recipientTokenHash, 30, 5],
    );
    expect(database.query.mock.calls[0][0]).toContain("clock_timestamp()");
    expect(database.query.mock.calls[0][0]).toContain("share_link.expires_at > authorization_time.checked_at");
    expect(database.query.mock.calls[0][0]).toContain("file.created_at + interval '7 days'");
    expect(response.text).not.toContain(recipientTokenHash);
    expect(JSON.stringify(log.mock.calls)).not.toContain(recipientToken);
  });

  it("does not let stale metadata truncate a streamed Storage response", async () => {
    const body = "actual storage payload";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
    const staleMetadata = { ...authorizedShareDownload, size_bytes: "4" };
    const { app } = makeApp({ shareDownloadRows: [staleMetadata, staleMetadata] });

    const response = await request(app).get(downloadPath);

    expect(response.status).toBe(200);
    expect(response.text).toBe(body);
    expect(response.headers).not.toHaveProperty("content-length");
  });

  it.each(["malformed", "unknown", "revoked", "link expired", "file expired", "file metadata missing"])(
    "rejects %s shares without requesting Storage",
    async (scenario) => {
      const rows = scenario === "malformed" ? undefined : [null];
      const { app, database, storageBucket } = makeApp({ shareDownloadRows: rows });
      const path = scenario === "malformed" ? "/api/share/not-a-token/download" : downloadPath;
      const response = await request(app).get(path);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: { code: "SHARE_UNAVAILABLE", message: "This share link is unavailable" } });
      expect(storageBucket.createSignedUrl).not.toHaveBeenCalled();
      if (scenario === "malformed") expect(database.query).not.toHaveBeenCalled();
      else {
        expect(database.query).toHaveBeenCalledOnce();
        expect(database.query.mock.calls[0][1]?.[0]).toBe(recipientTokenHash);
      }
    },
  );

  it("rejects noncanonical base64url encodings before database access", async () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalCharacter = recipientToken.at(-1)!;
    const noncanonicalFinalCharacter = alphabet[alphabet.indexOf(finalCharacter) + 1];
    const noncanonicalToken = `${recipientToken.slice(0, -1)}${noncanonicalFinalCharacter}`;
    expect(Buffer.from(noncanonicalToken, "base64url")).toEqual(Buffer.from(recipientToken, "base64url"));

    const { app, database, storageBucket } = makeApp();
    const response = await request(app).get(`/api/share/${noncanonicalToken}/download`);

    expect(response.status).toBe(404);
    expect(database.query).not.toHaveBeenCalled();
    expect(storageBucket.createSignedUrl).not.toHaveBeenCalled();
  });

  it("refuses a token whose remaining lifetime is below the safety margin", async () => {
    const { app, storageBucket } = makeApp({
      shareDownloadRows: [{ ...authorizedShareDownload, signed_url_ttl_seconds: 0 }],
    });
    const response = await request(app).get(downloadPath);

    expect(response.status).toBe(404);
    expect(storageBucket.createSignedUrl).not.toHaveBeenCalled();
  });

  it("uses strict PostgreSQL-time comparisons at the expiration boundary", async () => {
    const { app, database, storageBucket } = makeApp({ shareDownloadRows: [null] });
    const response = await request(app).get(downloadPath);

    expect(response.status).toBe(404);
    const sql = String(database.query.mock.calls[0][0]);
    expect(sql).toContain("share_link.expires_at > authorization_time.checked_at");
    expect(sql).toContain("file.created_at + interval '7 days'");
    expect(sql).toContain("least(share_link.expires_at, coalesce(file.expires_at, file.created_at + interval '7 days')");
    expect(storageBucket.createSignedUrl).not.toHaveBeenCalled();
  });

  it("refuses a database storage path that is not a generated object path under its owner's UUID", async () => {
    const tamperedPath = {
      ...authorizedShareDownload,
      storage_path: "99999999-9999-4999-8999-999999999999/00000000-0000-4000-8000-000000000001",
    };
    const { app, storageBucket } = makeApp({ shareDownloadRows: [tamperedPath] });
    const response = await request(app).get(downloadPath);

    expect(response.status).toBe(404);
    expect(storageBucket.createSignedUrl).not.toHaveBeenCalled();
  });

  it("rechecks revocation after signing and does not fetch the object if access was revoked", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
    const { app, storageBucket } = makeApp({ shareDownloadRows: [authorizedShareDownload, null] });
    const response = await request(app).get(downloadPath);

    expect(response.status).toBe(404);
    expect(storageBucket.createSignedUrl).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fetch if link or file lifetime shrinks during signed URL creation", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
    const shorterLifetime = { ...authorizedShareDownload, signed_url_ttl_seconds: 20 };
    const { app } = makeApp({ shareDownloadRows: [authorizedShareDownload, shorterLifetime] });
    const response = await request(app).get(downloadPath);

    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["returned", "thrown"])("maps a signed URL %s failure to a safe response", async (failureKind) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
    const options = failureKind === "returned"
      ? { signedUrlError: new Error("internal storage detail") }
      : { signedUrlReject: new Error("internal storage detail") };
    const { app } = makeApp({ shareDownloadRows: [authorizedShareDownload], ...options });
    const response = await request(app).get(downloadPath);

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: { code: "DOWNLOAD_UNAVAILABLE", message: "File could not be prepared for download" } });
    expect(JSON.stringify(response.body)).not.toContain("internal storage detail");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a missing Storage object to the same unavailable-share response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const { app } = makeApp({ shareDownloadRows: [authorizedShareDownload, authorizedShareDownload] });
    const response = await request(app).get(downloadPath);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("SHARE_UNAVAILABLE");
    expect(JSON.stringify(response.body)).not.toContain(authorizedShareDownload.storage_path);
  });

  it("maps a Storage fetch failure to a safe gateway error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("storage transport details"));
    const { app } = makeApp({ shareDownloadRows: [authorizedShareDownload, authorizedShareDownload] });
    const response = await request(app).get(downloadPath);

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: { code: "DOWNLOAD_UNAVAILABLE", message: "File could not be prepared for download" } });
    expect(response.text).not.toContain("storage transport details");
  });

  it("uses a sanitized metadata filename and keeps private file routes authenticated", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bytes", { status: 200 }));
    const unsafeFilename = { ...authorizedShareDownload, original_name: "../../report\r\n.txt", size_bytes: "5" };
    const { app, storageBucket } = makeApp({ shareDownloadRows: [unsafeFilename, unsafeFilename] });
    const response = await request(app).get(downloadPath);
    const privateResponse = await request(app).get("/api/files");

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toContain('filename="report.txt"');
    expect(response.headers["content-disposition"]).not.toMatch(/[\r\n]/);
    expect(storageBucket.createSignedUrl).toHaveBeenCalledWith(
      unsafeFilename.storage_path,
      unsafeFilename.signed_url_ttl_seconds,
      { download: "report.txt" },
    );
    expect(privateResponse.status).toBe(401);
  });

  it("returns a generic server error for database failures", async () => {
    const { app, storageBucket } = makeApp({ shareDownloadError: new Error(`database failed for ${recipientTokenHash}`) });
    const response = await request(app).get(downloadPath);

    expectGenericServerError(response);
    expect(response.text).not.toContain(recipientToken);
    expect(response.text).not.toContain(recipientTokenHash);
    expect(storageBucket.createSignedUrl).not.toHaveBeenCalled();
  });
});
