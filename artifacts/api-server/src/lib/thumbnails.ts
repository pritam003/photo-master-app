/**
 * Thumbnail generation using sharp (images) and ffmpeg (videos).
 * Generates two variants for every uploaded photo/video:
 *   thumb/   — 600×600px JPEG cover crop (for grid, ~50-80KB)
 *   preview/ — 1920px wide JPEG (for lightbox, ~300-500KB)
 */

import sharp from "sharp";
import path from "path";
import { spawn } from "child_process";
import { uploadBlob } from "./azure-storage.js";

const THUMB_SIZE = 600;
const PREVIEW_WIDTH = 1920;

export interface ThumbnailResult {
  thumbBlobName: string;
  previewBlobName: string;
}

/** Extract the first representative frame from a video buffer via ffmpeg.
 *  Returns a JPEG buffer, or null if ffmpeg is unavailable or the video can't be decoded. */
async function extractVideoFrame(videoBuffer: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-ss", "0.1",       // seek 100ms in (handles very short clips too)
      "-vframes", "1",    // extract exactly 1 frame
      "-f", "image2",
      "-vcodec", "mjpeg",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    ff.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ff.on("close", (code) => resolve(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null));
    ff.on("error", () => resolve(null)); // ffmpeg not installed — graceful fallback

    ff.stdin.write(videoBuffer);
    ff.stdin.end();
  });
}

/** Resize a JPEG/image buffer into thumb + preview and upload both to blob storage. */
async function resizeAndUpload(
  imageBuffer: Buffer,
  thumbBlobName: string,
  previewBlobName: string,
): Promise<ThumbnailResult | null> {
  try {
    const sharpInstance = sharp(imageBuffer, { failOn: "none" }).rotate();

    const [thumbBuf, previewBuf] = await Promise.all([
      sharpInstance
        .clone()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: "cover", position: "centre" })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer(),
      sharpInstance
        .clone()
        .resize(PREVIEW_WIDTH, undefined, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer(),
    ]);

    await Promise.all([
      uploadBlob(thumbBlobName, thumbBuf, "image/jpeg"),
      uploadBlob(previewBlobName, previewBuf, "image/jpeg"),
    ]);

    return { thumbBlobName, previewBlobName };
  } catch (err) {
    console.error("[thumbnails] resize/upload failed:", err);
    return null;
  }
}

/**
 * Generate thumb + preview from an image buffer and upload both to blob storage.
 * Returns null for videos or on error (callers fall back to original URL).
 */
export async function generateThumbnails(
  buffer: Buffer,
  originalBlobName: string,
  contentType: string,
): Promise<ThumbnailResult | null> {
  if (!contentType.startsWith("image/")) return null;

  const dir = path.dirname(originalBlobName);
  const base = path.basename(originalBlobName, path.extname(originalBlobName));

  return resizeAndUpload(
    buffer,
    `${dir}/thumb_${base}.jpg`,
    `${dir}/preview_${base}.jpg`,
  );
}

/**
 * Generate thumb + preview from a video buffer by extracting the first frame via ffmpeg.
 * Returns null if ffmpeg is unavailable or frame extraction fails.
 */
export async function generateVideoThumbnails(
  buffer: Buffer,
  originalBlobName: string,
): Promise<ThumbnailResult | null> {
  try {
    const frameBuffer = await extractVideoFrame(buffer);
    if (!frameBuffer) return null;

    const dir = path.dirname(originalBlobName);
    const base = path.basename(originalBlobName, path.extname(originalBlobName));

    return resizeAndUpload(
      frameBuffer,
      `${dir}/thumb_${base}.jpg`,
      `${dir}/preview_${base}.jpg`,
    );
  } catch (err) {
    console.error("[thumbnails] video thumbnail generation failed:", err);
    return null;
  }
}
