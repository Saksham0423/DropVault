import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolveUploadLimit } from "./src/lib/upload-limit";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, projectRoot, "");
  const maxUploadBytes = resolveUploadLimit(environment.MAX_UPLOAD_BYTES, environment.VITE_MAX_UPLOAD_BYTES);
  return {
    envDir: projectRoot,
    envPrefix: "VITE_",
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(environment.SUPABASE_URL ?? ""),
      "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(environment.SUPABASE_ANON_KEY ?? ""),
      "import.meta.env.VITE_MAX_UPLOAD_BYTES": JSON.stringify(String(maxUploadBytes)),
    },
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { "/api": "http://localhost:3000" },
    },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.tsx"],
    },
  };
});
