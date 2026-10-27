import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { getPublicShareUrl, getShareDownloadUrl } from "./lib/api";
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
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/share-links") && method === "POST") {
        return { ok: true, status: 201, json: async () => ({ link: {
          id: "created-link", token: "sample-share-token", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-02T00:00:00.000Z",
        } }) };
      }
      if (url.includes("/share-links") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ links: [], hasMore: false }) };
      }
      if (method === "DELETE") return { ok: true, status: 204, json: async () => undefined };
      if (method === "POST") {
        return { ok: true, status: 201, json: async () => ({ file: { id: "uploaded-id", originalName: "upload.pdf", contentType: "application/pdf", sizeBytes: 10, createdAt: "2026-10-01T00:00:00.000Z", expiresAt: null } }) };
      }
      return { ok: true, status: 200, json: async () => ({ files: [] }) };
    }));
  });

  it("creates a share link with a supported expiration and copies the public download URL", async () => {
    const user = userEvent.setup();
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboardWrite } });
    const { client } = makeAuthClient(makeSession());
    const file = { id: "file-id", originalName: "notes.txt", contentType: "text/plain", sizeBytes: 42, createdAt: "2026-10-01T00:00:00.000Z", expiresAt: null };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/files") return { ok: true, status: 200, json: async () => ({ files: [file] }) };
      if (url.endsWith("/share-links") && init?.method === "POST") return {
        ok: true,
        status: 201,
        json: async () => ({ link: { id: "created-link", token: "sample-share-token", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-02T00:00:00.000Z" } }),
      };
      if (url.endsWith("/share-links")) return { ok: true, status: 200, json: async () => ({ links: [], hasMore: false }) };
      return { ok: true, status: 200, json: async () => ({ files: [] }) };
    });
    render(<AuthProvider client={client}><App /></AuthProvider>);
    await screen.findByRole("heading", { name: "Your files." });
    await waitFor(() => expect(screen.getByText("notes.txt")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByRole("heading", { name: "Existing links" });
    await user.selectOptions(screen.getByLabelText("Link expires"), "1h");
    await user.click(screen.getByRole("button", { name: "Create link" }));

    const linkInput = await screen.findByRole("textbox", { name: "Generated share link" }) as HTMLInputElement;
    expect(linkInput.value).toBe(`${window.location.origin}/?share=sample-share-token`);
    const createCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([input, init]) => String(input).endsWith("/share-links") && (init as RequestInit).method === "POST");
    expect(createCall).toBeTruthy();
    const createInit = createCall?.[1] as RequestInit;
    expect(JSON.parse(String(createInit.body))).toMatchObject({ expiresAt: expect.any(String) });
    expect(new Date(JSON.parse(String(createInit.body)).expiresAt).getTime()).toBeGreaterThan(Date.now());

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(clipboardWrite).toHaveBeenCalledWith(linkInput.value);
    expect(await screen.findByText("Link copied.")).toBeTruthy();
  });

  it("builds public download URLs for a separately hosted API", () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.dropvault.example/");
    expect(getShareDownloadUrl("public-token")).toBe("https://api.dropvault.example/api/share/public-token/download");
  });

  it("builds frontend recipient URLs and supports a configured web origin", () => {
    vi.stubEnv("VITE_WEB_ORIGIN", "https://drop-vault-nine.vercel.app/");
    expect(getPublicShareUrl("abc123")).toBe("https://drop-vault-nine.vercel.app/?share=abc123");
  });

  it("shows a public recipient page without requiring authentication", async () => {
    window.history.replaceState({}, "", "/?share=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const { client, auth } = makeAuthClient(null);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => String(input) === "/api/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      ? { ok: true, status: 200, json: async () => ({ filename: "notes.txt", contentType: "text/plain", sizeBytes: 14, expiresAt: new Date(Date.now() + 60_000).toISOString() }) }
      : { ok: true, status: 200, json: async () => ({ files: [] }) });
    render(<AuthProvider client={client}><App /></AuthProvider>);
    expect(await screen.findByRole("heading", { name: "Your file is ready." })).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Download File/ }).getAttribute("href")).toBe(`${window.location.origin}/api/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/download`);
    expect(auth.getSession).toHaveBeenCalledOnce();
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([input]) => String(input) === "/api/files")).toBe(false);
    window.history.replaceState({}, "", "/");
  });

  it("shows unavailable and network states without exposing API payloads", async () => {
    const { client } = makeAuthClient(null);
    window.history.replaceState({}, "", "/?share=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: { code: "SHARE_UNAVAILABLE", message: "private backend details" } }) });
    const unavailable = render(<AuthProvider client={client}><App /></AuthProvider>);
    expect(await screen.findByRole("heading", { name: "This vault link is no longer available" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("private backend details");
    unavailable.unmount();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("private network details"));
    render(<AuthProvider client={client}><App /></AuthProvider>);
    expect(await screen.findByRole("heading", { name: "We couldn’t check this link." })).toBeTruthy();
    expect(document.body.textContent).not.toContain("private network details");
    window.history.replaceState({}, "", "/");
  });

  it("does not invent an expiry countdown when metadata omits expiry", async () => {
    const { client } = makeAuthClient(null);
    window.history.replaceState({}, "", "/?share=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, json: async () => ({ filename: "notes.txt", contentType: "text/plain", sizeBytes: 14 }) });
    render(<AuthProvider client={client}><App /></AuthProvider>);
    expect(await screen.findByRole("heading", { name: "Your file is ready." })).toBeTruthy();
    expect(screen.queryByText(/Link available for/)).toBeNull();
    window.history.replaceState({}, "", "/");
  });

  it("ends the countdown at zero and clears its timer on unmount", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const { client } = makeAuthClient(null);
    window.history.replaceState({}, "", "/?share=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, json: async () => ({ filename: "notes.txt", contentType: "text/plain", sizeBytes: 14, expiresAt: "2026-10-27T12:00:02.000Z" }) });
    const view = render(<AuthProvider client={client}><App /></AuthProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("0h 00m 02s")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("heading", { name: "This vault link is no longer available" })).toBeTruthy();
    view.unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
  });

  it("provides a selectable link when clipboard access fails", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    const { client } = makeAuthClient(makeSession());
    const file = { id: "file-id", originalName: "notes.txt", contentType: "text/plain", sizeBytes: 42, createdAt: "2026-10-01T00:00:00.000Z", expiresAt: null };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/files") return { ok: true, status: 200, json: async () => ({ files: [file] }) };
      if (url.endsWith("/share-links") && init?.method === "POST") return { ok: true, status: 201, json: async () => ({ link: { id: "created-link", token: "sample-share-token", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-02T00:00:00.000Z" } }) };
      if (url.endsWith("/share-links")) return { ok: true, status: 200, json: async () => ({ links: [], hasMore: false }) };
      return { ok: true, status: 200, json: async () => ({ files: [] }) };
    });
    render(<AuthProvider client={client}><App /></AuthProvider>);
    await screen.findByRole("heading", { name: "Your files." });
    await user.click(await screen.findByRole("button", { name: "Share" }));
    await user.click(await screen.findByRole("button", { name: "Create link" }));
    const input = await screen.findByRole("textbox", { name: "Generated share link" }) as HTMLInputElement;
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect((await screen.findByText("Copy was unavailable. Select the link above and copy it.")).textContent).toBeTruthy();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("loads active, expired, and revoked shares and revokes an active link", async () => {
    const user = userEvent.setup();
    const { client } = makeAuthClient(makeSession());
    const active = { id: "active-link", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-03T00:00:00.000Z", revokedAt: null, status: "active" };
    const expired = { id: "expired-link", createdAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-02T00:00:00.000Z", revokedAt: null, status: "expired" };
    const revoked = { id: "revoked-link", createdAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-03T00:00:00.000Z", revokedAt: "2026-08-02T00:00:00.000Z", status: "revoked" };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/files") return { ok: true, status: 200, json: async () => ({ files: [{ id: "file-id", originalName: "notes.txt", contentType: "text/plain", sizeBytes: 42, createdAt: "2026-10-01T00:00:00.000Z", expiresAt: null }] }) };
      if (url.includes("/share-links") && init?.method === "DELETE") return { ok: true, status: 204 };
      if (url.endsWith("/share-links")) return { ok: true, status: 200, json: async () => ({ links: [active, expired, revoked], hasMore: false }) };
      return { ok: true, status: 200, json: async () => ({ files: [] }) };
    });
    render(<AuthProvider client={client}><App /></AuthProvider>);
    await screen.findByRole("heading", { name: "Your files." });
    await user.click(await screen.findByRole("button", { name: "Share" }));

    expect(await screen.findByText("active", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("expired", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("revoked", { selector: "strong" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Revoke share link/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /Revoke share link/ }));
    await waitFor(() => expect(screen.getAllByText("revoked", { selector: "strong" })).toHaveLength(2));
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([input, init]) => String(input).endsWith("/active-link") && (init as RequestInit).method === "DELETE")).toBe(true);
  });

  it("keeps a link active and reports errors when listing or revocation fails", async () => {
    const user = userEvent.setup();
    const { client } = makeAuthClient(makeSession());
    let failList = true;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/files") return { ok: true, status: 200, json: async () => ({ files: [{ id: "file-id", originalName: "notes.txt", contentType: "text/plain", sizeBytes: 42, createdAt: "2026-10-01T00:00:00.000Z", expiresAt: null }] }) };
      if (url.includes("/share-links/") && init?.method === "DELETE") return { ok: false, status: 500, json: async () => ({ error: { message: "Could not revoke." } }) };
      if (url.endsWith("/share-links") && failList) return { ok: false, status: 503, json: async () => ({ error: { message: "Could not load links." } }) };
      if (url.endsWith("/share-links")) return { ok: true, status: 200, json: async () => ({ links: [{ id: "active-link", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-03T00:00:00.000Z", revokedAt: null, status: "active" }], hasMore: false }) };
      return { ok: true, status: 200, json: async () => ({ files: [] }) };
    });
    render(<AuthProvider client={client}><App /></AuthProvider>);
    await screen.findByRole("heading", { name: "Your files." });
    await user.click(await screen.findByRole("button", { name: "Share" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load links.");
    failList = false;
    await user.click(screen.getByRole("button", { name: "Close sharing" }));
    await user.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByText("active", { selector: "strong" });
    await user.click(screen.getByRole("button", { name: /Revoke share link/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not revoke.");
    expect(screen.getByText("active", { selector: "strong" })).toBeTruthy();
  });

  it("offers the file expiration option when the file has a future expiration", async () => {
    const user = userEvent.setup();
    const { client } = makeAuthClient(makeSession());
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => String(input) === "/api/files"
      ? { ok: true, status: 200, json: async () => ({ files: [{ id: "file-id", originalName: "old.txt", contentType: "text/plain", sizeBytes: 4, createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-11-02T00:00:00.000Z" }] }) }
      : { ok: true, status: 200, json: async () => ({ links: [], hasMore: false }) });
    render(<AuthProvider client={client}><App /></AuthProvider>);
    await screen.findByRole("heading", { name: "Your files." });
    await user.click(await screen.findByRole("button", { name: "Share" }));
    expect(screen.getByRole("option", { name: "When the file expires" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(false);
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
