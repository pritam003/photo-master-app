import { Router } from "express";
import { cacheDelPattern } from "../lib/cache.js";

const router = Router();

function requireAuth(req: any, res: any, next: any) {
  const user = (req as Record<string, unknown>).user as Record<string, string> | undefined;
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  next();
}

router.use(requireAuth);

/**
 * POST /api/admin/restart
 *
 * Flushes all Redis caches, then exits the current process.
 * Azure Container Apps (and any OCI runtime) will automatically restart the
 * container on a clean exit, which causes:
 *   - API server: cold-start, module re-load
 *   - Worker sidecar: cold-start, face-recognition model re-initialise,
 *     face-scan job runs within 30 s of startup
 *
 * The response is flushed BEFORE exit so the client gets a 200 back.
 */
router.post("/admin/restart", async (_req, res) => {
  try {
    // Flush all cache keys so the first page loads are fresh
    await cacheDelPattern("*");
  } catch { /* non-fatal */ }

  res.json({ ok: true, message: "Restarting…" });

  // Slight delay to ensure the response is fully flushed to the client
  setTimeout(() => {
    process.exit(0);
  }, 300);
});

export default router;
