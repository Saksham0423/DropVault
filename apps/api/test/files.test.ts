import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { SupabaseClients } from "../src/lib/supabase.js";

const ownerId = "8a4ac96c-7347-43b0-bdda-6247b65cdf9f";
const fileId = "3b898d67-c89b-407c-a922-f89d0afbb595";
const fileRow = {
  id: fileId,
  original_name: "notes.pdf",
  content_type: "application/pdf",
  size_bytes: "10",
  created_at: "2026-10-01T00:00:00.000Z",
  expires_at: null,
};

function makeApp(options: { selectedRows?: Record<string, unknown>[] } = {}) {
  const database = {
    query: vi.fn(async (...args: [string, unknown[]?]) => {
      const [sql] = args;
      if (sql.startsWith("select storage_path")) return { rows: options.selectedRows ?? [{ storage_path: `${ownerId}/stored-file` }], rowCount: 1 };
      if (sql.startsWith("select id")) return { rows: [fileRow], rowCount: 1 };
      if (sql.startsWith("insert")) return { rows: [fileRow], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }),
  };
  const authClient = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: ownerId } }, error: null })),
    },
  } as unknown as SupabaseClients["auth"];
  const storageBucket = {
    upload: vi.fn(async () => ({ data: {}, error: null })),
    remove: vi.fn(async () => ({ data: {}, error: null })),
  } as unknown as SupabaseClients["privateBucket"];

  return {
    app: createApp({ database: database as never, authClient, storageBucket, maxUploadBytes: 10 }),
    database,
    storageBucket,
  };
}

describe("authenticated file routes", () => {
  it("stores uploads for the authenticated owner without exposing storage paths", async () => {
    const { app, database, storageBucket } = makeApp();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .field("owner_id", "99999999-9999-4999-8999-999999999999")
      .attach("file", Buffer.from("%PDF-1.7\n"), { filename: "notes.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(response.body.file.originalName).toBe("notes.pdf");
    expect(response.body.file).not.toHaveProperty("storage_path");
    expect(database.query.mock.calls.at(-1)?.[1]?.[0]).toBe(ownerId);
    expect(storageBucket.upload).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${ownerId}/`)), expect.any(Buffer), expect.objectContaining({ upsert: false }));
  });

  it("stores an optional future expiration timestamp", async () => {
    const { app, database } = makeApp();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .field("expiresAt", expiresAt)
      .attach("file", Buffer.from("%PDF-1.7\n"), { filename: "notes.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(database.query.mock.calls.at(-1)?.[1]?.[5]).toBe(expiresAt);
  });

  it("lists only rows selected for the authenticated owner", async () => {
    const { app, database } = makeApp();
    const response = await request(app).get("/api/files").set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body.files[0].originalName).toBe("notes.pdf");
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("where owner_id = $1"), [ownerId]);
  });

  it("rejects files whose declared MIME type does not match their bytes", async () => {
    const { app, storageBucket } = makeApp();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", Buffer.from("not a pdf"), { filename: "notes.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("UNSUPPORTED_FILE_TYPE");
    expect(storageBucket.upload).not.toHaveBeenCalled();
  });

  it("enforces the upload size limit", async () => {
    const { app, storageBucket } = makeApp();
    const response = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer valid-token")
      .attach("file", Buffer.from("%PDF-1.7\n123456"), { filename: "large.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(413);
    expect(storageBucket.upload).not.toHaveBeenCalled();
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
