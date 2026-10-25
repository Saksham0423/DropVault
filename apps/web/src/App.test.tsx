import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { DEFAULT_MAX_UPLOAD_BYTES, isWithinUploadLimit, resolveUploadLimit } from "./lib/upload-limit";

const mebibyte = 1024 * 1024;
const frontendUploadLimit = Number(import.meta.env.VITE_MAX_UPLOAD_BYTES) || DEFAULT_MAX_UPLOAD_BYTES;

function makeSession(): Session {
  const user = { id: "user-id", email: "person@example.com", app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: "2026-01-01T00:00:00.000Z" };
  return {
    access_token: "test-token",
    refresh_token: "refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: 1798761600,
    user,
  } as Session;
}

function makeAuthClient(initialSession: Session | null = null) {
  let session = initialSession;
  let authListener: ((_event: string, nextSession: Session | null) => void) | undefined;
  const auth = {
    onAuthStateChange: vi.fn((listener: typeof authListener) => {
      authListener = listener;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    }),
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    signUp: vi.fn(async () => ({ data: { session: null, user: null }, error: null })),
    signInWithPassword: vi.fn(async () => {
      session = makeSession();
      authListener?.("SIGNED_IN", session);
      return { data: { session, user: session.user }, error: null };
    }),
    signOut: vi.fn(async () => {
      session = null;
      authListener?.("SIGNED_OUT", null);
      return { error: null };
    }),
  };
  return { client: { auth } as unknown as SupabaseClient, auth };
}

describe("authentication and dashboard", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? { ok: true, status: 201, json: async () => ({ file: { id: "uploaded-id", originalName: "upload.pdf", contentType: "application/pdf", sizeBytes: 10, createdAt: "2026-10-01T00:00:00.000Z", expiresAt: null } }) }
      : { ok: true, status: 200, json: async () => ({ files: [] }) }));
  });

  it("keeps the frontend cap bounded by the API limit and accepts the exact byte boundary", () => {
    expect(resolveUploadLimit()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(resolveUploadLimit("10485760", "12582912")).toBe(10 * mebibyte);
    expect(resolveUploadLimit("12582912", "8388608")).toBe(8 * mebibyte);
    expect(isWithinUploadLimit(9 * mebibyte, frontendUploadLimit)).toBe(true);
    expect(isWithinUploadLimit(frontendUploadLimit, frontendUploadLimit)).toBe(true);
    expect(isWithinUploadLimit(frontendUploadLimit + 1, frontendUploadLimit)).toBe(false);
  });

  it("signs up and explains email confirmation", async () => {
    const user = userEvent.setup();
    const { client, auth } = makeAuthClient();
    render(<AuthProvider client={client}><App /></AuthProvider>);

    await user.click(await screen.findByRole("button", { name: "Switch to account creation" }));
    await user.type(screen.getByLabelText("Email"), "person@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect((await screen.findByRole("status")).textContent).toContain("Check your inbox");
    expect(auth.signUp).toHaveBeenCalledWith({ email: "person@example.com", password: "password123" });
  });

  it("signs in to a protected dashboard, loads files, and signs out", async () => {
    const user = userEvent.setup();
    const { client, auth } = makeAuthClient();
    render(<AuthProvider client={client}><App /></AuthProvider>);

    await user.type(await screen.findByLabelText("Email"), "person@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "Your files." })).toBeTruthy();
    expect(await screen.findByText("No files yet")).toBeTruthy();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/files", expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }));
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Welcome back." })).toBeTruthy();
    expect(auth.signOut).toHaveBeenCalledOnce();
  });

  it("sends a 9 MiB PDF to the API instead of rejecting it in the UI", async () => {
    const user = userEvent.setup();
    const { client } = makeAuthClient(makeSession());
    render(<AuthProvider client={client}><App /></AuthProvider>);
    await screen.findByRole("heading", { name: "Your files." });

    const file = new File([new Uint8Array(9 * mebibyte)], "nine-mib.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Choose a file"), { target: { files: [file] } });
    await user.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/files", expect.objectContaining({ method: "POST" })));
  });

  it("rejects a file one byte over the configured cap before making an upload request", async () => {
    const user = userEvent.setup();
    const { client } = makeAuthClient(makeSession());
    render(<AuthProvider client={client}><App /></AuthProvider>);
    await screen.findByRole("heading", { name: "Your files." });

    const file = new File([new Uint8Array(frontendUploadLimit + 1)], "over-limit.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Choose a file"), { target: { files: [file] } });
    await user.click(screen.getByRole("button", { name: "Upload" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no larger than");
    expect(alert.textContent).toContain(frontendUploadLimit % mebibyte === 0
      ? `${frontendUploadLimit / mebibyte} MiB`
      : `${(frontendUploadLimit / mebibyte).toFixed(2)} MiB (${frontendUploadLimit.toLocaleString()} bytes)`);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });
});
