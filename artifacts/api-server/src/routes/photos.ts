import { Router } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import path from "path";
import { db, photosTable, albumPhotosTable, albumsTable, shareLinksTable } from "@workspace/db";
import { eq, and, desc, ilike, or, sql, inArray } from "drizzle-orm";
import { uploadBlob, deleteBlob, generateSasUrl, generateUploadSasUrl, downloadBlob } from "../lib/azure-storage.js";
import { generateThumbnails, generateVideoThumbnails } from "../lib/thumbnails.js";
import { cacheGet, cacheSet, cacheDel, cacheDelPattern } from "../lib/cache.js";
import exifr from "exifr";

/** Parse an EXIF date value which may be a Date object or the non-standard "YYYY:MM:DD HH:MM:SS" string. */
function parseExifDate(raw: unknown): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === "string") {
    // EXIF uses colons as date separators: "2021:03:15 14:22:10" → must become "2021-03-15T14:22:10"
    const normalized = raw.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").replace(" ", "T");
    const d = new Date(normalized);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Extract the capture date from an image buffer. Returns null for videos or images without EXIF. */
async function extractTakenAt(buffer: Buffer, mimeType: string): Promise<Date | null> {
  if (!mimeType.startsWith("image/")) return null;
  try {
    // Try all common EXIF/XMP date tags in order of preference
    const exif = await exifr.parse(buffer, {
      pick: ["DateTimeOriginal", "DateTimeDigitized", "CreateDate", "DateTime"],
    });
    const raw = exif?.DateTimeOriginal ?? exif?.DateTimeDigitized ?? exif?.CreateDate ?? exif?.DateTime;
    return parseExifDate(raw);
  } catch {
    return null;
  }
}



const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

function parseSearchDate(q: string): { type: "month"; value: string } | { type: "year"; value: number } | null {
  const s = q.trim().toLowerCase();

  // "march 2024" or "2024 march"
  for (const [name, num] of Object.entries(MONTH_NAMES)) {
    const re1 = new RegExp(`^${name}\\s+(\\d{4})$`);
    const re2 = new RegExp(`^(\\d{4})\\s+${name}$`);
    const m1 = re1.exec(s);
    const m2 = re2.exec(s);
    const year = m1?.[1] ?? m2?.[1];
    if (year) return { type: "month", value: `${year}-${String(num).padStart(2, "0")}` };
  }

  // Pure month name "march" → current year
  if (MONTH_NAMES[s] !== undefined) {
    const year = new Date().getFullYear();
    return { type: "month", value: `${year}-${String(MONTH_NAMES[s]).padStart(2, "0")}` };
  }

  // Pure 4-digit year "2024"
  if (/^\d{4}$/.test(s)) {
    return { type: "year", value: parseInt(s, 10) };
  }

  return null;
}

function requireAuth(req: any, res: any, next: any) {
  const user = (req as Record<string, unknown>).user as Record<string, string> | undefined;
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  req.currentUser = { ...user, id: user.id || user.sub };
  next();
}

router.use(requireAuth);

// "On this day" — photos taken on the same month+day in prior years
router.get("/photos/on-this-day", async (req: any, res) => {
  const userId = req.currentUser.id;
  const cachedOtd = await cacheGet(`on-this-day:${userId}`);
  if (cachedOtd) return res.json(JSON.parse(cachedOtd));
  const now = new Date();
  const thisYear = now.getFullYear();
  const todayDow = now.getDay(); // 0=Sun … 6=Sat
  const todayMonth = now.getMonth() + 1; // 1-based
  const todayDay = now.getDate();
  try {
    // ── "On This Day" photos: same month+day in any previous year ────────────
    const todayRows = await db.execute(
      sql`SELECT *, EXTRACT(DOW FROM COALESCE(taken_at, uploaded_at))::int AS dow
          FROM photos
          WHERE user_id = ${userId}
            AND trashed = false
            AND hidden = false
            AND content_type NOT LIKE 'video/%'
            AND EXTRACT(YEAR  FROM COALESCE(taken_at, uploaded_at)) < ${thisYear}
            AND EXTRACT(MONTH FROM COALESCE(taken_at, uploaded_at)) = ${todayMonth}
            AND EXTRACT(DAY   FROM COALESCE(taken_at, uploaded_at)) = ${todayDay}
          ORDER BY COALESCE(taken_at, uploaded_at) DESC
          LIMIT 20`,
    );
    const todayPhotos: any[] = [];
    for (const photo of (todayRows as any).rows ?? []) {
      if (todayPhotos.length >= 10) break;
      const url = generateSasUrl(photo.blob_name);
      todayPhotos.push({
        id: photo.id,
        filename: photo.filename,
        contentType: photo.content_type,
        size: photo.size,
        url,
        thumbnailUrl: url,
        favorite: photo.favorite,
        uploadedAt: photo.uploaded_at,
        takenAt: photo.taken_at,
      });
    }

    // Fetch up to 20 photos per day-of-week for all 7 days in one query
    const rows = await db.execute(
      sql`SELECT *, EXTRACT(DOW FROM COALESCE(taken_at, uploaded_at))::int AS dow
          FROM photos
          WHERE user_id = ${userId}
            AND trashed = false
            AND hidden = false
            AND content_type NOT LIKE 'video/%'
            AND EXTRACT(YEAR FROM COALESCE(taken_at, uploaded_at)) < ${thisYear}
          ORDER BY COALESCE(taken_at, uploaded_at) DESC`,
    );
    // Group by dow, keep up to 20 per day
    const byDow: Record<number, any[]> = {};
    for (const photo of (rows as any).rows ?? []) {
      const d = Number(photo.dow);
      if (!byDow[d]) byDow[d] = [];
      if (byDow[d].length < 10) {
        const url = generateSasUrl(photo.blob_name);
        byDow[d].push({
          id: photo.id,
          filename: photo.filename,
          contentType: photo.content_type,
          size: photo.size,
          url,
          thumbnailUrl: url,
          favorite: photo.favorite,
          uploadedAt: photo.uploaded_at,
          takenAt: photo.taken_at,
        });
      }
    }
    // Return days that have photos, today first then the rest in order
    const days: { dow: number; dayName: string; photos: any[]; isToday?: boolean }[] = [];
    const DOW_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    // Prepend "On This Day" (same month+day across past years) if photos exist
    if (todayPhotos.length > 0) {
      days.push({ dow: todayDow, dayName: DOW_NAMES[todayDow], photos: todayPhotos, isToday: true });
    }
    // Build ordered list: todayDow first, then the other 6 days in circular order
    const order = Array.from({ length: 7 }, (_, i) => (todayDow + i) % 7);
    for (const d of order) {
      // Skip today's DOW if we already added it as the "On This Day" tile
      if (d === todayDow && todayPhotos.length > 0) continue;
      if (byDow[d] && byDow[d].length > 0) {
        days.push({ dow: d, dayName: DOW_NAMES[d], photos: byDow[d] });
      }
    }
    await cacheSet(`on-this-day:${userId}`, JSON.stringify({ days, todayDow }), 3600);
    res.json({ days, todayDow });
  } catch {
    res.json({ days: [], todayDow: now.getDay() });
  }
});

router.get("/photos/stats", async (req: any, res) => {
  const userId = req.currentUser.id;
  const cached = await cacheGet(`stats:${userId}`);
  if (cached) return res.json(JSON.parse(cached));
  // Single query replaces 4 separate COUNT queries — saves 3× round-trip latency
  const [statsRow, albumCount] = await Promise.all([
    db.execute(
      sql`SELECT
         COUNT(*) FILTER (WHERE NOT trashed AND NOT hidden) AS total,
         COALESCE(SUM(size) FILTER (WHERE NOT trashed AND NOT hidden), 0) AS total_size,
         COUNT(*) FILTER (WHERE favorite AND NOT trashed AND NOT hidden) AS favorites,
         COUNT(*) FILTER (WHERE trashed) AS trashed,
         COUNT(*) FILTER (WHERE hidden AND NOT trashed) AS hidden
       FROM photos WHERE user_id = ${userId}`,
    ),
    db.execute(sql`SELECT COUNT(DISTINCT album_id) AS cnt FROM album_photos ap JOIN albums a ON a.id = ap.album_id WHERE a.user_id = ${userId}`)
      .catch(() => ({ rows: [{ cnt: 0 }] })),
  ]);
  const r = (statsRow as any).rows?.[0] ?? {};
  const result = {
    total: Number(r.total ?? 0),
    favorites: Number(r.favorites ?? 0),
    trashed: Number(r.trashed ?? 0),
    hidden: Number(r.hidden ?? 0),
    albums: Number((albumCount as any).rows?.[0]?.cnt ?? 0),
    totalSize: Number(r.total_size ?? 0),
  };
  await cacheSet(`stats:${userId}`, JSON.stringify(result), 60);
  res.json(result);
});

// Returns distinct months that have photos, with counts
router.get("/photos/months", async (req: any, res) => {
  const userId = req.currentUser.id;
  try {
    // Get counts per month
    const countRows = await db.execute(
      sql`SELECT
            TO_CHAR(DATE_TRUNC('month', COALESCE(taken_at, uploaded_at)), 'YYYY-MM') AS year_month,
            COUNT(*) AS count
          FROM photos
          WHERE user_id = ${userId} AND trashed = false AND hidden = false
          GROUP BY 1
          ORDER BY 1 DESC`,
    );
    // Get up to 6 cover photos per month (1 hero + 5 strip thumbnails)
    const coverRows = await db.execute(
      sql`SELECT year_month, blob_name
          FROM (
            SELECT
              TO_CHAR(DATE_TRUNC('month', COALESCE(taken_at, uploaded_at)), 'YYYY-MM') AS year_month,
              blob_name,
              ROW_NUMBER() OVER (
                PARTITION BY DATE_TRUNC('month', COALESCE(taken_at, uploaded_at))
                ORDER BY COALESCE(taken_at, uploaded_at) DESC
              ) AS rn
            FROM photos
            WHERE user_id = ${userId} AND trashed = false AND hidden = false
          ) sub
          WHERE rn <= 6
          ORDER BY year_month DESC, rn`,
    );
    // Group cover thumbnails by yearMonth
    const coversByMonth: Record<string, string[]> = {};
    for (const row of (coverRows as any).rows ?? []) {
      if (!coversByMonth[row.year_month]) coversByMonth[row.year_month] = [];
      if (coversByMonth[row.year_month].length < 6) {
        coversByMonth[row.year_month].push(generateSasUrl(row.blob_name));
      }
    }
    const months = ((countRows as any).rows ?? []).map((r: any) => ({
      yearMonth: r.year_month,
      count: Number(r.count),
      covers: coversByMonth[r.year_month] ?? [],
    }));
    res.json({ months });
  } catch {
    res.json({ months: [] });
  }
});

router.get("/photos", async (req: any, res) => {
  const userId = req.currentUser.id;
  const { search, album, favorite, trashed, hidden, limit = "50", offset = "0", orderBy = "taken", month } = req.query as Record<string, string>;

  const conditions = [eq(photosTable.userId, userId)];

  if (trashed === "true") {
    conditions.push(eq(photosTable.trashed, true));
  } else {
    conditions.push(eq(photosTable.trashed, false));
  }

  if (hidden === "true") {
    conditions.push(eq(photosTable.hidden, true));
  } else {
    conditions.push(eq(photosTable.hidden, false));
  }

  if (favorite === "true") {
    conditions.push(eq(photosTable.favorite, true));
  }

  if (search) {
    const dateMatch = parseSearchDate(search);
    if (dateMatch) {
      if (dateMatch.type === "month") {
        conditions.push(
          sql`TO_CHAR(DATE_TRUNC('month', COALESCE(${photosTable.takenAt}, ${photosTable.uploadedAt})), 'YYYY-MM') = ${dateMatch.value}`,
        );
      } else {
        conditions.push(
          sql`EXTRACT(YEAR FROM COALESCE(${photosTable.takenAt}, ${photosTable.uploadedAt})) = ${dateMatch.value}`,
        );
      }
    } else {
      conditions.push(
        or(
          ilike(photosTable.filename, `%${search}%`),
          ilike(photosTable.description, `%${search}%`),
          ilike(photosTable.tags, `%${search}%`),
          ilike(photosTable.locationName, `%${search}%`),
        )!,
      );
    }
  }

  // Filter to a specific month: month=YYYY-MM
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    conditions.push(
      sql`TO_CHAR(DATE_TRUNC('month', COALESCE(${photosTable.takenAt}, ${photosTable.uploadedAt})), 'YYYY-MM') = ${month}`,
    );
  }

  let photos;
  if (album) {
    const albumPhotos = await db
      .select({ photoId: albumPhotosTable.photoId })
      .from(albumPhotosTable)
      .where(eq(albumPhotosTable.albumId, album));
    const photoIds = albumPhotos.map((ap: { photoId: string }) => ap.photoId);
    if (photoIds.length === 0) {
      return res.json({ photos: [], total: 0, hasMore: false });
    }
    const orderExpr = orderBy === "uploaded"
      ? desc(photosTable.uploadedAt)
      : desc(sql`COALESCE(${photosTable.takenAt}, ${photosTable.uploadedAt})`);
    photos = await db
      .select()
      .from(photosTable)
      .where(and(...conditions))
      .orderBy(orderExpr)
      .limit(parseInt(limit))
      .offset(parseInt(offset));
    photos = photos.filter((p: { id: string }) => photoIds.includes(p.id));
  } else if (hidden === "true") {
    // For archive view: include hidden photos owned by the user AND hidden guest-contributed
    // photos that live in albums owned by the user (userId = "guest:{token}").
    const orderExpr = orderBy === "uploaded"
      ? desc(photosTable.uploadedAt)
      : desc(sql`COALESCE(${photosTable.takenAt}, ${photosTable.uploadedAt})`);

    // 1. Own hidden photos
    const ownPhotos = await db
      .select()
      .from(photosTable)
      .where(and(...conditions))
      .orderBy(orderExpr);

    // 2. Guest-contributed hidden photos in albums owned by this user
    const userAlbums = await db
      .select({ id: albumsTable.id })
      .from(albumsTable)
      .where(and(eq(albumsTable.userId, userId), eq(albumsTable.trashed, false)));

    let guestPhotos: typeof ownPhotos = [];
    if (userAlbums.length > 0) {
      const albumIds = userAlbums.map((a: { id: string }) => a.id);
      const links = await db
        .select({ photoId: albumPhotosTable.photoId })
        .from(albumPhotosTable)
        .where(inArray(albumPhotosTable.albumId, albumIds));
      const linkedIds = links.map((l: { photoId: string }) => l.photoId);
      if (linkedIds.length > 0) {
        guestPhotos = await db
          .select()
          .from(photosTable)
          .where(and(
            inArray(photosTable.id, linkedIds),
            eq(photosTable.hidden, true),
            eq(photosTable.trashed, false),
            // Only guest-contributed: exclude photos already fetched above
            sql`${photosTable.userId} LIKE 'guest:%'`,
          ))
          .orderBy(orderExpr);
      }
    }

    // Merge, deduplicate, sort
    const seen = new Set<string>();
    const merged = [...ownPhotos, ...guestPhotos].filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    merged.sort((a: any, b: any) => {
      const da = new Date(a.takenAt ?? a.uploadedAt).getTime();
      const db2 = new Date(b.takenAt ?? b.uploadedAt).getTime();
      return db2 - da;
    });
    photos = merged.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  } else {
    const orderExpr = orderBy === "uploaded"
      ? desc(photosTable.uploadedAt)
      : desc(sql`COALESCE(${photosTable.takenAt}, ${photosTable.uploadedAt})`);
    photos = await db
      .select()
      .from(photosTable)
      .where(and(...conditions))
      .orderBy(orderExpr)
      .limit(parseInt(limit))
      .offset(parseInt(offset));
  }

  const photosWithUrls = photos.map((photo: any) => {
      const url = generateSasUrl(photo.blobName);
      const thumbnailUrl = photo.thumbBlobName ? generateSasUrl(photo.thumbBlobName) : url;
      const previewUrl = photo.previewBlobName ? generateSasUrl(photo.previewBlobName) : url;
      return {
        id: photo.id,
        filename: photo.filename,
        description: photo.description,
        contentType: photo.contentType,
        size: photo.size,
        width: photo.width,
        height: photo.height,
        url,
        thumbnailUrl,
        previewUrl,
        favorite: photo.favorite,
        trashed: photo.trashed,
        trashedAt: photo.trashedAt,
        uploadedAt: photo.uploadedAt,
        takenAt: photo.takenAt,
        tags: photo.tags ?? null,
        locationName: photo.locationName ?? null,
        albums: [],
      };
    });

  res.json({ photos: photosWithUrls, total: photosWithUrls.length, hasMore: photosWithUrls.length === parseInt(limit) });
});

// Returns a write SAS URL so the browser can upload directly to Blob Storage.
// In dev (no SAS), returns null and the client falls back to the multipart POST.
router.post("/photos/presign", async (req: any, res) => {
  const userId = req.currentUser.id;
  const { filename, contentType, albumId } = req.body as {
    filename: string;
    contentType: string;
    albumId?: string;
  };
  if (!filename || !contentType) return res.status(400).json({ error: "filename and contentType required" });

  const ext = path.extname(filename);
  const blobName = albumId
    ? `${userId}/${albumId}/${randomUUID()}${ext}`
    : `${userId}/${randomUUID()}${ext}`;

  const uploadUrl = await generateUploadSasUrl(blobName, contentType);
  // Client must set x-ms-blob-cache-control on the PUT so browsers cache images long-term
  res.json({ uploadUrl: uploadUrl || null, blobName, cacheControl: "public, max-age=31536000, immutable" });
});

// Saves photo metadata after a direct browser→blob upload.
router.post("/photos/register", async (req: any, res) => {
  const userId = req.currentUser.id;
  const { blobName, filename, contentType, size, albumId, takenAt: takenAtStr } = req.body as {
    blobName: string;
    filename: string;
    contentType: string;
    size: number;
    albumId?: string;
    takenAt?: string;
  };
  if (!blobName || !filename || !contentType) return res.status(400).json({ error: "blobName, filename and contentType required" });

  const takenAt = takenAtStr ? new Date(takenAtStr) : null;

  const [photo] = await db
    .insert(photosTable)
    .values({ userId, filename, blobName, contentType, size: size || 0, takenAt })
    .returning();

  if (albumId) {
    const [album] = await db.select().from(albumsTable)
      .where(and(eq(albumsTable.id, albumId), eq(albumsTable.userId, userId)));
    if (album) {
      await db.insert(albumPhotosTable).values({ albumId, photoId: photo.id }).onConflictDoNothing();
    }
  }

  const regUrl = generateSasUrl(blobName);
  res.status(201).json({ ...photo, url: regUrl, thumbnailUrl: regUrl, previewUrl: regUrl, albums: albumId ? [albumId] : [] });

  // Async EXIF backfill + thumbnail generation (fire-and-forget)
  // Vision tags, GPS/location, and face recognition are handled by the worker Container App.
  downloadBlob(blobName)
    .then(async (buf) => {
      if (!takenAt && contentType.startsWith("image/")) {
        const extracted = await extractTakenAt(buf, contentType);
        if (extracted) {
          await db.update(photosTable).set({ takenAt: extracted }).where(eq(photosTable.id, photo.id));
        }
      }
      const thumbs = contentType.startsWith("video/")
        ? await generateVideoThumbnails(buf, blobName)
        : await generateThumbnails(buf, blobName, contentType);
      if (thumbs) {
        await db.update(photosTable)
          .set({ thumbBlobName: thumbs.thumbBlobName, previewBlobName: thumbs.previewBlobName })
          .where(eq(photosTable.id, photo.id));
      }
      await cacheDelPattern(`stats:${userId}`);
    })
    .catch(() => {});
});

router.post("/photos", upload.single("file"), async (req: any, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const userId = req.currentUser.id;
  const albumId: string | undefined = req.body.albumId || undefined;
  const ext = path.extname(req.file.originalname);

  // Store under userId/albumId/uuid.jpg when album is specified, else userId/uuid.jpg
  const blobName = albumId
    ? `${userId}/${albumId}/${randomUUID()}${ext}`
    : `${userId}/${randomUUID()}${ext}`;

  // Vision tags, GPS/location, and face recognition are handled by the worker Container App.
  const isVideo = req.file.mimetype.startsWith("video/");
  const [takenAt, thumbs] = await Promise.all([
    extractTakenAt(req.file.buffer, req.file.mimetype),
    isVideo
      ? generateVideoThumbnails(req.file.buffer, blobName)
      : generateThumbnails(req.file.buffer, blobName, req.file.mimetype),
  ]);

  await uploadBlob(blobName, req.file.buffer, req.file.mimetype);

  const [photo] = await db
    .insert(photosTable)
    .values({
      userId,
      filename: req.file.originalname,
      blobName,
      thumbBlobName: thumbs?.thumbBlobName ?? null,
      previewBlobName: thumbs?.previewBlobName ?? null,
      description: req.body.description || null,
      contentType: req.file.mimetype,
      size: req.file.size,
      takenAt,
      tags: null,
      locationName: null,
    })
    .returning();

  // Auto-link to album if albumId provided
  if (albumId) {
    const [album] = await db
      .select()
      .from(albumsTable)
      .where(and(eq(albumsTable.id, albumId), eq(albumsTable.userId, userId)));
    if (album) {
      await db.insert(albumPhotosTable).values({ albumId, photoId: photo.id }).onConflictDoNothing();
    }
  }

  const url = generateSasUrl(blobName);
  const thumbnailUrl = thumbs?.thumbBlobName ? generateSasUrl(thumbs.thumbBlobName) : url;
  const previewUrl = thumbs?.previewBlobName ? generateSasUrl(thumbs.previewBlobName) : url;

  await cacheDelPattern(`stats:${userId}`);
  res.status(201).json({
    ...photo,
    url,
    thumbnailUrl,
    previewUrl,
    albums: albumId ? [albumId] : [],
  });

});

router.get("/photos/:id/url", async (req: any, res) => {
  const userId = req.currentUser.id;
  const [photo] = await db
    .select()
    .from(photosTable)
    .where(and(eq(photosTable.id, req.params.id), eq(photosTable.userId, userId)));

  if (!photo) return res.status(404).json({ error: "Not found" });
  const url = generateSasUrl(photo.blobName);
  res.json({ url });
});

router.get("/photos/:id", async (req: any, res) => {
  const userId = req.currentUser.id;
  const [photo] = await db
    .select()
    .from(photosTable)
    .where(and(eq(photosTable.id, req.params.id), eq(photosTable.userId, userId)));

  if (!photo) return res.status(404).json({ error: "Not found" });

  const url = generateSasUrl(photo.blobName);
  res.json({ ...photo, url, thumbnailUrl: url, albums: [] });
});

router.patch("/photos/:id/favorite", async (req: any, res) => {
  const userId = req.currentUser.id;
  await cacheDel(`stats:${userId}`);
  const { favorite } = req.body as { favorite: boolean };

  const [photo] = await db
    .update(photosTable)
    .set({ favorite })
    .where(and(eq(photosTable.id, req.params.id), eq(photosTable.userId, userId)))
    .returning();

  if (!photo) return res.status(404).json({ error: "Not found" });

  const url = generateSasUrl(photo.blobName);
  res.json({ ...photo, url, thumbnailUrl: url, albums: [] });
});

router.patch("/photos/:id/trash", async (req: any, res) => {
  const userId = req.currentUser.id;
  await cacheDel(`stats:${userId}`);
  const { trashed } = req.body as { trashed: boolean };

  const [photo] = await db
    .update(photosTable)
    .set({ trashed, trashedAt: trashed ? new Date() : null })
    .where(and(eq(photosTable.id, req.params.id), eq(photosTable.userId, userId)))
    .returning();

  if (!photo) return res.status(404).json({ error: "Not found" });

  const url = generateSasUrl(photo.blobName);
  res.json({ ...photo, url, thumbnailUrl: url, albums: [] });
});

router.patch("/photos/:id/hide", async (req: any, res) => {
  const userId = req.currentUser.id;
  const { hidden } = req.body as { hidden: boolean };

  // First try: photo belongs to the current user
  let [photo] = await db
    .update(photosTable)
    .set({ hidden })
    .where(and(eq(photosTable.id, req.params.id), eq(photosTable.userId, userId)))
    .returning();

  // Second try: guest-contributed photo (userId='guest:...') in an album owned by this user
  if (!photo) {
    const link = await db
      .select({ albumId: albumPhotosTable.albumId })
      .from(albumPhotosTable)
      .innerJoin(albumsTable, eq(albumsTable.id, albumPhotosTable.albumId))
      .where(and(
        eq(albumPhotosTable.photoId, req.params.id),
        eq(albumsTable.userId, userId),
        eq(albumsTable.trashed, false),
      ))
      .limit(1);

    if (link.length > 0) {
      [photo] = await db
        .update(photosTable)
        .set({ hidden })
        .where(eq(photosTable.id, req.params.id))
        .returning();
    }
  }

  if (!photo) return res.status(404).json({ error: "Not found" });

  const url = generateSasUrl(photo.blobName);
  res.json({ ...photo, url, thumbnailUrl: url, albums: [] });
});

router.delete("/photos/:id", async (req: any, res) => {
  const userId = req.currentUser.id;
  const [photo] = await db
    .select()
    .from(photosTable)
    .where(and(eq(photosTable.id, req.params.id), eq(photosTable.userId, userId)));

  if (!photo) return res.status(404).json({ error: "Not found" });

  await deleteBlob(photo.blobName);
  await db.delete(photosTable).where(eq(photosTable.id, req.params.id));
  res.status(204).send();
});

export default router;
