import { useState, useEffect } from "react";
import { Users } from "lucide-react";
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
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["people"],
    queryFn: fetchPeople,
    staleTime: 2 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
  });

  const [scanProgress, setScanProgress] = useState<{ running: boolean; processed: number; total: number } | null>(null);

  // Poll scan-progress every 3s; stop when job finishes and refetch people
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/people/scan-progress`, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();
        setScanProgress(data);
        if (!data.running && interval) {
          clearInterval(interval);
          refetch();
        }
      } catch {}
    };
    poll();
    interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [refetch]);

  const people = data?.people ?? [];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Users className="w-6 h-6 text-primary" />
        <h1 className="text-2xl font-semibold">People</h1>
        {!isLoading && (
          <span className="text-sm text-muted-foreground">
            {people.length} {people.length === 1 ? "person" : "people"}
          </span>
        )}
        <div className="flex-1" />
      </div>

      {/* Face scan progress bar */}
      {scanProgress && scanProgress.running && scanProgress.total > 0 && (
        <div className="mb-6 p-4 rounded-xl border border-border bg-muted/40">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="font-medium text-foreground">Scanning faces…</span>
            <span className="text-muted-foreground">
              {scanProgress.processed} / {scanProgress.total} photos
            </span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500"
              style={{ width: `${Math.round((scanProgress.processed / scanProgress.total) * 100)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            {Math.round((scanProgress.processed / scanProgress.total) * 100)}% complete · People will appear as photos are processed
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
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
            <Users className="w-8 h-8 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-medium mb-1">No people yet</h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            Upload photos and faces will be automatically detected and grouped here.
          </p>
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
