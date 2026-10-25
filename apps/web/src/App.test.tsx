import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";

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
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ files: [] }) })));
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
});
