import { Router } from "express";
import { db, peopleTable, photoFacesTable, photosTable } from "@workspace/db";
import { eq, and, sql, isNotNull } from "drizzle-orm";
import { generateSasUrl } from "../lib/azure-storage.js";
import { getJobProgress, runFaceRecognitionJob } from "../lib/face-recognition.js";

const router = Router();

function requireAuth(req: any, res: any, next: any) {
  const user = (req as Record<string, unknown>).user as Record<string, string> | undefined;
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  req.currentUser = { ...user, id: user.id || user.sub };
  next();
}

router.use(requireAuth);

// ── GET /people ── list all persons for the current user ─────────────────────
router.get("/people", async (req: any, res) => {
  const userId = req.currentUser.id;

  const rows = await db.execute(
    sql`SELECT
          p.id,
          p.name,
          p.cover_face_blob,
          p.created_at,
          COUNT(DISTINCT ph.id)::int AS face_count
        FROM people p
        LEFT JOIN photo_faces pf ON pf.person_id = p.id
        LEFT JOIN photos ph ON ph.id = pf.photo_id
          AND ph.trashed = false
          AND ph.hidden  = false
        WHERE p.user_id = ${userId}
        GROUP BY p.id
        ORDER BY face_count DESC, p.created_at ASC`,
  );

  const people = ((rows as any).rows ?? []).map((r: any) => ({
    id: r.id,
    name: r.name ?? null,
    coverUrl: r.cover_face_blob ? generateSasUrl(r.cover_face_blob) : null,
    faceCount: Number(r.face_count),
    createdAt: r.created_at,
  })).filter((p: any) => p.faceCount > 0);

  res.json({ people });
});

// ── GET /people/scan-progress ── face-scan job progress ──────────────────────
router.get("/people/scan-progress", async (_req: any, res) => {
  const inProcess = getJobProgress();
  // Get real progress from DB — covers both API-server-triggered and worker-triggered jobs
  try {
    const totalResult = await db.execute(
      sql`SELECT COUNT(*)::int AS total FROM photos WHERE content_type LIKE 'image/%' AND trashed = false AND hidden = false`,
    );
    const processedResult = await db.execute(
      sql`SELECT COUNT(DISTINCT photo_id)::int AS processed FROM photo_faces`,
    );
    const total = Number((totalResult as any).rows?.[0]?.total ?? 0);
    const processed = Number((processedResult as any).rows?.[0]?.processed ?? 0);
    res.json({ running: inProcess.running, processed, total });
  } catch {
    res.json(inProcess);
  }
});

// ── POST /people/start-scan ── trigger face recognition now ──────────────────
router.post("/people/start-scan", async (_req: any, res) => {
  const { running } = getJobProgress();
  if (running) {
    return res.status(409).json({ error: "Scan already in progress" });
  }
  // Fire and forget — runs in background
  runFaceRecognitionJob().catch((err) =>
    console.error("[people] start-scan background error:", err),
  );
  res.status(202).json({ started: true });
});

// ── GET /people/:id ── person detail with paginated photos ───────────────────
router.get("/people/:id", async (req: any, res) => {
  const userId = req.currentUser.id;
  const personId = req.params.id;
  const limit = parseInt((req.query.limit as string) ?? "50");
  const offset = parseInt((req.query.offset as string) ?? "0");

  const [person] = await db
    .select()
    .from(peopleTable)
    .where(and(eq(peopleTable.id, personId), eq(peopleTable.userId, userId)));

  if (!person) return res.status(404).json({ error: "Not found" });

  // Fetch photos that have at least one face belonging to this person
  const photoRows = await db.execute(
    sql`SELECT DISTINCT ON (ph.id)
          ph.id,
          ph.filename,
          ph.content_type,
          ph.blob_name,
          ph.taken_at,
          ph.uploaded_at,
          ph.favorite
        FROM photos ph
        INNER JOIN photo_faces pf ON pf.photo_id = ph.id
        WHERE pf.person_id = ${personId}
          AND ph.user_id   = ${userId}
          AND ph.trashed   = false
          AND ph.hidden    = false
        ORDER BY ph.id, COALESCE(ph.taken_at, ph.uploaded_at) DESC
        LIMIT ${limit} OFFSET ${offset}`,
  );

  const photos = ((photoRows as any).rows ?? []).map((p: any) => {
    const url = generateSasUrl(p.blob_name);
    return {
      id: p.id,
      filename: p.filename,
      contentType: p.content_type,
      url,
      thumbnailUrl: url,
      takenAt: p.taken_at,
      uploadedAt: p.uploaded_at,
      favorite: p.favorite,
    };
  });

  res.json({
    person: {
      id: person.id,
      name: person.name ?? null,
      coverUrl: person.coverFaceBlob ? generateSasUrl(person.coverFaceBlob) : null,
      createdAt: person.createdAt,
    },
    photos,
    hasMore: photos.length === limit,
  });
});

// ── PATCH /people/:id ── rename a person ─────────────────────────────────────
router.patch("/people/:id", async (req: any, res) => {
  const userId = req.currentUser.id;
  const { name } = req.body as { name?: string };

  if (typeof name !== "string" || name.trim().length === 0) {
    return res.status(400).json({ error: "name is required" });
  }

  const [updated] = await db
    .update(peopleTable)
    .set({ name: name.trim() })
    .where(and(eq(peopleTable.id, req.params.id), eq(peopleTable.userId, userId)))
    .returning();

  if (!updated) return res.status(404).json({ error: "Not found" });

  res.json({
    id: updated.id,
    name: updated.name,
    coverUrl: updated.coverFaceBlob ? generateSasUrl(updated.coverFaceBlob) : null,
  });
});

// ── DELETE /people/:id ── dissolve a person grouping ─────────────────────────
router.delete("/people/:id", async (req: any, res) => {
  const userId = req.currentUser.id;

  // Verify ownership
  const [person] = await db
    .select()
    .from(peopleTable)
    .where(and(eq(peopleTable.id, req.params.id), eq(peopleTable.userId, userId)));

  if (!person) return res.status(404).json({ error: "Not found" });

  // Unlink faces (set person_id = null)
  await db
    .update(photoFacesTable)
    .set({ personId: null })
    .where(eq(photoFacesTable.personId, req.params.id));

  // Delete person row
  await db
    .delete(peopleTable)
    .where(eq(peopleTable.id, req.params.id));

  res.status(204).send();
});

// ── POST /people/merge ── merge two persons ───────────────────────────────────
router.post("/people/merge", async (req: any, res) => {
  const userId = req.currentUser.id;
  const { sourceId, targetId } = req.body as { sourceId?: string; targetId?: string };

  if (!sourceId || !targetId || sourceId === targetId) {
    return res.status(400).json({ error: "sourceId and targetId are required and must differ" });
  }

  // Verify both belong to the user
  const persons = await db
    .select()
    .from(peopleTable)
    .where(eq(peopleTable.userId, userId));

  const source = persons.find((p) => p.id === sourceId);
  const target = persons.find((p) => p.id === targetId);

  if (!source || !target) return res.status(404).json({ error: "One or both persons not found" });

  // Re-assign all faces from source → target
  await db
    .update(photoFacesTable)
    .set({ personId: targetId })
    .where(eq(photoFacesTable.personId, sourceId));

  // Delete source person
  await db.delete(peopleTable).where(eq(peopleTable.id, sourceId));

  res.json({ merged: true, targetId });
});

// ── GET /people/unassigned ── faces not yet grouped into a person ─────────────
router.get("/people/unassigned", async (req: any, res) => {
  const userId = req.currentUser.id;
  const limit = parseInt((req.query.limit as string) ?? "50");
  const offset = parseInt((req.query.offset as string) ?? "0");

  const rows = await db.execute(
    sql`SELECT
          pf.id          AS face_id,
          pf.bounding_box,
          ph.id          AS photo_id,
          ph.blob_name
        FROM photo_faces pf
        INNER JOIN photos ph ON ph.id = pf.photo_id
        WHERE pf.user_id   = ${userId}
          AND pf.person_id IS NULL
          AND ph.trashed   = false
        ORDER BY pf.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
  );

  const faces = ((rows as any).rows ?? []).map((r: any) => ({
    faceId: r.face_id,
    photoId: r.photo_id,
    photoUrl: generateSasUrl(r.blob_name),
    boundingBox: r.bounding_box ? JSON.parse(r.bounding_box) : null,
  }));

  res.json({ faces, hasMore: faces.length === limit });
});

export default router;
