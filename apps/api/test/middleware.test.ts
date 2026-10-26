import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/error-handler.js";
import { requireAuth } from "../src/middleware/require-auth.js";
import { validateRequest } from "../src/middleware/validate-request.js";
import { verifyPrivateBucket } from "../src/lib/supabase.js";
import { z } from "zod";

describe("request validation", () => {
  it("returns a structured 400 response for invalid input", async () => {
    const app = express();
    app.use(express.json());
    app.post(
      "/files",
      validateRequest(z.object({ body: z.object({ name: z.string().min(1) }) })),
      (_request, response) => response.sendStatus(204),
    );
    app.use(errorHandler);

    const response = await request(app).post("/files").send({ name: "" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("authentication middleware", () => {
  it("rejects requests without a bearer token", async () => {
    const getUser = vi.fn();
    const app = express();
    app.get("/private", requireAuth({ auth: { getUser } } as never), (_request, response) => response.sendStatus(204));

    const response = await request(app).get("/private");

    expect(response.status).toBe(401);
    expect(getUser).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token", async () => {
    const auth = { getUser: vi.fn(async () => ({ data: { user: null }, error: new Error("invalid") })) };
    const app = express();
    app.get("/private", requireAuth({ auth } as never), (_request, response) => response.sendStatus(204));

    const response = await request(app).get("/private").set("Authorization", "Bearer invalid-token");

    expect(response.status).toBe(401);
    expect(auth.getUser).toHaveBeenCalledWith("invalid-token");
  });

  it.each(["Bearer", "Bearer   ", "Basic valid-token", "Bearer first second"])(
    "rejects a malformed authorization header (%s) before token verification",
    async (authorization) => {
      const getUser = vi.fn();
      const app = express();
      app.get("/private", requireAuth({ auth: { getUser } } as never), (_request, response) => response.sendStatus(204));

      const response = await request(app).get("/private").set("Authorization", authorization);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHORIZED");
      expect(getUser).not.toHaveBeenCalled();
    },
  );

  it("rejects an expired bearer token returned as invalid by Supabase", async () => {
    const auth = { getUser: vi.fn(async () => ({ data: { user: null }, error: new Error("JWT expired") })) };
    const app = express();
    app.get("/private", requireAuth({ auth } as never), (_request, response) => response.sendStatus(204));

    const response = await request(app).get("/private").set("Authorization", "Bearer expired-token");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Invalid access token" } });
    expect(auth.getUser).toHaveBeenCalledWith("expired-token");
  });
});

describe("private storage configuration", () => {
  it("fails startup validation if the configured bucket is public", async () => {
    const storageAdmin = { storage: { getBucket: vi.fn(async () => ({ data: { public: true }, error: null })) } };

    await expect(verifyPrivateBucket(storageAdmin as never, "dropvault-files")).rejects.toThrow("must be private");
  });
});

describe("internal error reporting", () => {
  it("logs sanitized diagnostics while returning the generic server error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = express();
    app.get("/failure", () => {
      throw Object.assign(
        new Error("PostgreSQL failed (Bearer test-access-token); password=private-value"),
        { code: "42703" },
      );
    });
    app.use(errorHandler);

    const response = await request(app).get("/failure");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    expect(log).toHaveBeenCalledWith("[api] Unhandled request error", expect.objectContaining({
      name: "Error",
      message: expect.stringContaining("PostgreSQL failed"),
      code: "42703",
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("test-access-token");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-value");
    log.mockRestore();
  });
});
