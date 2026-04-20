/**
 * Photo processing worker — runs as a separate Container App (my-photos-worker-in).
 * Uses the same Docker image as the API server but with a different CMD.
 *
 * Responsibilities (all decoupled from upload latency):
 *   1. AI vision tags      — Azure Computer Vision for every untagged photo
 *   2. GPS + location name — EXIF extraction + Nominatim reverse-geocode
 *
 * Polling interval: 30 s
 */

import "dotenv/config";
import { db, photosTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { downloadBlob } from "./lib/azure-storage.js";
import { analyzePhoto } from "./lib/azure-vision.js";
import { generateVideoThumbnails, generateThumbnails } from "./lib/thumbnails.js";
import { logger } from "./lib/logger.js";
import exifr from "exifr";

// ── Config ────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS   = 30_000;     // tags + GPS + sync check: every 30 s
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

// ── Image thumbnail backfill pass ─────────────────────────────────────────────
// Covers Google-imported photos (streamed upload skips sync thumbnail generation)
// and any photos uploaded before thumbnail generation was added.

const IMAGE_THUMB_BATCH = 20; // larger batch, processed in parallel

async function runImageThumbnailPass(): Promise<void> {
  const rows = await db.execute(sql`
    SELECT id, blob_name, content_type
    FROM photos
    WHERE (thumb_blob_name IS NULL OR thumb_blob_name = '')
      AND content_type LIKE 'image/%'
      AND trashed = false
    ORDER BY uploaded_at DESC
    LIMIT ${IMAGE_THUMB_BATCH}
  `);

  if (rows.rows.length === 0) return;
  logger.info({ count: rows.rows.length }, "[worker] image-thumb: processing batch");

  // Process all items in the batch concurrently
  await Promise.all(
    (rows.rows as Array<{ id: string; blob_name: string; content_type: string }>).map(async (row) => {
      try {
        const buf = await downloadBlob(row.blob_name);
        const thumbs = await generateThumbnails(buf, row.blob_name, row.content_type);
        if (thumbs) {
          await db.execute(sql`
            UPDATE photos SET thumb_blob_name = ${thumbs.thumbBlobName}, preview_blob_name = ${thumbs.previewBlobName}
            WHERE id = ${row.id}
          `);
          logger.info({ id: row.id }, "[worker] image-thumb: generated");
        } else {
          // Mark with sentinel so we don't retry endlessly
          await db.execute(sql`UPDATE photos SET thumb_blob_name = '' WHERE id = ${row.id}`);
          logger.warn({ id: row.id }, "[worker] image-thumb: sharp returned null, skipping");
        }
      } catch (err) {
        logger.warn({ id: row.id, err }, "[worker] image-thumb: failed, will retry");
      }
    }),
  );
}

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

logger.info("[worker] Photo processing worker started");

// Vision + GPS + video thumbnails: run immediately, then every 30 s
async function pollLoop() {
  while (!_shutdown) {
    try {
      await runVisionPass();
      await runGpsPass();
      await runImageThumbnailPass();
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
