import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { Pool } from "pg";
import type { SupabaseClients } from "./lib/supabase.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { createFilesRouter } from "./routes/files.js";
import { healthRouter } from "./routes/health.js";

export interface AppDependencies {
  webOrigin?: string;
  database?: Pick<Pool, "query">;
  authClient?: SupabaseClients["auth"];
  storageBucket?: SupabaseClients["privateBucket"];
  maxUploadBytes?: number;
}

export function createApp(dependencies: AppDependencies = {}) {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: dependencies.webOrigin ?? "http://localhost:5173" }));
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/health", healthRouter);
  if (dependencies.database && dependencies.authClient && dependencies.storageBucket) {
    app.use(
      "/api/files",
      createFilesRouter({
        database: dependencies.database,
        authClient: dependencies.authClient,
        storageBucket: dependencies.storageBucket,
        maxUploadBytes: dependencies.maxUploadBytes ?? 10 * 1024 * 1024,
      }),
    );
  }
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
