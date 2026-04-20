/**
 * Face recognition service using @vladmandic/face-api (fully local — no cloud approval needed).
 *
 * Strategy
 * ────────
 * • Load SSD MobileNet + Landmark + Recognition models once at startup.
 * • On every image upload, detect faces and extract 128-D descriptors.
 * • Compare each descriptor against every stored descriptor for the user (Euclidean distance).
 * • If distance < SIMILARITY_THRESHOLD → assign to matching person.
 * • Otherwise → create a new person row.
 * • Everything runs async / fire-and-forget so upload latency is unaffected.
 */

import { randomUUID } from "crypto";
import path from "path";
import { db, peopleTable, photoFacesTable, photosTable } from "@workspace/db";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { uploadBlob, downloadBlob } from "./azure-storage.js";

// Native modules loaded lazily so the server starts even if canvas.node is missing
let createCanvas: any;
let loadImage: any;
let CanvasImage: any;
let faceapi: any;

// ── Config ────────────────────────────────────────────────────────────────────

/** Lower = stricter matching. 0.5 works well for most photos. */
const SIMILARITY_THRESHOLD = parseFloat(process.env.FACE_SIMILARITY_THRESHOLD ?? "0.5");

const MODEL_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../node_modules/@vladmandic/face-api/model",
);

// ── Model loading (once per process) ─────────────────────────────────────────

let _loadPromise: Promise<void> | null = null;

function ensureModels(): Promise<void> {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    // Dynamically import native modules so the server starts even if canvas.node is missing.
    // If any import fails, the error propagates to runFaceRecognitionJob() which logs and swallows it.
    const canvasMod = await import("canvas");
    createCanvas = canvasMod.createCanvas;
    loadImage = canvasMod.loadImage;
    CanvasImage = canvasMod.Image;
    // face-api's env monkeyPatch needs the Canvas CLASS (not the factory function)
    // so that its instanceof checks work correctly when calling toNetInput.
    const CanvasClass = (canvasMod as any).Canvas;

    // Important: load face-api BEFORE @tensorflow/tfjs-node.
    // face-api loads @tensorflow/tfjs (pure-JS) as its peer dep; loading tfjs-node
    // first causes a TF version conflict that crashes the process.
    const faceapiMod = await import("@vladmandic/face-api");
    faceapi = (faceapiMod as any).default ?? faceapiMod;

    // Override the pure-JS backend with the faster native binding.
    await import("@tensorflow/tfjs-node");

    // face-api.js needs a canvas environment in Node
    (global as any).HTMLVideoElement = class {};
    faceapi.env.monkeyPatch({ Canvas: CanvasClass, Image: CanvasImage });
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_PATH),
      faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_PATH),
      faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_PATH),
    ]);
  })().catch((err) => {
    // Reset so a later retry can try again (e.g. after a deploy that adds canvas)
    _loadPromise = null;
    throw err;
  });
  return _loadPromise;
}

// ── Detection ─────────────────────────────────────────────────────────────────

interface FaceResult {
  descriptor: Float32Array;
  box: { x: number; y: number; width: number; height: number };
  imageWidth: number;
  imageHeight: number;
}

/** Max dimension used for face detection — keeps CPU/memory low while preserving accuracy. */
const MAX_DETECT_DIM = 800;

async function detectFacesInBuffer(buffer: Buffer): Promise<FaceResult[]> {
  const orig = await loadImage(buffer);

  // Downscale to MAX_DETECT_DIM for detection (thumbnail approach)
  const scale = Math.min(1, MAX_DETECT_DIM / Math.max(orig.width, orig.height));
  const w = Math.round(orig.width * scale);
  const h = Math.round(orig.height * scale);

  const canvas = createCanvas(w, h);
  canvas.getContext("2d").drawImage(orig, 0, 0, w, h);

  const detections = await faceapi
    .detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  // Scale bounding boxes back to original image coordinate space
  return detections.map((d) => ({
    descriptor: d.descriptor,
    box: {
      x: d.detection.box.x / scale,
      y: d.detection.box.y / scale,
      width: d.detection.box.width / scale,
      height: d.detection.box.height / scale,
    },
    imageWidth: orig.width,
    imageHeight: orig.height,
  }));
}

// ── Descriptor storage (DB as vector store) ───────────────────────────────────

/** Stored as comma-separated floats in the azurePersistedFaceId column (repurposed). */
function serializeDescriptor(d: Float32Array): string {
  return Array.from(d).join(",");
}

function deserializeDescriptor(s: string): Float32Array {
  return new Float32Array(s.split(",").map(Number));
}

// ── Face crop & thumbnail upload ──────────────────────────────────────────────

async function cropFaceToBlob(
  buffer: Buffer,
  box: { x: number; y: number; width: number; height: number },
  userId: string,
): Promise<string | null> {
  try {
    const img = await loadImage(buffer);
    const pad = Math.round(box.width * 0.2);
    const sx = Math.max(0, box.x - pad);
    const sy = Math.max(0, box.y - pad);
    const sw = Math.min(img.width - sx, box.width + pad * 2);
    const sh = Math.min(img.height - sy, box.height + pad * 2);

    const thumb = createCanvas(sw, sh);
    thumb.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

    const thumbBuffer = thumb.toBuffer("image/jpeg", { quality: 0.85 });
    const blobName = `${userId}/faces/${randomUUID()}.jpg`;
    await uploadBlob(blobName, thumbBuffer, "image/jpeg");
    return blobName;
  } catch {
    return null;
  }
}

// ── Clustering ────────────────────────────────────────────────────────────────

async function findOrCreatePerson(
  userId: string,
  descriptor: Float32Array,
  box: FaceResult["box"],
  photoBuffer: Buffer,
): Promise<string> {
  // Load all stored descriptors for this user that are linked to a person
  const existingFaces = await db
    .select({
      personId: photoFacesTable.personId,
      descriptorStr: photoFacesTable.azurePersistedFaceId,
    })
    .from(photoFacesTable)
    .where(and(eq(photoFacesTable.userId, userId), isNotNull(photoFacesTable.personId)))
    .limit(1000);

  // Find best match by Euclidean distance
  let bestPersonId: string | null = null;
  let bestDist = Infinity;

  for (const face of existingFaces) {
    if (!face.descriptorStr || !face.personId) continue;
    try {
      const stored = deserializeDescriptor(face.descriptorStr);
      const dist = faceapi.euclideanDistance(descriptor, stored);
      if (dist < bestDist) {
        bestDist = dist;
        bestPersonId = face.personId;
      }
    } catch { /* malformed record — skip */ }
  }

  if (bestPersonId && bestDist <= SIMILARITY_THRESHOLD) {
    return bestPersonId;
  }

  // No match → create new person
  const [newPerson] = await db
    .insert(peopleTable)
    .values({ userId })
    .returning();

  // Upload face crop as cover image
  const coverBlob = await cropFaceToBlob(photoBuffer, box, userId);
  if (coverBlob) {
    await db
      .update(peopleTable)
      .set({ coverFaceBlob: coverBlob })
      .where(eq(peopleTable.id, newPerson.id));
  }

  return newPerson.id;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Detect and cluster faces for a single photo given its buffer.
 * Called by the background job — not during upload.
 */
export async function processFacesForPhoto(
  photoId: string,
  userId: string,
  blobName: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  if (!contentType.startsWith("image/")) return;

  try {
    await ensureModels();
    const faces = await detectFacesInBuffer(buffer);

    if (faces.length === 0) {
      // Insert a sentinel so this photo is skipped in future scans (avoids
      // re-processing photos that genuinely have no detectable faces).
      await db.insert(photoFacesTable).values({
        photoId,
        userId,
        personId: null,
        azurePersistedFaceId: null,
        boundingBox: null,
      }).onConflictDoNothing();
      return;
    }

    for (const face of faces) {
      const personId = await findOrCreatePerson(userId, face.descriptor, face.box, buffer);

      const boundingBox = JSON.stringify({
        top: face.box.y / face.imageHeight,
        left: face.box.x / face.imageWidth,
        width: face.box.width / face.imageWidth,
        height: face.box.height / face.imageHeight,
      });

      // Store descriptor in azurePersistedFaceId column (repurposed as vector store)
      await db.insert(photoFacesTable).values({
        photoId,
        userId,
        personId,
        azurePersistedFaceId: serializeDescriptor(face.descriptor),
        boundingBox,
      });
    }
  } catch (err) {
    console.error("[face-recognition] processFacesForPhoto error:", err);
  }
}

// ── Background hourly job ─────────────────────────────────────────────────────

let _jobRunning = false;
let _jobTotal = 0;
let _jobProcessed = 0;

/** Returns the current face-scan job progress (in-process only). */
export function getJobProgress(): { running: boolean; processed: number; total: number } {
  return { running: _jobRunning, processed: _jobProcessed, total: _jobTotal };
}

/**
 * Scans all unprocessed images (no photo_faces entry) and runs face detection.
 * Safe to call repeatedly — skips already-processed photos and is non-reentrant.
 */
export async function runFaceRecognitionJob(): Promise<void> {
  if (_jobRunning) return;
  _jobRunning = true;
  _jobProcessed = 0;
  _jobTotal = 0;
  try {
    // Find image photos that have never been through face detection
    const rows = await db.execute(
      sql`SELECT p.id, p.user_id, p.blob_name, p.content_type
          FROM photos p
          WHERE p.trashed = false
            AND p.content_type NOT LIKE 'video/%'
            AND NOT EXISTS (
              SELECT 1 FROM photo_faces pf WHERE pf.photo_id = p.id
            )
          ORDER BY p.uploaded_at DESC
          LIMIT 5000`,
    );
    const photos = (rows as any).rows ?? [];
    if (photos.length === 0) return;

    _jobTotal = photos.length;
    console.log(`[face-recognition] job: processing ${photos.length} unprocessed photo(s)`);
    await ensureModels();

    for (const photo of photos) {
      try {
        const buf = await downloadBlob(photo.blob_name);
        await processFacesForPhoto(photo.id, photo.user_id, photo.blob_name, buf, photo.content_type);
      } catch (err) {
        console.error(`[face-recognition] job: error on ${photo.id}:`, err);
      }
      _jobProcessed++;
    }
    console.log(`[face-recognition] job: done`);
  } catch (err) {
    console.error("[face-recognition] job error:", err);
  } finally {
    _jobRunning = false;
  }
}
