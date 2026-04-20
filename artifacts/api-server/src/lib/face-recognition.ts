/**
 * Face detection via Azure Face API (detection_01, no approval required) +
 * local face grouping via 24×24 grayscale cosine-similarity descriptors (sharp).
 *
 * Strategy:
 * • Azure Face API detects face bounding boxes (detection_01 — no Limited Access
 *   approval; returnFaceId=false so no recognition model is used).
 * • For each detected face: crop with sharp → resize to 24×24 grayscale →
 *   mean-centred pixel vector → cosine similarity against all existing person
 *   descriptors for this user.
 * • Similarity ≥ SIMILARITY_THRESHOLD → assign to existing person.
 * • No match → create new person + store descriptor.
 * • Descriptors are serialised as comma-separated floats in the
 *   azure_persisted_face_id column (repurposed as a lightweight vector store).
 */

import { randomUUID } from "crypto";
import { db, peopleTable, photoFacesTable } from "@workspace/db";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { uploadBlob, downloadBlob } from "./azure-storage.js";

// ── Config ────────────────────────────────────────────────────────────────────

const FACE_ENDPOINT = (process.env.AZURE_FACE_ENDPOINT ?? "").replace(/\/$/, "");
const FACE_KEY = process.env.AZURE_FACE_KEY ?? "";

/** ~6 req/s — safely under the S0 10 TPS rate limit. */
const THROTTLE_MS = 160;

function hasFaceApi(): boolean {
  return !!FACE_ENDPOINT && !!FACE_KEY;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Azure Face API helpers ────────────────────────────────────────────────────

async function faceReqBinary(path: string, buffer: Buffer): Promise<Response> {
  // Azure Face API binary upload requires application/octet-stream (not image/jpeg etc.)
  return fetch(`${FACE_ENDPOINT}/face/v1.0${path}`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": FACE_KEY, "Content-Type": "application/octet-stream" },
    body: buffer,
  });
}

/**
 * Detect faces using detection_01 (basic bounding-box detection, no recognition
 * model, no Identification/Verification features → no approval required).
 * Returns null on persistent 429 (caller should skip without inserting sentinel).
 */
async function detectFaces(buffer: Buffer): Promise<any[] | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await faceReqBinary(
      "/detect?detectionModel=detection_01&returnFaceId=false",
      buffer,
    );
    if (res.ok) return res.json();
    if (res.status === 429) {
      await sleep(2000 * (attempt + 1)); // 2s → 4s → 6s back-off
      continue;
    }
    const errText = await res.text();
    console.warn("[face-recognition] detect failed:", errText.slice(0, 300));
    return [];
  }
  // Exhausted retries on 429 — skip this photo for now (no sentinel inserted)
  return null;
}

// ── Local face descriptor (no ML model required) ─────────────────────────────

/** Dimensions of the descriptor vector: 24 × 24 grayscale pixels = 576 floats. */
const DESCRIPTOR_DIM = 576;

/** Cosine similarity threshold for same-person matching (0–1, higher = stricter). */
const SIMILARITY_THRESHOLD = parseFloat(process.env.FACE_SIMILARITY_THRESHOLD ?? "0.82");

interface FaceRect { top: number; left: number; width: number; height: number }

/**
 * Crop the face region, resize to 24×24 grayscale, mean-centre the pixel values.
 * Returns a Float32Array descriptor, or null on error.
 */
async function computeDescriptor(buffer: Buffer, rect: FaceRect): Promise<Float32Array | null> {
  try {
    const { default: sharp } = await import("sharp");
    const pad = Math.round(Math.max(rect.width, rect.height) * 0.3);
    const meta = await sharp(buffer).metadata();
    const W = meta.width ?? 99999;
    const H = meta.height ?? 99999;
    const cropLeft = Math.max(0, rect.left - pad);
    const cropTop  = Math.max(0, rect.top  - pad);
    const cropW    = Math.min(W - cropLeft, rect.width  + pad * 2);
    const cropH    = Math.min(H - cropTop,  rect.height + pad * 2);
    if (cropW < 4 || cropH < 4) return null;

    const raw = await sharp(buffer)
      .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
      .resize(24, 24)
      .grayscale()
      .raw()
      .toBuffer();

    const desc = new Float32Array(DESCRIPTOR_DIM);
    let mean = 0;
    for (let i = 0; i < DESCRIPTOR_DIM; i++) { desc[i] = raw[i] / 255; mean += desc[i]; }
    mean /= DESCRIPTOR_DIM;
    for (let i = 0; i < DESCRIPTOR_DIM; i++) desc[i] -= mean;
    return desc;
  } catch {
    return null;
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function serializeDescriptor(d: Float32Array): string {
  return Array.from(d).join(",");
}

function deserializeDescriptor(s: string): Float32Array {
  return new Float32Array(s.split(",").map(Number));
}

// ── Per-photo processing ──────────────────────────────────────────────────────

async function processFacesForPhotoAzure(
  photoId: string,
  userId: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  if (!contentType.startsWith("image/")) return;

  // Throttle to stay under S0 rate limit
  await sleep(THROTTLE_MS);

  const faces = await detectFaces(buffer);

  if (faces === null) {
    // 429 exhausted — don't insert sentinel, retry next scan run
    return;
  }

  if (faces.length === 0) {
    // Genuinely no faces → sentinel so this photo is skipped in future scans
    await db.insert(photoFacesTable).values({
      photoId, userId, personId: null, azurePersistedFaceId: null, boundingBox: null,
    }).onConflictDoNothing();
    return;
  }

  // Load one descriptor per existing person for this user (for similarity matching)
  const existingRows = await db
    .select({ personId: photoFacesTable.personId, descriptorStr: photoFacesTable.azurePersistedFaceId })
    .from(photoFacesTable)
    .where(and(eq(photoFacesTable.userId, userId), isNotNull(photoFacesTable.personId), isNotNull(photoFacesTable.azurePersistedFaceId)));

  // One representative descriptor per person (first one found)
  const personDescriptors = new Map<string, Float32Array>();
  for (const row of existingRows) {
    if (!row.personId || !row.descriptorStr) continue;
    if (!personDescriptors.has(row.personId)) {
      try { personDescriptors.set(row.personId, deserializeDescriptor(row.descriptorStr)); } catch { /* malformed */ }
    }
  }

  for (const face of faces) {
    const { top, left, width, height } = face.faceRectangle;
    const rect: FaceRect = { top, left, width, height };
    const descriptor = await computeDescriptor(buffer, rect);

    // Try to match against an existing person
    let personId: string | null = null;
    if (descriptor) {
      let bestSim = -1;
      let bestPersonId: string | null = null;
      for (const [pid, existing] of personDescriptors) {
        const sim = cosineSimilarity(descriptor, existing);
        if (sim > bestSim) { bestSim = sim; bestPersonId = pid; }
      }
      if (bestSim >= SIMILARITY_THRESHOLD && bestPersonId) {
        personId = bestPersonId;
        console.log(`[face-recognition] matched person ${personId} (sim=${bestSim.toFixed(3)})`);
      }
    }

    if (!personId) {
      // No match — create new person
      const [newPerson] = await db.insert(peopleTable).values({ userId }).returning();
      personId = newPerson.id;

      // Crop & upload face thumbnail as person cover image
      try {
        const { default: sharp } = await import("sharp");
        const pad = Math.round(Math.max(width, height) * 0.4);
        const meta = await sharp(buffer).metadata();
        const crop = {
          left: Math.max(0, left - pad),
          top: Math.max(0, top - pad),
          width: Math.min((meta.width ?? 9999) - Math.max(0, left - pad), width + pad * 2),
          height: Math.min((meta.height ?? 9999) - Math.max(0, top - pad), height + pad * 2),
        };
        const thumbBuf = await sharp(buffer).extract(crop)
          .resize(256, 256, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
        const blobName = `${userId}/faces/${randomUUID()}.jpg`;
        await uploadBlob(blobName, thumbBuf, "image/jpeg");
        await db.update(peopleTable).set({ coverFaceBlob: blobName }).where(eq(peopleTable.id, personId));
      } catch { /* non-fatal — person still created */ }

      if (descriptor) personDescriptors.set(personId, descriptor);
    }

    const boundingBox = JSON.stringify({ top, left, width, height });
    const descriptorStr = descriptor ? serializeDescriptor(descriptor) : null;
    await db.insert(photoFacesTable).values({
      photoId, userId, personId, azurePersistedFaceId: descriptorStr, boundingBox,
    }).onConflictDoNothing();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function processFacesForPhoto(
  photoId: string,
  userId: string,
  blobName: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  if (!hasFaceApi()) return;
  try {
    await processFacesForPhotoAzure(photoId, userId, buffer, contentType);
  } catch (err) {
    console.error("[face-recognition] processFacesForPhoto error:", err);
  }
}

// ── Background scan job ───────────────────────────────────────────────────────

let _jobRunning = false;
let _jobTotal = 0;
let _jobProcessed = 0;

export function getJobProgress(): { running: boolean; processed: number; total: number } {
  return { running: _jobRunning, processed: _jobProcessed, total: _jobTotal };
}

/**
 * Scan all unprocessed images and run face detection.
 * Non-reentrant — safe to call repeatedly.
 */
export async function runFaceRecognitionJob(): Promise<void> {
  if (_jobRunning) return;
  if (!hasFaceApi()) {
    console.warn("[face-recognition] AZURE_FACE_ENDPOINT or AZURE_FACE_KEY not set — skipping");
    return;
  }
  _jobRunning = true;
  _jobProcessed = 0;
  _jobTotal = 0;
  try {
    const rows = await db.execute(
      sql`SELECT p.id, p.user_id, p.blob_name, p.content_type
          FROM photos p
          WHERE p.trashed = false
            AND p.content_type LIKE 'image/%'
            AND NOT EXISTS (SELECT 1 FROM photo_faces pf WHERE pf.photo_id = p.id)
          ORDER BY p.uploaded_at DESC
          LIMIT 5000`,
    );
    const photos = (rows as any).rows ?? [];
    if (photos.length === 0) {
      console.log("[face-recognition] job: no unprocessed photos");
      return;
    }

    _jobTotal = photos.length;
    console.log(`[face-recognition] job: processing ${photos.length} unprocessed photo(s)`);

    for (const photo of photos) {
      try {
        const buf = await downloadBlob(photo.blob_name);
        await processFacesForPhoto(photo.id, photo.user_id, photo.blob_name, buf, photo.content_type);
      } catch (err) {
        console.error(`[face-recognition] job: error on ${photo.id}:`, err);
      }
      _jobProcessed++;
    }
    console.log("[face-recognition] job: done");
  } catch (err) {
    console.error("[face-recognition] job error:", err);
  } finally {
    _jobRunning = false;
  }
}
