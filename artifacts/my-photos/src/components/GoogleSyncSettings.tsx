import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw, CheckCircle, AlertCircle, Loader2,
  Clock, Calendar, ToggleLeft, ToggleRight, ChevronDown, Unplug,
} from "lucide-react";
import { API_BASE } from "@/lib/api";
import { useImport } from "@/lib/importContext";

interface SyncStatus {
  connected: boolean;
  syncEnabled?: boolean;
  syncIntervalHours?: number;
  lastSyncAt?: string | null;
  nextSyncAt?: string | null;
  syncAlbumId?: string | null;
}

interface Album {
  id: string;
  name: string;
}

const INTERVAL_OPTIONS = [
  { value: 12,  label: "Every 12 hours" },
  { value: 24,  label: "Every 24 hours" },
  { value: 168, label: "Every 7 days" },
];

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)   return "Just now";
  if (mins < 60)  return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function timeUntil(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "Overdue";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60)  return `in ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `in ${hrs}h`;
  return `in ${Math.floor(hrs / 24)}d`;
}

export default function GoogleSyncSettings({ albums }: { albums?: Album[] }) {
  const { startImport } = useImport();

  const [status, setStatus]           = useState<SyncStatus | null>(null);
  const [loading, setLoading]         = useState(true);
  const [toggling, setToggling]       = useState(false);
  const [triggering, setTriggering]   = useState(false);
  const [disconnecting, setDisc]      = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [showAlbumPicker, setShowAP]  = useState(false);
  const [showIntervalPicker, setShowIP] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/google/sync/status`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      setStatus(await res.json() as SyncStatus);
    } catch (e) {
      setError(`Could not load sync status: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Refresh status every 30 s so "last synced" updates automatically
  useEffect(() => {
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const configure = async (patch: Partial<Pick<SyncStatus, "syncEnabled" | "syncIntervalHours" | "syncAlbumId">>) => {
    try {
      const res = await fetch(`${API_BASE}/google/sync/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `${res.status}`);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleToggle = async () => {
    if (!status?.connected) return;
    setToggling(true);
    await configure({ syncEnabled: !status.syncEnabled });
    setToggling(false);
  };

  const handleIntervalChange = async (hours: number) => {
    setShowIP(false);
    await configure({ syncIntervalHours: hours });
  };

  const handleAlbumChange = async (albumId: string | null) => {
    setShowAP(false);
    await configure({ syncAlbumId: albumId });
  };

  const handleSyncNow = async () => {
    setTriggering(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/google/sync/trigger`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json() as { syncId?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `${res.status}`);
      if (data.syncId) startImport(data.syncId);
    } catch (e) {
      setError(String(e));
    } finally {
      setTriggering(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect Google Photos? Auto-sync will stop. Your imported photos will remain.")) return;
    setDisc(true);
    try {
      await fetch(`${API_BASE}/google/sync/disconnect`, { method: "DELETE", credentials: "include" });
      await load();
    } finally {
      setDisc(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading sync status…
      </div>
    );
  }

  if (!status?.connected) {
    return (
      <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <p>Auto-sync is not connected. Use <strong>Import from Google Photos</strong> to sign in — auto-sync will be enabled automatically.</p>
      </div>
    );
  }

  const selectedAlbumName = albums?.find(a => a.id === status.syncAlbumId)?.name ?? "Library (no album)";
  const selectedInterval  = INTERVAL_OPTIONS.find(o => o.value === status.syncIntervalHours)?.label ?? `Every ${status.syncIntervalHours}h`;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Google Photos Auto-Sync</span>
        </div>
        {/* Enable / disable toggle */}
        <button
          onClick={handleToggle}
          disabled={toggling}
          className="flex items-center gap-1.5 text-xs font-medium transition-colors disabled:opacity-50"
          title={status.syncEnabled ? "Disable auto-sync" : "Enable auto-sync"}
        >
          {toggling ? (
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          ) : status.syncEnabled ? (
            <><ToggleRight className="w-5 h-5 text-primary" /><span className="text-primary">Enabled</span></>
          ) : (
            <><ToggleLeft className="w-5 h-5 text-muted-foreground" /><span className="text-muted-foreground">Disabled</span></>
          )}
        </button>
      </div>

      {/* Status row */}
      <div className="grid grid-cols-2 gap-px bg-border">
        <div className="bg-card px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1 flex items-center gap-1">
            <CheckCircle className="w-3 h-3" /> Last synced
          </p>
          <p className="text-sm font-medium text-foreground">{relativeTime(status.lastSyncAt)}</p>
        </div>
        <div className="bg-card px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1 flex items-center gap-1">
            <Clock className="w-3 h-3" /> Next sync
          </p>
          <p className="text-sm font-medium text-foreground">{status.syncEnabled ? timeUntil(status.nextSyncAt) : "—"}</p>
        </div>
      </div>

      {/* Settings row */}
      <div className="px-4 py-3 space-y-2.5">
        {/* Interval picker */}
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5" /> Sync interval
          </label>
          <div className="relative">
            <button
              onClick={() => setShowIP(p => !p)}
              className="flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-primary transition-colors px-2.5 py-1 rounded-lg border border-border hover:border-primary/40"
            >
              {selectedInterval} <ChevronDown className="w-3 h-3" />
            </button>
            {showIntervalPicker && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-xl shadow-xl overflow-hidden min-w-[160px]">
                {INTERVAL_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => handleIntervalChange(opt.value)}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-muted transition-colors ${
                      status.syncIntervalHours === opt.value ? "text-primary font-semibold" : "text-foreground"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Album picker */}
        {albums && (
          <div className="flex items-center justify-between">
            <label className="text-xs text-muted-foreground">Save to album</label>
            <div className="relative">
              <button
                onClick={() => setShowAP(p => !p)}
                className="flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-primary transition-colors px-2.5 py-1 rounded-lg border border-border hover:border-primary/40 max-w-[160px] truncate"
              >
                <span className="truncate">{selectedAlbumName}</span>
                <ChevronDown className="w-3 h-3 shrink-0" />
              </button>
              {showAlbumPicker && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-xl shadow-xl overflow-hidden min-w-[180px] max-h-48 overflow-y-auto">
                  <button
                    onClick={() => handleAlbumChange(null)}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-muted transition-colors ${
                      !status.syncAlbumId ? "text-primary font-semibold" : "text-foreground"
                    }`}
                  >
                    Library (no album)
                  </button>
                  {albums.map(a => (
                    <button
                      key={a.id}
                      onClick={() => handleAlbumChange(a.id)}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-muted transition-colors ${
                        status.syncAlbumId === a.id ? "text-primary font-semibold" : "text-foreground"
                      }`}
                    >
                      {a.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-border gap-2">
        <button
          onClick={handleSyncNow}
          disabled={triggering || !status.syncEnabled}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {triggering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Sync now
        </button>
        <button
          onClick={handleDisconnect}
          disabled={disconnecting}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-destructive border border-border hover:border-destructive/40 transition-colors disabled:opacity-50"
        >
          {disconnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unplug className="w-3.5 h-3.5" />}
          Disconnect
        </button>
      </div>
    </div>
  );
}
