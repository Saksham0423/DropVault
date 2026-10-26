/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_MAX_UPLOAD_BYTES: string;
  /** API origin for split-origin deployments, without a trailing /api path. */
  readonly VITE_API_BASE_URL?: string;
}
