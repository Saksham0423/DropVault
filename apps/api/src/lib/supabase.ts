import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config/env.js";

export interface SupabaseClients {
  auth: SupabaseClient;
  storageAdmin: SupabaseClient;
  privateBucket: ReturnType<SupabaseClient["storage"]["from"]>;
}

export function createSupabaseClients(config: AppConfig): SupabaseClients {
  const auth = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const storageAdmin = createClient(
    config.SUPABASE_URL,
    config.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  return {
    auth,
    storageAdmin,
    privateBucket: storageAdmin.storage.from(config.SUPABASE_STORAGE_BUCKET),
  };
}

export async function verifyPrivateBucket(client: SupabaseClient, bucketName: string): Promise<void> {
  const { data, error } = await client.storage.getBucket(bucketName);
  if (error || !data) {
    throw new Error(`Configured Supabase Storage bucket "${bucketName}" is unavailable`);
  }
  if (data.public) {
    throw new Error(`Configured Supabase Storage bucket "${bucketName}" must be private`);
  }
}
