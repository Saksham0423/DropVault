import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { createDatabasePool } from "./db/pool.js";
import { createSupabaseClients, verifyPrivateBucket } from "./lib/supabase.js";

const config = loadConfig();
const database = createDatabasePool(config.DATABASE_URL);
const supabase = createSupabaseClients(config);
const app = createApp({
  webOrigin: config.WEB_ORIGIN,
  database,
  authClient: supabase.auth,
  storageBucket: supabase.privateBucket,
  maxUploadBytes: config.MAX_UPLOAD_BYTES,
});

app.locals.database = database;
app.locals.supabase = supabase;

let server: ReturnType<typeof app.listen> | undefined;

async function startServer() {
  await verifyPrivateBucket(supabase.storageAdmin, config.SUPABASE_STORAGE_BUCKET);
  server = app.listen(config.PORT, () => {
    console.info(`DropVault API listening on port ${config.PORT}`);
  });
}

function shutdown() {
  if (!server) {
    void database.end().finally(() => process.exit(0));
    return;
  }
  server.close(() => {
    void database.end().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
void startServer().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Unable to start the API");
  void database.end().finally(() => process.exit(1));
});
