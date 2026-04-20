/**
 * Face recognition using Azure Face API (LargeFaceList + FindSimilars).
 *
 * Strategy
 * ────────
 * • One Azure LargeFaceList per user stores all detected face descriptors.
 * • For each photo: detect faces via Azure API → get transient face IDs.
 * • For each face: persist it in the LargeFaceList, then use FindSimilars
 *   to check if it matches any existing person (by stored persistedFaceId).
 * • If similarity >= threshold → assign to matching person.
 * • If no match → create a new person row.
 * • Retrain the LargeFaceList periodically so FindSimilar stays accurate.
 */

import { randomUUID } from "crypto";
import { db, peopleTable, photoFacesTable } from "@workspace/db";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { uploadBlob, downloadBlob } from "./azure-storage.js";

// ── Config ────────────────────────────────────────────────────────────────────

const FACE_ENDPOINT = (process.env.AZURE_FACE_ENDPOINT ?? "").replace(/\/$/, "");
const FACE_KEY = process.env.AZURE_FACE_KEY ?? "";
const SIMILARITY_THRESHOLD = parseFloat(process.env.FACE_SIMILARITY_THRESHOLD ?? "0.6");

function hasFaceApi(): boolean {
  return !!FACE_ENDPOINT && !!FACE_KEY;
}

// ── Azure Face API helpers ────────────────────────────────────────────────────

async function faceReq(method: string, path: string, body?: object): Promise<Response> {
  return fetch(`${FACE_ENDPOINT}/face/v1.0${path}`, {
    method,
    headers: { "Ocp-Apim-Subscription-Key": FACE_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function faceReqBinary(path: string, buffer: Buffer, contentType: string): Promise<Response> {
  return fetch(`${FACE_ENDPOINT}/face/v1.0${path}`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": FACE_KEY, "Content-Type": contentType },
    body: buffer,
  });
}

// ── LargeFaceList helpers ─────────────────────────────────────────────────────

const _ensuredLists = new Set<string>();

function listIdForUser(userId: string): string {
  return `u-${userId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60)}`;
}

async function ensureList(listId: string): Promise<void> {
  if (_ensuredLists.has(listId)) return;
  const checkRes = await faceReq("GET", `/largefacelists/${listId}`);
  if (checkRes.status === 404) {
    const createRes = await faceReq("PUT", `/largefacelists/${listId}`, {
      name: listId,
      recognitionModel: "recognition_04",
    });
    if (!createRes.ok) throw new Error(`[face-recognition] ensureList failed: ${await createRes.text()}`);
  }
  _ensuredLists.add(listId);
}

async function detectFaces(buffer: Buffer, contentType: string): Promise<any[]> {
  const res = await faceReqBinary(
    "/detect?detectionModel=detection_03&recognitionModel=recognition_04&returnFaceId=true",
    buffer, contentType,
  );
  if (!res.ok) { console.warn("[face-recognition] detect failed:", await res.text()); return []; }
  return res.json();
}

async function persistFace(listId: string, faceId: string): Promise<string | null> {
  const res = await faceReq("POST", `/largefacelists/${listId}/persistedfaces`, { faceId });
  if (!res.ok) return null;
  const data: any = await res.json();
  return data.persistedFaceId ?? null;
}

async function findSimilar(listId: string, faceId: string): Promise<any[]> {
  const res = await faceReq("POST", "/findsimilars", {
    faceId, largeFaceListId: listId, maxNumOfCandidatesReturned: 1, mode: "matchPerson",
  });
  if (!res.ok) return [];
  return res.json();
}

async function triggerTraining(listId: string): Promise<void> {
  await faceReq("POST", `/largefacelists/${listId}/train`);
  await new Promise(r => setTimeout(r, 2000));
}

// ── Per-photo processing ──────────────────────────────────────────────────────

async function processFacesForPhotoAzure(
  photoId: string,
  userId: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  if (!contentType.startsWith("image/")) return;

  const listId = listIdForUser(userId);
  await ensureList(listId);

  const faces = await detectFaces(buffer, contentType);

  if (faces.length === 0) {
    // Insert sentinel so this photo is skipped in future scans
    await db.insert(photoFacesTable).values({
      photoId, userId, personId: null, azurePersistedFaceId: null, boundingBox: null,
    }).onConflictDoNothing();
    return;
  }

  // Load existing persisted face IDs → person IDs for this user (for matching)
  const existingFaces = await db
    .select({ personId: photoFacesTable.personId, persistedFaceId: photoFacesTable.azurePersistedFaceId })
    .from(photoFacesTable)
    .where(and(eq(photoFacesTable.userId, userId), isNotNull(photoFacesTable.personId), isNotNull(photoFacesTable.azurePersistedFaceId)))
    .limit(2000);

  const faceIdToPersonId = new Map(
    existingFaces.filter(f => f.persistedFaceId && f.personId).map(f => [f.persistedFaceId!, f.personId!]),
  );

  for (const face of faces) {
    const persistedFaceId = await persistFace(listId, face.faceId);
    if (!persistedFaceId) continue;

    let personId: string | null = null;

    if (faceIdToPersonId.size > 0) {
      const candidates = await findSimilar(listId, face.faceId);
      if (candidates.length > 0 && candidates[0].confidence >= SIMILARITY_THRESHOLD) {
        personId = faceIdToPersonId.get(candidates[0].persistedFaceId) ?? null;
      }
    }

    if (!personId) {
      const [newPerson] = await db.insert(peopleTable).values({ userId }).returning();
      personId = newPerson.id;

      // Crop face thumbnail and use as person cover
      try {
        const { default: sharp } = await import("sharp");
        const { top, left, width, height } = face.faceRectangle;
        const pad = Math.round(Math.max(width, height) * 0.4);
        const meta = await sharp(buffer).metadata();
        const crop = {
          left: Math.max(0, left - pad),
          top: Math.max(0, top - pad),
          width: Math.min((meta.width ?? 9999) - Math.max(0, left - pad), width + pad * 2),
          height: Math.min((meta.height ?? 9999) - Math.max(0, top - pad), height + pad * 2),
        };
        const thumbBuf = await sharp(buffer).extract(crop).resize(256, 256, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
        const blobName = `${userId}/faces/${randomUUID()}.jpg`;
        await uploadBlob(blobName, thumbBuf, "image/jpeg");
        await db.update(peopleTable).set({ coverFaceBlob: blobName }).where(eq(peopleTable.id, personId));
      } catch { /* non-fatal */ }
    }

    const boundingBox = JSON.stringify({
      top: face.faceRectangle.top, left: face.faceRectangle.left,
      width: face.faceRectangle.width, height: face.faceRectangle.height,
    });

    await db.insert(photoFacesTable).values({
      photoId, userId, personId, azurePersistedFaceId: persistedFaceId, boundingBox,
    }).onConflictDoNothing();

    faceIdToPersonId.set(persistedFaceId, personId);
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

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

// ── Background job ────────────────────────────────────────────────────────────

let _jobRunning = false;
let _jobTotal = 0;
let _jobProcessed = 0;

export function getJobProgress(): { running: boolean; processed: number; total: number } {
  return { running: _jobRunning, processed: _jobProcessed, total: _jobTotal };
}

/**
 * Scans all unprocessed images (no photo_faces entry) and runs face detection.
 * Safe to call repeatedly — skips already-processed photos and is non-reentrant.
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
    if (photos.length === 0) { console.log("[face-recognition] job: no unprocessed photos"); return; }

    _jobTotal = photos.length;
    console.log(`[face-recognition] job: processing ${photos.length} unprocessed photo(s)`);

    const userIds: string[] = [...new Set(photos.map((p: any) => p.user_id as string))];
    for (const uid of userIds) {
      await ensureList(listIdForUser(uid));
      try { await triggerTraining(listIdForUser(uid)); } catch { /* ok on empty list */ }
    }

    let trainCounter = 0;
    for (const photo of photos) {
      try {
        const buf = await downloadBlob(photo.blob_name);
        await processFacesForPhotoAzure(photo.id, photo.user_id, buf, photo.content_type);
        trainCounter++;
        if (trainCounter % 20 === 0) {
          try { await triggerTraining(listIdForUser(photo.user_id)); } catch { /* ok */ }
        }
      } catch (err) {
        console.error(`[face-recognition] job: error on ${photo.id}:`, err);
      }
      _jobProcessed++;
    }

    for (const uid of userIds) {
      try { await triggerTraining(listIdForUser(uid)); } catch { /* ok */ }
    }
    console.log("[face-recognition] job: done");
  } catch (err) {
    console.error("[face-recognition] job error:", err);
  } finally {
    _jobRunning = false;
  }
}
import { eq, and, isNotNull, sql } from "drizzle-orm";
