import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabaseClient } from "./supabase";

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  error: string;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<Session | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children, client }: { children: ReactNode; client?: SupabaseClient }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let authClient: SupabaseClient;
    try {
      authClient = client ?? getSupabaseClient();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Supabase configuration is missing.");
      setLoading(false);
      return;
    }

    const { data: { subscription } } = authClient.auth.onAuthStateChange((_event, nextSession) => {
      if (active) setSession(nextSession);
    });
    void authClient.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) setError(sessionError.message);
      setSession(data.session);
      setLoading(false);
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "Could not restore your session.");
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client]);

  const value = useMemo<AuthContextValue>(() => {
    let authClient: SupabaseClient | undefined = client;
    if (!authClient && !error) {
      try {
        authClient = getSupabaseClient();
      } catch {
        authClient = undefined;
      }
    }
    return {
      session,
      user: session?.user ?? null,
      loading,
      error,
      signIn: async (email, password) => {
        if (!authClient) throw new Error(error || "Authentication is not configured.");
        const { error: authError } = await authClient.auth.signInWithPassword({ email, password });
        if (authError) throw authError;
      },
      signUp: async (email, password) => {
        if (!authClient) throw new Error(error || "Authentication is not configured.");
        const { data, error: authError } = await authClient.auth.signUp({ email, password });
        if (authError) throw authError;
        return data.session;
      },
      signOut: async () => {
        if (!authClient) throw new Error(error || "Authentication is not configured.");
        const { error: authError } = await authClient.auth.signOut();
        if (authError) throw authError;
      },
    };
  }, [client, error, loading, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
