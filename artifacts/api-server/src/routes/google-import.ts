import { Router } from "express";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { db, photosTable, albumsTable, albumPhotosTable, googleSyncTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { uploadBlobFromStream } from "../lib/azure-storage.js";
import { logger } from "../lib/logger.js";
import { encryptToken } from "../lib/token-crypto.js";
import { refreshGoogleAccessToken } from "../lib/google-auth.js";

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// APP_URL is the *frontend* SWA URL — used for post-callback redirects to /albums
const APP_URL = process.env.APP_URL || "http://localhost:5173";

// Google OAuth scopes:
//   photospicker  — manual interactive import (Picker API)
//   photoslibrary — automated background sync (Library API)
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
  "https://www.googleapis.com/auth/photoslibrary.readonly",
].join(" ");

/** Returns the API's own origin so REDIRECT_URI always points at the API, not the SWA frontend. */
function apiOrigin(req: any): string {
  const proto = (req.get("x-forwarded-proto") as string | undefined) || req.protocol || "https";
  const host = req.get("host") as string;
  return `${proto}://${host}`;
}

// In-memory state store: stateKey -> { userId, redirectUri, albumName, targetAlbumId?, noAlbum? }
const pendingStates = new Map<string, { userId: string; redirectUri: string; albumName: string; targetAlbumId?: string; noAlbum?: boolean }>();

// Map state -> importId, written after OAuth callback so the originating tab can resolve it
const stateToImportId = new Map<string, string>();

// In-memory import status: importId -> status
interface ImportStatus {
  status: "picking" | "importing" | "done" | "error";
  albumName: string;
  albumId?: string;
  total: number;
  imported: number;
  errors: number;
  message?: string;
  pickerUri?: string;
  /** true when the import errored mid-way and can be resumed */
  resumable?: boolean;
}
const importStatuses = new Map<string, ImportStatus>();
const cancelledImports = new Set<string>();

// Resume data stored per importId so the user can restart from where it failed
interface ResumeData {
  items: any[];
  processedIds: Set<string>;
  accessToken: string;
  refreshToken: string | undefined;
  userId: string;
  albumId?: string;
  noAlbum?: boolean;
}
const resumeDataStore = new Map<string, ResumeData>();

function requireAuth(req: any, res: any, next: any) {
  const user = (req as Record<string, unknown>).user as Record<string, string> | undefined;
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  req.currentUser = { ...user, id: user.id || user.sub };
  next();
}

async function runImport(importId: string, sessionId: string, userId: string, accessToken: string, refreshToken: string | undefined, targetAlbumId?: string, noAlbum?: boolean) {
  const status = importStatuses.get(importId)!;

  try {
    // Phase 1: Poll picker session until user selects photos (mediaItemsSet=true)
    const pollIntervalMs = 5000;
    const deadline = Date.now() + 60 * 60 * 1000; // 1 hour

    while (Date.now() < deadline) {
      if (cancelledImports.has(importId)) {
        cancelledImports.delete(importId);
        status.status = "error";
        status.message = "Cancelled by user";
        return;
      }
      const sessRes = await fetch(`https://photospicker.googleapis.com/v1/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!sessRes.ok) throw new Error(`Session poll error (${sessRes.status}): ${await sessRes.text()}`);
      const sess = await sessRes.json() as { mediaItemsSet?: boolean };
      if (sess.mediaItemsSet) break;
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    if (Date.now() >= deadline) throw new Error("Timed out waiting for photo selection");

    status.status = "importing";
    status.pickerUri = undefined; // no longer needed

    // Phase 2: Fetch all selected media items (Picker API returns max ~230 per session)
    const items: any[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;
    const MAX_RETRIES_PER_PAGE = 3;
    do {
      pageCount++;
      const url = new URL("https://photospicker.googleapis.com/v1/mediaItems");
      url.searchParams.set("sessionId", sessionId);
      url.searchParams.set("pageSize", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      
      let success = false;
      let lastError: string = "";
      
      for (let attempt = 0; attempt < MAX_RETRIES_PER_PAGE; attempt++) {
        try {
          const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) {
            lastError = `HTTP ${res.status}: ${await res.text()}`;
            if (res.status === 429 || res.status >= 500) {
              // Transient error, retry
              await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
              continue;
            }
            throw new Error(lastError);
          }
          const data = await res.json() as { mediaItems?: any[]; nextPageToken?: string };
          const pageItems = data.mediaItems?.length ?? 0;
          logger.info({ pageCount, pageItems, totalItems: items.length + pageItems, hasNextToken: !!data.nextPageToken }, "Fetched Picker API page");
          if (data.mediaItems) items.push(...data.mediaItems);
          pageToken = data.nextPageToken;
          success = true;
          break;
        } catch (err: any) {
          lastError = String(err?.message ?? err);
          if (attempt < MAX_RETRIES_PER_PAGE - 1) {
            logger.warn({ pageCount, attempt, error: lastError }, "Retrying Picker API page fetch");
            await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
          }
        }
      }
      
      if (!success) {
        throw new Error(`Failed to fetch page ${pageCount} after ${MAX_RETRIES_PER_PAGE} retries: ${lastError}`);
      }
    } while (pageToken);

    logger.info({ totalPages: pageCount, totalItems: items.length }, "Finished fetching all media items from Picker API");
    status.total = items.length;

    if (items.length === 0) {
      status.status = "done";
      status.message = "No photos were selected.";
      return;
    }

    // Resolve album: use existing, create new, or import to library only
    let albumId: string | undefined;
    if (targetAlbumId) {
      albumId = targetAlbumId;
      status.albumId = targetAlbumId;
    } else if (!noAlbum) {
      const [newAlbum] = await db
        .insert(albumsTable)
        .values({ userId, name: status.albumName || "Google Photos Import" })
        .returning();
      albumId = newAlbum.id;
      status.albumId = albumId;
    }

    // Save resume data so we can restart from where it fails
    const processedIds = new Set<string>();
    resumeDataStore.set(importId, { items, processedIds, accessToken, refreshToken, userId, albumId, noAlbum });

    await processItems(importId, items, processedIds, status, accessToken, refreshToken, userId, albumId);

    if (status.status !== "error") {
      status.status = "done";
      resumeDataStore.delete(importId);
      // Clean up picker session
      await fetch(`https://photospicker.googleapis.com/v1/sessions/${sessionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      }).catch(() => {});
    }

  } catch (err: any) {
    status.status = "error";
    status.message = String(err?.message ?? err);
    status.resumable = resumeDataStore.has(importId);
    logger.error({ err: String(err) }, "Google Photos import failed");
  }
}

/** @deprecated Use refreshGoogleAccessToken from lib/google-auth.ts instead. */
const refreshAccessToken = refreshGoogleAccessToken;

/** Process a list of items, skipping already-processed IDs. Shared by initial run and resume. */
async function processItems(
  importId: string,
  items: any[],
  processedIds: Set<string>,
  status: ImportStatus,
  initialAccessToken: string,
  refreshToken: string | undefined,
  userId: string,
  albumId: string | undefined,
) {
  // Mutable token holder so fetchWithRetry can update it on refresh
  const tokenHolder = { accessToken: initialAccessToken };

  for (const item of items) {
    const itemId: string = item.id || item.mediaFile?.filename || "";
    if (processedIds.has(itemId)) continue; // already done (resume skip)

    if (cancelledImports.has(importId)) {
      cancelledImports.delete(importId);
      status.status = "error";
      status.message = "Cancelled by user";
      status.resumable = resumeDataStore.has(importId);
      return;
    }
    try {
      const mimeType: string = item.mediaFile?.mimeType || "image/jpeg";
      const isVideo = mimeType.startsWith("video/");
      const ext = isVideo ? ".mp4" : ".jpg";
      const baseUrl: string = item.mediaFile?.baseUrl || "";
      const downloadUrl = isVideo ? `${baseUrl}=dv` : `${baseUrl}=d`;

      // Stream directly from Google to Azure — no full-file buffer in RAM.
      // Retry up to 3 times on transient errors (401 token refresh, 429, 5xx, timeouts).
      const MAX_RETRIES = 3;
      let size = 0;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), 120_000); // 2 min per file
        try {
          const res = await fetch(downloadUrl, {
            headers: { Authorization: `Bearer ${tokenHolder.accessToken}` },
            signal: controller.signal,
          });
          clearTimeout(timeoutHandle);

          if (res.status === 401 && refreshToken && attempt < MAX_RETRIES) {
            const newToken = await refreshAccessToken(refreshToken);
            if (newToken) tokenHolder.accessToken = newToken;
            continue;
          }
          if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
            continue;
          }
          if (!res.ok) throw new Error(`Download failed: ${res.status}`);

          size = parseInt(res.headers.get("content-length") ?? "0", 10);

          const blobName_ = `${userId}/${albumId ?? "library"}/${randomUUID()}${ext}`;
          // Pipe the web ReadableStream → Node Readable → Azure Blob (4 MB blocks, 4 parallel)
          await uploadBlobFromStream(blobName_, Readable.fromWeb(res.body as any), mimeType);

          // Keep blobName visible after the loop
          (item as any).__blobName = blobName_;
          break;
        } catch (err: any) {
          clearTimeout(timeoutHandle);
          const isTransient =
            err?.name === "AbortError" ||
            String(err).includes("ECONNRESET") ||
            String(err).includes("ETIMEDOUT") ||
            String(err).includes("fetch failed");
          if (isTransient && attempt < MAX_RETRIES) {
            logger.warn({ attempt, itemId }, "Transient error streaming photo, retrying");
            await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
            continue;
          }
          throw err;
        }
      }

      // Keep resume store's accessToken in sync in case it was refreshed
      const resume = resumeDataStore.get(importId);
      if (resume) resume.accessToken = tokenHolder.accessToken;

      const blobName = (item as any).__blobName as string;
      const meta = item.mediaFile?.mediaFileMetadata;
      const [photo] = await db
        .insert(photosTable)
        .values({
          userId,
          filename: item.mediaFile?.filename || `photo${ext}`,
          blobName,
          contentType: mimeType,
          size,
          width: meta?.width ? Number(meta.width) : null,
          height: meta?.height ? Number(meta.height) : null,
          takenAt: item.createTime ? new Date(item.createTime) : null,
        })
        .returning();

      if (albumId) {
        await db
          .insert(albumPhotosTable)
          .values({ albumId, photoId: photo.id })
          .onConflictDoNothing();
      }

      processedIds.add(itemId);
      status.imported++;

      // Small delay to stay within Google's per-minute quota (avoid 429)
      await new Promise(r => setTimeout(r, 150));
    } catch (err: any) {
      logger.error({ err: String(err), itemId }, "Failed to import photo");
      status.errors++;
      // Bubble up storage/DB errors so outer catch marks as resumable
      if (
        String(err).includes("ECONNREFUSED") ||
        String(err).includes("ETIMEDOUT") ||
        String(err).includes("ENOTFOUND") ||
        String(err).includes("after retries")
      ) {
        throw err;
      }
    }
  }
}

// POST /api/google/auth-url — return Google OAuth URL
router.post("/google/auth-url", requireAuth, async (req: any, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: "Google import not configured." });
  }

  const albumName: string = (req.body as any)?.albumName?.trim() || "Google Photos Import";
  const targetAlbumId: string | undefined = (req.body as any)?.targetAlbumId || undefined;
  const noAlbum: boolean = !!(req.body as any)?.noAlbum;
  const redirectUri = `${apiOrigin(req)}/api/google/callback`;
  const state = randomUUID();
  pendingStates.set(state, { userId: req.currentUser.id, redirectUri, albumName, targetAlbumId, noAlbum });
  setTimeout(() => { pendingStates.delete(state); stateToImportId.delete(state); }, 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    state,
    prompt: "select_account consent",
  });

  res.json({ authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, state });
});

// GET /api/google/callback — exchange code, create picker session, start background import
router.get("/google/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  const frontendUrl = APP_URL;

  if (error || !code || !state) {
    return res.redirect(`${frontendUrl}/albums?import_error=${encodeURIComponent(error ?? "cancelled")}`);
  }
  const pending = pendingStates.get(state);
  if (!pending) {
    return res.redirect(`${frontendUrl}/albums?import_error=expired`);
  }
  pendingStates.delete(state);

  // Exchange auth code for access token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID!,
      client_secret: GOOGLE_CLIENT_SECRET!,
      redirect_uri: pending.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });

  if (!tokenRes.ok) {
    logger.error({ err: await tokenRes.text() }, "Google token exchange failed");
    return res.redirect(`${frontendUrl}/albums?import_error=auth_failed`);
  }

  const { access_token, refresh_token } = await tokenRes.json() as { access_token: string; refresh_token?: string };
  if (!refresh_token) {
    logger.warn("No refresh_token returned by Google — token refresh after expiry will not be possible");
  }

  // Persist encrypted refresh token for background auto-sync (upsert so re-auth refreshes it).
  if (refresh_token) {
    try {
      await db
        .insert(googleSyncTable)
        .values({
          userId: pending.userId,
          encryptedRefreshToken: encryptToken(refresh_token),
          syncEnabled: true,
          syncIntervalHours: 24,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: googleSyncTable.userId,
          set: {
            encryptedRefreshToken: encryptToken(refresh_token),
            updatedAt: new Date(),
          },
        });
      logger.info({ userId: pending.userId }, "[google-sync] refresh token saved (encrypted)");
    } catch (err) {
      logger.warn({ err: String(err) }, "[google-sync] failed to persist refresh token — auto-sync won't work");
    }
  }

  // Create a Photos Picker session
  const sessRes = await fetch("https://photospicker.googleapis.com/v1/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: "{}",
  });

  if (!sessRes.ok) {
    logger.error({ err: await sessRes.text() }, "Failed to create picker session");
    return res.redirect(`${frontendUrl}/albums?import_error=picker_failed`);
  }

  const session = await sessRes.json() as { id: string; pickerUri: string };
  const importId = randomUUID();

  importStatuses.set(importId, {
    status: "picking",
    albumName: pending.albumName,
    total: 0,
    imported: 0,
    errors: 0,
    pickerUri: session.pickerUri,
  });

  // Allow originating tab to resolve importId by state
  stateToImportId.set(state, importId);

  runImport(importId, session.id, pending.userId, access_token, refresh_token, pending.targetAlbumId, pending.noAlbum).catch(console.error);

  // Redirect this tab (the OAuth tab) straight to the picker so the user
  // only ever sees 2 tabs: APhoto + picker.
  return res.redirect(session.pickerUri);
});

// GET /api/google/import-by-state/:state — called by originating tab to get importId after new-tab OAuth
router.get("/google/import-by-state/:state", requireAuth, (req, res) => {
  const importId = stateToImportId.get(req.params.state);
  if (!importId) return res.status(202).json({ pending: true });
  res.json({ importId });
});

// GET /api/google/import/:id — poll import progress
router.get("/google/import/:id", requireAuth, (req, res) => {
  const status = importStatuses.get(req.params.id);
  if (!status) return res.status(404).json({ error: "Import not found" });
  res.json(status);
});

// DELETE /api/google/import/:id — cancel an in-progress import
router.delete("/google/import/:id", requireAuth, (req, res) => {
  const status = importStatuses.get(req.params.id);
  if (!status) return res.status(404).json({ error: "Import not found" });
  if (status.status === "done" || status.status === "error") {
    return res.json({ cancelled: false, message: "Import already finished" });
  }
  cancelledImports.add(req.params.id);
  status.status = "error";
  status.message = "Cancelled by user";
  res.json({ cancelled: true });
});

// POST /api/google/import/:id/resume — restart from where it left off
router.post("/google/import/:id/resume", requireAuth, async (req: any, res) => {
  const importId = req.params.id;
  const status = importStatuses.get(importId);
  const resume = resumeDataStore.get(importId);

  if (!status) return res.status(404).json({ error: "Import not found" });
  if (!resume) return res.status(409).json({ error: "No resume data available — please start a new import" });
  if (status.status === "importing") return res.status(409).json({ error: "Import is already running" });
  if (resume.userId !== req.currentUser.id) return res.status(403).json({ error: "Forbidden" });

  // Reset to importing state (keep imported/errors counts so progress is accurate)
  status.status = "importing";
  status.message = undefined;
  status.resumable = false;

  const remaining = resume.items.filter(item => {
    const id: string = item.id || item.mediaFile?.filename || "";
    return !resume.processedIds.has(id);
  });

  const skipped = resume.items.length - remaining.length;
  logger.info({ importId, total: resume.items.length, skipped, remaining: remaining.length }, "Resuming import");

  res.json({ resumed: true, remaining: remaining.length, skipped });

  // Run async
  (async () => {
    try {
      await processItems(importId, remaining, resume.processedIds, status, resume.accessToken, resume.refreshToken, resume.userId, resume.albumId);
      if (status.status !== "error") {
        status.status = "done";
        resumeDataStore.delete(importId);
      }
    } catch (err: any) {
      status.status = "error";
      status.message = String(err?.message ?? err);
      status.resumable = resumeDataStore.has(importId);
      logger.error({ err: String(err) }, "Google Photos resume failed");
    }
  })().catch(console.error);
});

// ── Auto-sync settings endpoints ──────────────────────────────────────────────

// GET /api/google/sync/status — return sync config + last/next sync times
router.get("/google/sync/status", requireAuth, async (req: any, res) => {
  const [row] = await db
    .select({
      syncEnabled:       googleSyncTable.syncEnabled,
      syncIntervalHours: googleSyncTable.syncIntervalHours,
      lastSyncAt:        googleSyncTable.lastSyncAt,
      syncAlbumId:       googleSyncTable.syncAlbumId,
    })
    .from(googleSyncTable)
    .where(eq(googleSyncTable.userId, req.currentUser.id))
    .limit(1);

  if (!row) return res.json({ connected: false });

  const nextSyncAt = row.lastSyncAt
    ? new Date(row.lastSyncAt.getTime() + row.syncIntervalHours * 3600 * 1000)
    : null;

  res.json({
    connected:         true,
    syncEnabled:       row.syncEnabled,
    syncIntervalHours: row.syncIntervalHours,
    lastSyncAt:        row.lastSyncAt,
    nextSyncAt,
    syncAlbumId:       row.syncAlbumId,
  });
});

// POST /api/google/sync/configure — update syncEnabled, syncIntervalHours, syncAlbumId
router.post("/google/sync/configure", requireAuth, async (req: any, res) => {
  const { syncEnabled, syncIntervalHours, syncAlbumId } = req.body as {
    syncEnabled?: boolean;
    syncIntervalHours?: number;
    syncAlbumId?: string | null;
  };

  const VALID_INTERVALS = [12, 24, 168];
  if (syncIntervalHours !== undefined && !VALID_INTERVALS.includes(syncIntervalHours)) {
    return res.status(400).json({ error: `syncIntervalHours must be one of ${VALID_INTERVALS.join(", ")}` });
  }

  const updateFields: Record<string, unknown> = { updatedAt: new Date() };
  if (syncEnabled !== undefined) updateFields.syncEnabled = syncEnabled;
  if (syncIntervalHours !== undefined) updateFields.syncIntervalHours = syncIntervalHours;
  if (syncAlbumId !== undefined) updateFields.syncAlbumId = syncAlbumId ?? null;

  const result = await db
    .update(googleSyncTable)
    .set(updateFields)
    .where(eq(googleSyncTable.userId, req.currentUser.id))
    .returning({ syncEnabled: googleSyncTable.syncEnabled, syncIntervalHours: googleSyncTable.syncIntervalHours, syncAlbumId: googleSyncTable.syncAlbumId });

  if (!result.length) return res.status(404).json({ error: "No Google sync connection found. Please connect Google Photos first." });
  res.json({ updated: true, ...result[0] });
});

// DELETE /api/google/sync/disconnect — remove stored token (disables auto-sync)
router.delete("/google/sync/disconnect", requireAuth, async (req: any, res) => {
  await db.delete(googleSyncTable).where(eq(googleSyncTable.userId, req.currentUser.id));
  res.json({ disconnected: true });
});

// POST /api/google/sync/trigger — kick off an immediate sync for the current user
// Returns a syncId that can be polled via GET /api/google/import/:id
router.post("/google/sync/trigger", requireAuth, async (req: any, res) => {
  const [row] = await db
    .select()
    .from(googleSyncTable)
    .where(eq(googleSyncTable.userId, req.currentUser.id))
    .limit(1);

  if (!row) {
    return res.status(404).json({ error: "No Google sync connection found. Please connect Google Photos first." });
  }
  if (!row.syncEnabled) {
    return res.status(409).json({ error: "Auto-sync is disabled. Enable it first or use the regular import." });
  }

  const syncId = randomUUID();
  importStatuses.set(syncId, {
    status: "importing",
    albumName: "Google Auto-Sync",
    total: 0,
    imported: 0,
    errors: 0,
  });

  res.json({ syncId });

  // Run in background — does not block the response
  (async () => {
    const { decryptToken } = await import("../lib/token-crypto.js");
    const status = importStatuses.get(syncId)!;
    try {
      const plainRefresh = decryptToken(row.encryptedRefreshToken);
      const accessToken = await refreshGoogleAccessToken(plainRefresh);
      if (!accessToken) throw new Error("Failed to obtain access token for manual trigger");

      // Fetch photos newer than lastSyncAt (or last 30 days if never synced)
      const sinceDate = row.lastSyncAt
        ? new Date(row.lastSyncAt.getTime() + 1000)
        : new Date(Date.now() - 30 * 24 * 3600 * 1000);

      const items = await fetchGoogleLibraryItems(accessToken, sinceDate);
      status.total = items.length;

      if (items.length === 0) {
        status.status = "done";
        status.message = "No new photos found.";
        return;
      }

      await importLibraryItems(items, row.userId, row.syncAlbumId ?? undefined, accessToken, plainRefresh, status);

      if (status.status !== "error") {
        status.status = "done";
        await db
          .update(googleSyncTable)
          .set({ lastSyncAt: new Date(), updatedAt: new Date() })
          .where(eq(googleSyncTable.userId, row.userId));
      }
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      status.status = "error";
      status.message = msg;
      // If the token lacks the required scope, clear it so the UI prompts reconnect
      if (msg.includes("PERMISSION_DENIED") || msg.includes("insufficient authentication scopes")) {
        await db.delete(googleSyncTable).where(eq(googleSyncTable.userId, row.userId)).catch(() => {});
        status.message = "Google Photos access was revoked or lacks required permissions. Please reconnect via 'Import from Google Photos'.";
      }
      logger.error({ err: msg, userId: row.userId }, "[google-sync] manual trigger failed");
    }
  })().catch(console.error);
});

// ── Shared helpers for Library API sync ──────────────────────────────────────

/** Fetch all media items created after `since` using the Google Photos Library API. */
export async function fetchGoogleLibraryItems(accessToken: string, since: Date): Promise<any[]> {
  const items: any[] = [];
  let pageToken: string | undefined;
  const startDate = {
    year:  since.getUTCFullYear(),
    month: since.getUTCMonth() + 1,
    day:   since.getUTCDate(),
  };
  const today = new Date();
  const endDate = {
    year:  today.getUTCFullYear(),
    month: today.getUTCMonth() + 1,
    day:   today.getUTCDate(),
  };

  do {
    const body: Record<string, unknown> = {
      pageSize: 100,
      filters: { dateFilter: { ranges: [{ startDate, endDate }] } },
    };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch("https://photoslibrary.googleapis.com/v1/mediaItems:search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 403 && text.includes("PERMISSION_DENIED")) {
        throw new Error(
          "Google Photos access token is missing the photoslibrary.readonly scope. " +
          "Please disconnect and reconnect Google Photos from the Albums page to grant the required permissions."
        );
      }
      throw new Error(`Library API error (${res.status}): ${text}`);
    }

    const data = await res.json() as { mediaItems?: any[]; nextPageToken?: string };
    if (data.mediaItems) items.push(...data.mediaItems);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return items;
}

/** Import Library API media items (dedup by googleMediaItemId), streaming to Azure Blob. */
export async function importLibraryItems(
  items: any[],
  userId: string,
  albumId: string | undefined,
  initialAccessToken: string,
  refreshToken: string,
  status: { total: number; imported: number; errors: number; status: string; message?: string },
): Promise<void> {
  const tokenHolder = { accessToken: initialAccessToken };

  for (const item of items) {
    const googleId: string = item.id;
    const mimeType: string = item.mimeType || "image/jpeg";
    const isVideo = mimeType.startsWith("video/");
    const ext = isVideo ? ".mp4" : ".jpg";

    try {
      // Dedup: skip if already imported
      const existing = await db
        .select({ id: photosTable.id })
        .from(photosTable)
        .where(eq(photosTable.googleMediaItemId, googleId))
        .limit(1);
      if (existing.length > 0) continue;

      const baseUrl: string = item.baseUrl || "";
      const downloadUrl = isVideo ? `${baseUrl}=dv` : `${baseUrl}=d`;

      const MAX_RETRIES = 3;
      let size = 0;
      let blobName = "";

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), 120_000);
        try {
          const res = await fetch(downloadUrl, {
            headers: { Authorization: `Bearer ${tokenHolder.accessToken}` },
            signal: controller.signal,
          });
          clearTimeout(timeoutHandle);

          if (res.status === 401 && attempt < MAX_RETRIES) {
            const newToken = await refreshGoogleAccessToken(refreshToken);
            if (newToken) tokenHolder.accessToken = newToken;
            continue;
          }
          if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
            continue;
          }
          if (!res.ok) throw new Error(`Download failed: ${res.status}`);

          size = parseInt(res.headers.get("content-length") ?? "0", 10);
          blobName = `${userId}/${albumId ?? "library"}/${randomUUID()}${ext}`;
          await uploadBlobFromStream(blobName, Readable.fromWeb(res.body as any), mimeType);
          break;
        } catch (err: any) {
          clearTimeout(timeoutHandle);
          const isTransient =
            err?.name === "AbortError" ||
            String(err).includes("ECONNRESET") ||
            String(err).includes("fetch failed");
          if (isTransient && attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
            continue;
          }
          throw err;
        }
      }

      if (!blobName) throw new Error("No blob uploaded");

      const meta = item.mediaMetadata;
      const [photo] = await db
        .insert(photosTable)
        .values({
          userId,
          filename: item.filename || `photo${ext}`,
          blobName,
          contentType: mimeType,
          size,
          width:  meta?.width  ? Number(meta.width)  : null,
          height: meta?.height ? Number(meta.height) : null,
          takenAt: meta?.creationTime ? new Date(meta.creationTime) : null,
          googleMediaItemId: googleId,
        })
        .returning();

      if (albumId) {
        await db
          .insert(albumPhotosTable)
          .values({ albumId, photoId: photo.id })
          .onConflictDoNothing();
      }

      status.imported++;
      await new Promise(r => setTimeout(r, 150)); // stay within Google quota
    } catch (err: any) {
      logger.error({ err: String(err), googleId, userId }, "[google-sync] failed to import item");
      status.errors++;
    }
  }
}

export default router;
