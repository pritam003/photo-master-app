import { useState, useEffect, useRef } from "react";
import { X, CheckCircle, AlertCircle, Loader2, FolderDown, ExternalLink, FolderInput, ChevronDown, ChevronUp } from "lucide-react";
import { useLocation } from "wouter";
import { API_BASE } from "@/lib/api";
import { useImport } from "@/lib/importContext";

interface GoogleImportModalProps {
  onClose: () => void;
  activeImportId?: string | null;
  /** Album-detail: auto-import into this album ID (no folder creation shown) */
  targetAlbumId?: string;
  /** Album-detail: album name shown in the progress panel */
  albumDisplayName?: string;
  /** Albums list page: show folder name input so user can create a new album */
  allowCreateAlbum?: boolean;
  /** Called once when import finishes successfully */
  onDone?: (albumId?: string) => void;
}

interface ImportStatus {
  status: "picking" | "importing" | "done" | "error";
  albumName: string; albumId?: string;
  total: number; imported: number; skipped: number; errors: number;
  message?: string; pickerUri?: string;
}

interface ThumbPhoto { id: string; thumbnailUrl: string; }

export default function GoogleImportModal({ onClose, activeImportId, targetAlbumId, albumDisplayName, allowCreateAlbum, onDone }: GoogleImportModalProps) {
  const [, navigate] = useLocation();
  const { startImport, clearImport } = useImport();
  const [albumName, setAlbumName] = useState("");
  const [connectError, setConnectError] = useState("");
  const [importId, setImportId]     = useState<string | null>(activeImportId ?? null);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [starting, setStarting]     = useState(false);
  const [pendingState, setPendingState] = useState<string | null>(null);
  const [thumbs, setThumbs]         = useState<ThumbPhoto[]>([]);
  const [collapsed, setCollapsed]   = useState(false);
  const pollRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const thumbPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneFiredRef = useRef(false);

  // Register importId with global context so banner works across pages
  useEffect(() => {
    if (importId) startImport(importId);
  }, [importId, startImport]);

  // Fire onDone once when status transitions to "done", then auto-close after 2s
  useEffect(() => {
    if (importStatus?.status === "done" && !doneFiredRef.current) {
      doneFiredRef.current = true;
      onDone?.(importStatus.albumId);
      clearImport();
      setTimeout(() => onClose(), 2000);
    }
  }, [importStatus?.status, importStatus?.albumId, onDone, onClose, clearImport]);

  // Phase A: poll for importId by state (OAuth tab open)
  useEffect(() => {
    if (!pendingState || importId) return;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/google/import-by-state/${pendingState}`, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json() as { importId?: string };
        if (data.importId) { setImportId(data.importId); startImport(data.importId); clearInterval(pollRef.current!); pollRef.current = null; }
      } catch { /* keep polling */ }
    };
    pollRef.current = setInterval(poll, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pendingState, importId]);

  // Phase B: poll import status
  useEffect(() => {
    if (!importId) return;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/google/import/${importId}`, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json() as ImportStatus;
        setImportStatus(data);
        if (data.status === "done" || data.status === "error") { clearInterval(pollRef.current!); pollRef.current = null; }
      } catch { /* keep polling */ }
    };
    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [importId]);

  // Phase C: poll album photos for live thumbnails — newest first, capped to import batch size
  useEffect(() => {
    const albumId = importStatus?.albumId;
    const total = importStatus?.total ?? 40;
    if (!albumId || importStatus?.status === "error") return;
    const fetch_ = async () => {
      try {
        const res = await fetch(`${API_BASE}/albums/${albumId}/photos?orderBy=uploaded`, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json() as { photos: ThumbPhoto[] };
        if (data.photos?.length) setThumbs(data.photos.slice(0, total));
      } catch { /* ignore */ }
    };
    fetch_();
    if (importStatus?.status !== "done") {
      thumbPollRef.current = setInterval(fetch_, 3000);
    }
    return () => { if (thumbPollRef.current) clearInterval(thumbPollRef.current); };
  }, [importStatus?.albumId, importStatus?.status, importStatus?.total]);

  const handleConnect = async () => {
    setConnectError(""); setStarting(true);
    try {
      const res = await fetch(`${API_BASE}/google/auth-url`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          albumName: targetAlbumId
            ? (albumDisplayName || "Google Photos Import")
            : (albumName.trim() || "Google Photos Import"),
          targetAlbumId,
          noAlbum: !allowCreateAlbum && !targetAlbumId,
        }),
      });
      const data = await res.json() as { authUrl?: string; state?: string; error?: string };
      if (!res.ok || !data.authUrl) { setConnectError(data.error ?? "Failed to connect. Please try again."); return; }
      window.open(data.authUrl, "_blank", "noopener,noreferrer");
      setPendingState(data.state!);   // → triggers switch to bottom panel
    } catch { setConnectError("Network error — please try again."); }
    finally { setStarting(false); }
  };

  const pct = importStatus && importStatus.total > 0
    ? Math.round(((importStatus.imported + importStatus.errors) / importStatus.total) * 100)
    : 0;

  // Show center modal only during initial setup (before Connect is clicked)
  const isSetup = !pendingState && !importId;

  /* ─── SETUP: center modal ──────────────────────────────────────────── */
  if (isSetup) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
        <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <div className="flex items-center gap-2.5">
              <FolderDown className="w-5 h-5 text-primary" />
              <h2 className="text-base font-semibold text-foreground">Import from Google Photos</h2>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-6 space-y-5">
            <p className="text-sm text-muted-foreground">
              {targetAlbumId
                ? "Select photos from Google to add to this album."
                : allowCreateAlbum
                ? "Give the album a name, then sign in with Google to select which photos to import."
                : "Select photos from Google Photos to import to your library."}
            </p>
            {allowCreateAlbum && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
                  <FolderInput className="w-3.5 h-3.5" /> Folder name
                </label>
                <input
                  type="text" value={albumName} onChange={e => setAlbumName(e.target.value)}
                  placeholder="e.g. Summer 2021"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  onKeyDown={e => { if (e.key === "Enter" && !starting) handleConnect(); }}
                />
              </div>
            )}
            {connectError && <p className="text-xs text-destructive">{connectError}</p>}
            <button
              onClick={handleConnect} disabled={starting}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {starting ? <><Loader2 className="w-4 h-4 animate-spin" /> Opening Google sign-in…</> : "Connect Google Photos"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ─── ACTIVE: hand off to global banner, show minimal waiting UI ──────── */
  // Once we have an importId OR we're in "picking" or "importing" state,
  // the global ImportProgressBanner handles everything — close this modal.
  if (importId || (importStatus && importStatus.status !== "error")) {
    return null;
  }

  // Waiting for the OAuth tab to come back (pendingState set, but no importId yet)
  if (pendingState && !importId) {
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm p-4">
        <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm p-5 space-y-3">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-primary animate-spin shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground">Waiting for Google sign-in…</p>
              <p className="text-xs text-muted-foreground mt-0.5">Complete sign-in in the tab that just opened, then select your photos.</p>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-muted text-muted-foreground shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Only show error state if something went wrong before import started
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm p-5 space-y-3">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-destructive shrink-0" />
          <p className="text-sm font-medium text-foreground">Import failed</p>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-muted text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        {importStatus?.message && <p className="text-xs text-muted-foreground">{importStatus.message}</p>}
        <button onClick={onClose} className="w-full py-2 rounded-lg border border-border text-sm hover:bg-muted transition-colors">Close</button>
      </div>
    </div>
  );

}
