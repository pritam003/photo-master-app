/**
 * Photo processing worker — runs as a separate Container App (my-photos-worker-in).
 * Uses the same Docker image as the API server but with a different CMD.
 *
 * Responsibilities (all decoupled from upload latency):
 *   1. AI vision tags      — Azure Computer Vision for every untagged photo
 *   2. GPS + location name — EXIF extraction + Nominatim reverse-geocode
 *   3. Face recognition    — TensorFlow local inference, hourly batch
 *
 * Polling interval: 30 s (for tags + GPS), 1 hour (face recognition)
 *
 * Face recognition is spawned as an isolated child process so a native crash
 * in @tensorflow/tfjs-node or @vladmandic/face-api cannot kill the main worker.
 */

import "dotenv/config";
import { spawn } from "child_process";
import { db, photosTable } from "@workspace/db";
import { sql, isNull, and, like, eq } from "drizzle-orm";
import { downloadBlob } from "./lib/azure-storage.js";
import { analyzePhoto } from "./lib/azure-vision.js";
import { generateVideoThumbnails } from "./lib/thumbnails.js";
import { runFaceRecognitionJob } from "./lib/face-recognition.js";
import { logger } from "./lib/logger.js";
import exifr from "exifr";

// ── Config ────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS   = 30_000;     // tags + GPS: every 30 s
const FACE_INTERVAL_MS   = 60 * 60 * 1000; // face recognition: every hour
const GPS_RATE_LIMIT_MS  = 1100;       // Nominatim: max 1 req/sec
const VISION_BATCH       = parseInt(process.env.VISION_BATCH ?? "5", 10);
const GPS_BATCH          = parseInt(process.env.GPS_BATCH   ?? "20", 10);

// ── Reverse geocode ───────────────────────────────────────────────────────────

async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&addressdetails=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "PhotoMasterWorker/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const data = await res.json() as { address?: Record<string, string> };
    const a = data.address ?? {};
    const parts = [
      a.suburb || a.neighbourhood || a.village || a.town,
      a.city || a.municipality || a.county,
      a.state,
      a.country,
    ].filter(Boolean) as string[];
    return parts.join(", ");
  } catch {
    return "";
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Video thumbnail backfill pass ─────────────────────────────────────────────

const VIDEO_THUMB_BATCH = 3; // small batch — video download + ffmpeg is heavy

async function runVideoThumbnailPass(): Promise<void> {
  const rows = await db.execute(sql`
    SELECT id, blob_name, content_type
    FROM photos
    WHERE thumb_blob_name IS NULL
      AND content_type LIKE 'video/%'
      AND trashed = false
    ORDER BY uploaded_at DESC
    LIMIT ${VIDEO_THUMB_BATCH}
  `);

  if (rows.rows.length === 0) return;
  logger.info({ count: rows.rows.length }, "[worker] video-thumb: processing batch");

  for (const row of rows.rows as Array<{ id: string; blob_name: string; content_type: string }>) {
    try {
      const buf = await downloadBlob(row.blob_name);
      const thumbs = await generateVideoThumbnails(buf, row.blob_name);
      if (thumbs) {
        await db.execute(sql`
          UPDATE photos SET thumb_blob_name = ${thumbs.thumbBlobName}, preview_blob_name = ${thumbs.previewBlobName}
          WHERE id = ${row.id}
        `);
        logger.info({ id: row.id }, "[worker] video-thumb: generated");
      } else {
        // Mark with an empty sentinel so we don't retry endlessly on videos ffmpeg can't decode
        await db.execute(sql`UPDATE photos SET thumb_blob_name = '' WHERE id = ${row.id}`);
        logger.warn({ id: row.id }, "[worker] video-thumb: ffmpeg returned no frame, skipping");
      }
    } catch (err) {
      logger.warn({ id: row.id, err }, "[worker] video-thumb: failed, will retry");
    }
  }
}

// ── Vision tags pass ──────────────────────────────────────────────────────────

async function runVisionPass(): Promise<void> {
  const rows = await db.execute(sql`
    SELECT id, blob_name, content_type
    FROM photos
    WHERE tags IS NULL
      AND content_type LIKE 'image/%'
      AND trashed = false
    ORDER BY uploaded_at DESC
    LIMIT ${VISION_BATCH}
  `);

  if (rows.rows.length === 0) return;
  logger.info({ count: rows.rows.length }, "[worker] vision: processing batch");

  for (const row of rows.rows as Array<{ id: string; blob_name: string; content_type: string }>) {
    try {
      const buf = await downloadBlob(row.blob_name);
      const tags = await analyzePhoto(buf, row.content_type);
      // Set to empty string when no tags returned so it won't be re-processed endlessly
      await db.execute(sql`UPDATE photos SET tags = ${tags || ""} WHERE id = ${row.id}`);
      logger.info({ id: row.id, tags }, "[worker] vision: tagged");
    } catch (err) {
      logger.warn({ id: row.id, err }, "[worker] vision: failed, will retry");
    }
  }
}

// ── GPS / location pass ───────────────────────────────────────────────────────

async function runGpsPass(): Promise<void> {
  // Process photos with no location attempt yet (NULL) OR those that previously
  // returned empty (e.g. Google-imported photos where GPS was unavailable at
  // import time) — retry empty-location photos that were uploaded in the last
  // 30 days so we pick up any that got '' due to a transient failure.
  const rows = await db.execute(sql`
    SELECT id, blob_name, content_type
    FROM photos
    WHERE (
        location_name IS NULL
        OR (location_name = '' AND uploaded_at > NOW() - INTERVAL '30 days')
      )
      AND content_type LIKE 'image/%'
      AND trashed = false
    ORDER BY location_name IS NULL DESC, uploaded_at DESC
    LIMIT ${GPS_BATCH}
  `);

  if (rows.rows.length === 0) return;
  logger.info({ count: rows.rows.length }, "[worker] gps: processing batch");

  for (const row of rows.rows as Array<{ id: string; blob_name: string; content_type: string }>) {
    try {
      const buf = await downloadBlob(row.blob_name);
      const gps = await exifr.gps(buf).catch(() => null);

      if (gps?.latitude != null && gps?.longitude != null) {
        const location = await reverseGeocode(gps.latitude, gps.longitude);
        await db.execute(sql`UPDATE photos SET location_name = ${location || ""} WHERE id = ${row.id}`);
        if (location) {
          logger.info({ id: row.id, location }, "[worker] gps: geocoded");
          await sleep(GPS_RATE_LIMIT_MS); // honour Nominatim 1 req/s limit
        } else {
          await db.execute(sql`UPDATE photos SET location_name = '' WHERE id = ${row.id}`);
        }
      } else {
        // No GPS in EXIF — mark as processed so we skip it next run
        await db.execute(sql`UPDATE photos SET location_name = '' WHERE id = ${row.id}`);
      }
    } catch (err) {
      logger.warn({ id: row.id, err }, "[worker] gps: failed, will retry");
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

let _shutdown = false;

process.on("SIGTERM", () => {
  logger.info("[worker] SIGTERM received — finishing current batch then exiting");
  _shutdown = true;
});
process.on("SIGINT", () => { _shutdown = true; });

// ── Face-only mode ────────────────────────────────────────────────────────────
// Face recognition is spawned as a child process (FACE_ONLY_MODE=true) so that
// a native crash in @tensorflow/tfjs-node or @vladmandic/face-api cannot take
// down the main worker process.  The child exits (0 = success, 1 = error)
// after completing a single pass, and the parent simply awaits its exit code.

if (process.env.FACE_ONLY_MODE === "true") {
  // Catch any uncaught exception/rejection from TF or face-api (they sometimes
  // call process.exit or throw outside async boundaries) to get a log before exit.
  process.on("uncaughtException", (err) => {
    logger.error({ err: String(err) }, "[face-worker] uncaughtException — exiting");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason: String(reason) }, "[face-worker] unhandledRejection — exiting");
    process.exit(1);
  });

  logger.info("[face-worker] starting face recognition pass");
  runFaceRecognitionJob()
    .then(() => {
      logger.info("[face-worker] pass complete — exiting");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: String(err) }, "[face-worker] unhandled error — exiting");
      process.exit(1);
    });
} else {
  // ── Normal worker: vision + GPS poll loop + hourly face recognition ──────────

  /**
   * Spawns a fresh Node.js child process running worker.mjs in FACE_ONLY_MODE.
   * If the child crashes (e.g. TF segfault), the main worker is unaffected.
   */
  function spawnFaceRecognitionJob(): Promise<void> {
    return new Promise((resolve) => {
      const workerScript = new URL(import.meta.url).pathname;
      const child = spawn(
        process.execPath,
        ["--enable-source-maps", "--max-old-space-size=3072", workerScript],
        {
          env: { ...process.env, FACE_ONLY_MODE: "true" },
          stdio: "inherit",
        },
      );
      child.on("close", (code) => {
        if (code !== 0) {
          logger.warn({ code }, "[worker] face: child process exited with error — will retry next interval");
        } else {
          logger.info("[worker] face: child process completed successfully");
        }
        resolve();
      });
      child.on("error", (err) => {
        logger.warn({ err }, "[worker] face: failed to spawn child process");
        resolve();
      });
    });
  }

  logger.info("[worker] Photo processing worker started");

  // Face recognition: first run 30 s after startup, then hourly
  setTimeout(() => {
    spawnFaceRecognitionJob();
    setInterval(() => {
      spawnFaceRecognitionJob();
    }, FACE_INTERVAL_MS);
  }, 30_000);

  // Vision + GPS + video thumbnails: run immediately, then every 30 s
  async function pollLoop() {
    while (!_shutdown) {
      try {
        await runVisionPass();
        await runGpsPass();
        await runVideoThumbnailPass();
      } catch (err) {
        logger.warn({ err }, "[worker] poll error");
      }
      await sleep(POLL_INTERVAL_MS);
    }
    logger.info("[worker] shutdown complete");
    process.exit(0);
  }

  pollLoop();
}
