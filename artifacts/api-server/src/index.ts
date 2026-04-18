import "dotenv/config";
import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { warmReadSasKey } from "./lib/azure-storage.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Ensure album_shares table exists with all required columns (idempotent)
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS album_shares (
    token             TEXT        PRIMARY KEY,
    album_id          UUID        NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    created_by        TEXT        NOT NULL,
    name              TEXT,
    permission        TEXT        NOT NULL DEFAULT 'view',
    access_code_hash  TEXT        NOT NULL DEFAULT '',
    revoked_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
// Add new columns to existing tables (safe no-ops if already present)
await db.execute(sql`ALTER TABLE album_shares ADD COLUMN IF NOT EXISTS name TEXT`);
await db.execute(sql`ALTER TABLE album_shares ADD COLUMN IF NOT EXISTS access_code_hash TEXT NOT NULL DEFAULT ''`);
await db.execute(sql`ALTER TABLE album_shares ADD COLUMN IF NOT EXISTS share_type TEXT NOT NULL DEFAULT 'code'`);
await db.execute(sql`ALTER TABLE album_shares ADD COLUMN IF NOT EXISTS allowed_emails TEXT`);
await db.execute(sql`ALTER TABLE photos ADD COLUMN IF NOT EXISTS tags TEXT`);
await db.execute(sql`ALTER TABLE photos ADD COLUMN IF NOT EXISTS location_name TEXT`);

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Pre-warm the delegation key so generateSasUrl() can sign read SAS URLs immediately.
  // Refresh every 5.5 hours (key TTL is 6 hours).
  warmReadSasKey().catch(() => {});
  setInterval(() => warmReadSasKey().catch(() => {}), 5.5 * 60 * 60 * 1000);
});
