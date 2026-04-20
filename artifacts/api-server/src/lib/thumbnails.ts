/**
 * Thumbnail generation using sharp (images) and ffmpeg (videos).
 * Generates three variants for every uploaded photo/video:
 *   thumb/   — 600×600px JPEG cover crop (for grid, ~50-80KB)
 *   thumbw/  — 600×600px WebP cover crop (for modern browsers, ~30-50KB)
 *   preview/ — 1920px wide JPEG (for lightbox, ~300-500KB)
 * Also extracts a 64×64 LQIP and the dominant colour (hex).
 */

import sharp from "sharp";
import path from "path";
import { spawn } from "child_process";
import { uploadBlob } from "./azure-storage.js";

const THUMB_SIZE = 300;
const PREVIEW_WIDTH = 1920;
const LQIP_SIZE = 64;

export interface ThumbnailResult {
  thumbBlobName: string;
  thumbWebpBlobName: string;
  previewBlobName: string;
  lqipData: string;    // base64 data URL of 64×64 blurred placeholder (~1.2KB)
  dominantColor: string; // hex e.g. "#a3b2c1"
  width: number;
  height: number;
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
    ff.stdin.on("error", () => {}); // suppress EPIPE when ffmpeg exits before stdin is fully written

    ff.stdin.write(videoBuffer);
    ff.stdin.end();
  });
}

/** Resize a JPEG/image buffer into thumb + WebP thumb + preview and upload all to blob storage. */
async function resizeAndUpload(
  imageBuffer: Buffer,
  thumbBlobName: string,
  previewBlobName: string,
): Promise<ThumbnailResult | null> {
  try {
    const sharpInstance = sharp(imageBuffer, { failOn: "none" }).rotate();

    const [
      { data: thumbBuf, info: thumbInfo },
      thumbWebpBuf,
      previewBuf,
      lqipBuf,
      { data: dominantRaw },
    ] = await Promise.all([
      sharpInstance
        .clone()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: "cover", position: "attention" })
        .jpeg({ quality: 82, mozjpeg: true, progressive: true })
        .toBuffer({ resolveWithObject: true }),
      sharpInstance
        .clone()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: "cover", position: "attention" })
        .webp({ quality: 80 })
        .toBuffer(),
      sharpInstance
        .clone()
        .resize(PREVIEW_WIDTH, undefined, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 88, mozjpeg: true, progressive: true })
        .toBuffer(),
      sharpInstance
        .clone()
        .resize(LQIP_SIZE, LQIP_SIZE, { fit: "cover", position: "attention" })
        .blur(4)
        .jpeg({ quality: 40 })
        .toBuffer(),
      sharpInstance
        .clone()
        .resize(1, 1, { fit: "cover" })
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);

    // Derive WebP blob name from the JPEG blob name
    const thumbWebpBlobName = thumbBlobName.replace(/\.jpg$/, ".webp");

    await Promise.all([
      uploadBlob(thumbBlobName, thumbBuf, "image/jpeg"),
      uploadBlob(thumbWebpBlobName, thumbWebpBuf, "image/webp"),
      uploadBlob(previewBlobName, previewBuf, "image/jpeg"),
    ]);

    const lqipData = `data:image/jpeg;base64,${lqipBuf.toString("base64")}`;

    // dominantRaw is a 3-byte RGB buffer from the 1×1 raw resize
    const r = dominantRaw[0].toString(16).padStart(2, "0");
    const g = dominantRaw[1].toString(16).padStart(2, "0");
    const b = dominantRaw[2].toString(16).padStart(2, "0");
    const dominantColor = `#${r}${g}${b}`;

    return {
      thumbBlobName,
      thumbWebpBlobName,
      previewBlobName,
      lqipData,
      dominantColor,
      width: thumbInfo.width,
      height: thumbInfo.height,
    };
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
