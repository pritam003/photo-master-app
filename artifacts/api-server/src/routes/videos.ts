/**
 * /videos routes
 *
 * GET  /videos/music-tracks          — list available background music tracks
 * POST /videos/memory                — kick off async video generation job
 * GET  /videos/memory/:jobId         — poll job status / retrieve video URL
 */

import { Router } from "express";
import { randomUUID } from "crypto";
import { db, photosTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { MUSIC_TRACKS, findTrack } from "../lib/music-tracks.js";
import { createJob, getJob, updateJob } from "../lib/video-jobs.js";
import { generateMemoryVideo } from "../lib/video-generation.js";
import { logger } from "../lib/logger.js";

const router = Router();

const MIN_PHOTOS = 15;
const MAX_PHOTOS = 20;

// ── Auth middleware (same pattern used in photos.ts) ───────────────────────────
function requireAuth(req: any, res: any, next: any) {
  const user = (req as Record<string, unknown>).user as Record<string, string> | undefined;
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  req.currentUser = { ...user, id: user.id || user.sub };
  next();
}

router.use(requireAuth);

// ── GET /videos/music-tracks ──────────────────────────────────────────────────
router.get("/videos/music-tracks", (_req, res) => {
  const tracks = MUSIC_TRACKS.map(({ id, name, genre }) => ({ id, name, genre }));
  res.json({ tracks });
});

// ── POST /videos/memory ───────────────────────────────────────────────────────
router.post("/videos/memory", async (req: any, res) => {
  const userId: string = req.currentUser.id;

  const { photoIds, musicTrackId } = req.body as {
    photoIds?: unknown;
    musicTrackId?: unknown;
  };

  // Validate photoIds
  if (
    !Array.isArray(photoIds) ||
    photoIds.length < MIN_PHOTOS ||
    photoIds.length > MAX_PHOTOS ||
    !photoIds.every((id) => typeof id === "string" && id.trim().length > 0)
  ) {
    return res.status(400).json({
      error: `photoIds must be an array of ${MIN_PHOTOS}–${MAX_PHOTOS} non-empty strings`,
    });
  }

  // Validate musicTrackId
  const track = findTrack(typeof musicTrackId === "string" ? musicTrackId : "");
  if (!track) {
    return res.status(400).json({
      error: `Invalid musicTrackId. Valid values: ${MUSIC_TRACKS.map((t) => t.id).join(", ")}`,
    });
  }

  // Verify all photos belong to the requesting user (prevents IDOR)
  const rows = await db
    .select({ id: photosTable.id, previewBlobName: photosTable.previewBlobName })
    .from(photosTable)
    .where(
      and(
        eq(photosTable.userId, userId),
        eq(photosTable.trashed, false),
        inArray(photosTable.id, photoIds as string[]),
      ),
    );

  if (rows.length !== photoIds.length) {
    return res.status(403).json({
      error: "One or more photos do not belong to your account or have been trashed",
    });
  }

  // Preserve the order requested by the user
  const orderedRows = (photoIds as string[]).map(
    (id) => rows.find((r) => r.id === id)!,
  );

  const previewBlobNames = orderedRows
    .map((r) => r.previewBlobName)
    .filter((b): b is string => !!b);

  if (previewBlobNames.length !== orderedRows.length) {
    return res.status(422).json({
      error: "Some photos are still being processed and do not yet have a preview. Please try again shortly.",
    });
  }

  // Create job and kick off async generation (do NOT await)
  const jobId = randomUUID();
  createJob(jobId, userId);

  generateVideoInBackground(jobId, previewBlobNames, track.filePath);

  res.status(202).json({ jobId });
});

// ── GET /videos/memory/:jobId ─────────────────────────────────────────────────
router.get("/videos/memory/:jobId", (req: any, res) => {
  const userId: string = req.currentUser.id;
  const { jobId } = req.params as { jobId: string };

  const job = getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }

  // Prevent cross-user access to another user's job
  if (job.userId !== userId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  res.json({
    jobId: job.jobId,
    status: job.status,
    videoUrl: job.videoUrl ?? null,
    error: job.errorMessage ?? null,
  });
});

// ── Background generation (fire and forget) ───────────────────────────────────
function generateVideoInBackground(
  jobId: string,
  previewBlobNames: string[],
  musicFilePath: string,
): void {
  updateJob(jobId, { status: "processing" });

  generateMemoryVideo({ previewBlobNames, musicFilePath, jobId })
    .then((videoUrl) => {
      updateJob(jobId, { status: "complete", videoUrl });
      logger.info({ jobId }, "Video job completed");
    })
    .catch((err: Error) => {
      logger.error({ jobId, err: err.message }, "Video job failed");
      updateJob(jobId, {
        status: "error",
        errorMessage: "Video generation failed. Please try again.",
      });
    });
}

export default router;
