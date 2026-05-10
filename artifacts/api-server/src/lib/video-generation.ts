/**
 * Memory video generation using ffmpeg.
 *
 * Builds a 1080×1080 H.264/AAC MP4 slideshow from a list of photos:
 *   • Ken Burns slow zoom (1.0 → 1.08) on each image via `zoompan`
 *   • Cross-fade transitions between images via `xfade`
 *   • Background music trimmed with `-shortest`
 *
 * Workflow:
 *   1. Download each photo's preview blob to a local temp directory
 *   2. Run ffmpeg with complex filter graph
 *   3. Upload resulting MP4 to Azure Blob Storage (videos/ prefix)
 *   4. Return a 7-day SAS / CDN URL for the video
 *   5. Clean up temp directory
 */

import ffmpeg from "fluent-ffmpeg";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import { downloadBlob, getContainerClient } from "./azure-storage.js";
import { logger } from "./logger.js";

const OUTPUT_SIZE = 1080;           // square 1080×1080
const FRAME_RATE = 25;              // fps
const SLIDE_DURATION = 4;           // seconds each image is shown
const TRANSITION_DURATION = 0.7;    // seconds for xfade cross-fade overlap
const VIDEO_SAS_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface GenerateVideoOptions {
  /** Array of `previewBlobName` values from the photos table (ordered) */
  previewBlobNames: string[];
  /** Absolute path to the MP3 file to use as background audio */
  musicFilePath: string;
  /** Unique job identifier (used for temp dir + output blob name) */
  jobId: string;
}

/**
 * Generates the video and uploads it to Azure Blob Storage.
 * Returns the shareable URL (7-day SAS or CDN depending on environment).
 */
export async function generateMemoryVideo(opts: GenerateVideoOptions): Promise<string> {
  const { previewBlobNames, musicFilePath, jobId } = opts;
  const tempDir = path.join(os.tmpdir(), `memory-video-${jobId}`);
  const outputPath = path.join(tempDir, "output.mp4");

  try {
    await fs.mkdir(tempDir, { recursive: true });

    // ── 1. Download preview blobs ──────────────────────────────────────────
    logger.info({ jobId, count: previewBlobNames.length }, "Downloading photo blobs for video");
    const imagePaths: string[] = [];

    for (let i = 0; i < previewBlobNames.length; i++) {
      const blobName = previewBlobNames[i];
      // Derive a safe local extension — default to .jpg for all image previews
      const ext = path.extname(blobName) || ".jpg";
      const localPath = path.join(tempDir, `frame_${String(i).padStart(3, "0")}${ext}`);
      const data = await downloadBlob(blobName);
      await fs.writeFile(localPath, data);
      imagePaths.push(localPath);
    }

    // ── 2. Build ffmpeg filter graph ───────────────────────────────────────
    logger.info({ jobId }, "Starting ffmpeg video synthesis");

    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg();

      // Add each image as a looped input for SLIDE_DURATION seconds
      // zoompan requires a stream long enough to animate, so we loop the image
      for (const imgPath of imagePaths) {
        cmd.input(imgPath).inputOptions([
          `-loop 1`,
          `-t ${SLIDE_DURATION}`,
          `-framerate ${FRAME_RATE}`,
        ]);
      }

      // Add music track
      cmd.input(musicFilePath);

      const n = imagePaths.length;

      // Build complex filter graph
      // Each image: scale to fill 1080×1080 (cover), then Ken Burns zoom
      const filterParts: string[] = [];

      // Scale + pad each image to exactly OUTPUT_SIZE×OUTPUT_SIZE (cover crop)
      for (let i = 0; i < n; i++) {
        filterParts.push(
          `[${i}:v]` +
          `scale=${OUTPUT_SIZE}:${OUTPUT_SIZE}:force_original_aspect_ratio=increase,` +
          `crop=${OUTPUT_SIZE}:${OUTPUT_SIZE},` +
          `fps=${FRAME_RATE},` +
          // Ken Burns: slow zoom from 1.0 to 1.08 over SLIDE_DURATION seconds
          // zoompan: zoom=z+0.0008 increments per frame at 25fps ≈ 0.02 over 4s (≈ 2% zoom)
          `zoompan=z='min(zoom+0.0005,1.08)':d=${SLIDE_DURATION * FRAME_RATE}:s=${OUTPUT_SIZE}x${OUTPUT_SIZE}:fps=${FRAME_RATE}` +
          `[v${i}]`,
        );
      }

      // Chain xfade transitions between consecutive processed streams
      if (n === 1) {
        // Single image — just use it directly
        filterParts.push(`[v0]copy[vout]`);
      } else {
        // xfade: each clip overlaps the next by TRANSITION_DURATION seconds
        // The offset (when transition starts) = accumulated slide time - transition overlap
        let currentLabel = `v0`;
        for (let i = 1; i < n; i++) {
          const offset = i * (SLIDE_DURATION - TRANSITION_DURATION);
          const outLabel = i === n - 1 ? "vout" : `xf${i}`;
          filterParts.push(
            `[${currentLabel}][v${i}]` +
            `xfade=transition=fade:duration=${TRANSITION_DURATION}:offset=${offset}` +
            `[${outLabel}]`,
          );
          currentLabel = outLabel;
        }
      }

      const complexFilter = filterParts.join(";");

      cmd
        .complexFilter(complexFilter, "vout")
        .audioInput(`${n}:a`)      // pick up the music input (last input = index n)
        .outputOptions([
          `-c:v libx264`,
          `-preset fast`,
          `-crf 22`,
          `-pix_fmt yuv420p`,      // broad compatibility (Safari, WhatsApp, etc.)
          `-c:a aac`,
          `-b:a 128k`,
          `-shortest`,             // trim audio/video to the shorter of the two
          `-movflags +faststart`,  // place moov atom at start for streaming
          `-map [vout]`,
          `-map ${n}:a`,
        ])
        .output(outputPath)
        .on("start", (cmd) => logger.debug({ jobId, cmd }, "ffmpeg started"))
        .on("progress", (p) => logger.debug({ jobId, percent: p.percent }, "ffmpeg progress"))
        .on("end", () => resolve())
        .on("error", (err) => reject(err))
        .run();
    });

    // ── 3. Upload to Azure Blob Storage ────────────────────────────────────
    logger.info({ jobId }, "Uploading generated video to Azure Blob Storage");
    const videoBlobName = `videos/${jobId}.mp4`;
    const videoBuffer = await fs.readFile(outputPath);
    const containerClient = getContainerClient();
    const blockBlobClient = containerClient.getBlockBlobClient(videoBlobName);
    await blockBlobClient.uploadData(videoBuffer, {
      blobHTTPHeaders: {
        blobContentType: "video/mp4",
        blobCacheControl: "public, max-age=604800", // 7 days
      },
    });

    // ── 4. Generate a 7-day SAS URL ────────────────────────────────────────
    const videoUrl = await generateVideoSasUrl(videoBlobName, VIDEO_SAS_TTL_SECONDS);
    logger.info({ jobId, videoUrl }, "Video generation complete");
    return videoUrl;

  } finally {
    // ── 5. Clean up temp directory ─────────────────────────────────────────
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Non-fatal — temp cleanup failure should not mask a successful upload
    }
  }
}

/**
 * Generates a time-limited SAS URL for a private video blob.
 * Unlike photo CDN URLs (public read), video blobs use SAS for time-limited access.
 */
async function generateVideoSasUrl(blobName: string, ttlSeconds: number): Promise<string> {
  if (process.env.NODE_ENV !== "production") {
    return `/api/blobs/${blobName}`;
  }

  const {
    generateBlobSASQueryParameters,
    BlobSASPermissions,
  } = await import("@azure/storage-blob");
  const { ManagedIdentityCredential } = await import("@azure/identity");

  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;
  const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME!;

  const credential = new ManagedIdentityCredential();
  const { BlobServiceClient } = await import("@azure/storage-blob");
  const client = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential,
  );

  const startsOn = new Date();
  const expiresOn = new Date(startsOn.getTime() + ttlSeconds * 1000);
  const userDelegationKey = await client.getUserDelegationKey(startsOn, expiresOn);

  const sasParams = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"), // read-only
      startsOn,
      expiresOn,
    },
    userDelegationKey,
    accountName,
  );

  return `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasParams.toString()}`;
}
