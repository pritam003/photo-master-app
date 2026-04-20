import { useState, useEffect, useCallback } from "react";
import { Users, ScanFace, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import PersonCard from "@/components/PersonCard";

interface Person {
  id: string;
  name: string | null;
  coverUrl: string | null;
  faceCount: number;
}

async function fetchPeople(): Promise<{ people: Person[] }> {
  const res = await fetch(`${API_BASE}/people`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch people");
  return res.json();
}

export default function PeoplePage() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["people"],
    queryFn: fetchPeople,
    staleTime: 2 * 60 * 1000,
    refetchInterval: 60 * 1000, // refresh every minute while page is open
  });

  const [scanProgress, setScanProgress] = useState<{ running: boolean; processed: number; total: number } | null>(null);
  const [scanStarting, setScanStarting] = useState(false);

  const startScan = useCallback(async () => {
    setScanStarting(true);
    try {
      await fetch(`${API_BASE}/people/start-scan`, { method: "POST", credentials: "include" });
    } catch {}
    setScanStarting(false);
  }, []);

  // Poll scan-progress every 4s; refetch people when running → done
  useEffect(() => {
    let wasRunning = false;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/people/scan-progress`, { credentials: "include" });
        if (!res.ok) return;
        const progress = await res.json();
        setScanProgress(progress);
        if (wasRunning && !progress.running) refetch();
        wasRunning = progress.running;
      } catch {}
    }, 4000);
    // initial fetch
    fetch(`${API_BASE}/people/scan-progress`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setScanProgress(d))
      .catch(() => {});
    return () => clearInterval(interval);
  }, [refetch]);

  const people = data?.people ?? [];
  const scanPct = scanProgress && scanProgress.total > 0
    ? Math.round((scanProgress.processed / scanProgress.total) * 100)
    : 0;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Users className="w-6 h-6 text-primary" />
        <h1 className="text-2xl font-semibold">People</h1>
        {!isLoading && people.length > 0 && (
          <span className="text-sm text-muted-foreground">
            {people.length} {people.length === 1 ? "person" : "people"}
          </span>
        )}
        <div className="flex-1" />
        {/* Scan button */}
        <button
          onClick={startScan}
          disabled={scanStarting || scanProgress?.running}
          className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {scanProgress?.running
            ? <RefreshCw className="w-4 h-4 animate-spin" />
            : <ScanFace className="w-4 h-4" />}
          {scanProgress?.running ? "Scanning…" : "Scan for faces"}
        </button>
      </div>

      {/* Face scan progress bar — shown whenever there are unprocessed photos */}
      {scanProgress && scanProgress.total > 0 && (
        <div className="mb-6 p-4 rounded-xl border border-border bg-muted/40">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="font-medium text-foreground">
              {scanProgress.running ? "Scanning faces…" : "Scan progress"}
            </span>
            <span className="text-muted-foreground">
              {scanProgress.processed} / {scanProgress.total} photos
            </span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500"
              style={{ width: `${scanPct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            {scanPct}% scanned
            {scanProgress.running ? " · People will appear as photos are processed" : " · Click \"Scan for faces\" to process remaining photos"}
          </p>
        </div>
      )}

      {isLoading && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-2">
              <div className="w-24 h-24 rounded-full bg-muted animate-pulse" />
              <div className="h-3 w-16 rounded bg-muted animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {!isLoading && people.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mb-5">
            <ScanFace className="w-10 h-10 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold mb-2">No people found yet</h2>
          <p className="text-sm text-muted-foreground max-w-sm mb-6">
            Face recognition scans your photos and groups people automatically.
            Click "Scan for faces" to start, or wait for the background scan to finish.
          </p>
          <button
            onClick={startScan}
            disabled={scanStarting || scanProgress?.running}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {scanProgress?.running
              ? <RefreshCw className="w-4 h-4 animate-spin" />
              : <ScanFace className="w-4 h-4" />}
            {scanProgress?.running ? "Scanning in progress…" : "Scan for faces"}
          </button>
        </div>
      )}

      {!isLoading && people.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-6">
          {people.map((person) => (
            <PersonCard
              key={person.id}
              id={person.id}
              name={person.name}
              coverUrl={person.coverUrl}
              faceCount={person.faceCount}
            />
          ))}
        </div>
      )}
    </div>
  );
}
