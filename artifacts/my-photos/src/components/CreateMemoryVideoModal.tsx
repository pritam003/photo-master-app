import { useState, useEffect, useRef, useCallback } from "react";
import {
  X,
  Film,
  Music,
  Check,
  Copy,
  Link2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  ChevronLeft,
} from "lucide-react";
import { API_BASE } from "@/lib/api";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Photo {
  id: string;
  thumbnailUrl?: string;
  url?: string;
  filename?: string;
}

interface MusicTrack {
  id: string;
  name: string;
  genre: string;
}

interface Props {
  albumId: string;
  albumName: string;
  photos: Photo[];
  onClose: () => void;
}

type Step = "select" | "music" | "generating" | "result";

type JobStatus = "pending" | "processing" | "complete" | "error";

interface JobPollResult {
  status: JobStatus;
  videoUrl?: string | null;
  error?: string | null;
}

// Genre → emoji
const GENRE_ICON: Record<string, string> = {
  cinematic: "🎬",
  joyful: "🎉",
  nostalgia: "🌅",
  ambient: "🌿",
  celebration: "🎊",
};

const MIN_PHOTOS = 15;
const MAX_PHOTOS = 20;
const POLL_INTERVAL_MS = 2500;

// ── Component ──────────────────────────────────────────────────────────────────

export default function CreateMemoryVideoModal({ albumName, photos, onClose }: Props) {
  const [step, setStep] = useState<Step>("select");

  // Step 1 — photo selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Step 2 — music
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

  // Step 3 — generation
  const [jobId, setJobId] = useState<string | null>(null);
  const [generatingError, setGeneratingError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Step 4 — result
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ── Photo selection helpers ──────────────────────────────────────────────────

  const togglePhoto = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_PHOTOS) {
        next.add(id);
      }
      return next;
    });
  };

  const selectFirst20 = () => {
    const ids = photos.slice(0, MAX_PHOTOS).map((p) => p.id);
    setSelected(new Set(ids));
  };

  // ── Music track loading ──────────────────────────────────────────────────────

  const loadTracks = useCallback(async () => {
    setTracksLoading(true);
    try {
      const res = await fetch(`${API_BASE}/videos/music-tracks`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        const list: MusicTrack[] = data.tracks ?? [];
        setTracks(list);
        if (list.length > 0) setSelectedTrackId(list[0].id);
      }
    } catch {
      // ignore — user can still see empty state
    } finally {
      setTracksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step === "music" && tracks.length === 0) {
      loadTracks();
    }
  }, [step, tracks.length, loadTracks]);

  // ── Video generation ─────────────────────────────────────────────────────────

  const startGeneration = async () => {
    if (!selectedTrackId) return;
    setStep("generating");
    setGeneratingError(null);

    try {
      const res = await fetch(`${API_BASE}/videos/memory`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photoIds: Array.from(selected),
          musicTrackId: selectedTrackId,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error ?? "Failed to start video generation");
      }

      const { jobId: newJobId } = await res.json();
      setJobId(newJobId);
      startPolling(newJobId);
    } catch (err: unknown) {
      setGeneratingError(err instanceof Error ? err.message : "Unknown error");
      setStep("generating"); // stay on generating step, show error inline
    }
  };

  const startPolling = (id: string) => {
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/videos/memory/${id}`, {
          credentials: "include",
        });
        if (!res.ok) return;
        const data: JobPollResult = await res.json();

        if (data.status === "complete" && data.videoUrl) {
          stopPolling();
          setVideoUrl(data.videoUrl);
          setStep("result");
        } else if (data.status === "error") {
          stopPolling();
          setGeneratingError(data.error ?? "Video generation failed. Please try again.");
        }
      } catch {
        // transient network error — keep polling
      }
    }, POLL_INTERVAL_MS);
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // Stop polling on unmount
  useEffect(() => () => stopPolling(), []);

  // ── Copy link ────────────────────────────────────────────────────────────────

  const copyLink = async () => {
    if (!videoUrl) return;
    try {
      await navigator.clipboard.writeText(videoUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API blocked — select the input text as fallback
    }
  };

  // ── Reset to start a new video ───────────────────────────────────────────────

  const reset = () => {
    stopPolling();
    setStep("select");
    setSelected(new Set());
    setSelectedTrackId(tracks[0]?.id ?? null);
    setJobId(null);
    setGeneratingError(null);
    setVideoUrl(null);
    setCopied(false);
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  const canProceedFromSelect = selected.size >= MIN_PHOTOS;
  const canGenerate = !!selectedTrackId;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Film className="w-4 h-4 text-primary" />
            <h2 className="text-base font-semibold text-foreground">
              Memory Video — <span className="text-muted-foreground font-normal">{albumName}</span>
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Step indicator ── */}
        {step !== "result" && (
          <div className="flex items-center gap-1.5 px-6 pt-4 shrink-0">
            {(["select", "music", "generating"] as const).map((s, i) => (
              <div key={s} className="flex items-center gap-1.5">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold transition-colors
                    ${step === s ? "bg-primary text-primary-foreground" :
                      (["select", "music", "generating"].indexOf(step) > i
                        ? "bg-primary/20 text-primary"
                        : "bg-muted text-muted-foreground")
                    }`}
                >
                  {["select", "music", "generating"].indexOf(step) > i ? (
                    <Check className="w-3 h-3" />
                  ) : (
                    i + 1
                  )}
                </div>
                <span className={`text-xs ${step === s ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                  {s === "select" ? "Photos" : s === "music" ? "Music" : "Create"}
                </span>
                {i < 2 && <div className="w-6 h-px bg-border" />}
              </div>
            ))}
          </div>
        )}

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── STEP 1: Photo selection ── */}
          {step === "select" && (
            <div className="p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Select {MIN_PHOTOS}–{MAX_PHOTOS} photos for your video.{" "}
                  <span className={`font-medium ${selected.size >= MIN_PHOTOS ? "text-primary" : ""}`}>
                    {selected.size} selected
                  </span>
                </p>
                <button
                  onClick={selectFirst20}
                  className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                >
                  Select first {MAX_PHOTOS}
                </button>
              </div>

              <div className="grid grid-cols-4 sm:grid-cols-5 gap-1.5">
                {photos.map((photo) => {
                  const isSelected = selected.has(photo.id);
                  const isDisabled = !isSelected && selected.size >= MAX_PHOTOS;
                  return (
                    <button
                      key={photo.id}
                      onClick={() => !isDisabled && togglePhoto(photo.id)}
                      disabled={isDisabled}
                      className={`relative aspect-square rounded-lg overflow-hidden transition-all
                        ${isSelected
                          ? "ring-2 ring-primary ring-offset-1 ring-offset-card"
                          : "hover:opacity-80"}
                        ${isDisabled ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}
                      `}
                    >
                      <img
                        src={photo.thumbnailUrl || photo.url}
                        alt={photo.filename ?? "photo"}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                      {isSelected && (
                        <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                          <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                            <Check className="w-3 h-3 text-primary-foreground" />
                          </div>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              {photos.length === 0 && (
                <p className="text-center text-muted-foreground py-12 text-sm">
                  No photos in this album yet.
                </p>
              )}
            </div>
          )}

          {/* ── STEP 2: Music picker ── */}
          {step === "music" && (
            <div className="p-6 flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Choose a background track for your memory video.
              </p>

              {tracksLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : tracks.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-12 text-center">
                  <Music className="w-8 h-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    No music tracks found. Drop MP3 files into{" "}
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      src/assets/music/
                    </code>{" "}
                    on the server.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {tracks.map((track) => {
                    const isSelected = selectedTrackId === track.id;
                    return (
                      <button
                        key={track.id}
                        onClick={() => setSelectedTrackId(track.id)}
                        className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all
                          ${isSelected
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/40 hover:bg-muted"}
                        `}
                      >
                        <span className="text-2xl shrink-0">
                          {GENRE_ICON[track.genre] ?? "🎵"}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {track.name}
                          </p>
                          <p className="text-xs text-muted-foreground capitalize">{track.genre}</p>
                        </div>
                        {isSelected && (
                          <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                            <Check className="w-3 h-3 text-primary-foreground" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── STEP 3: Generating ── */}
          {step === "generating" && (
            <div className="p-6 flex flex-col items-center justify-center gap-6 min-h-[280px]">
              {generatingError ? (
                <>
                  <AlertCircle className="w-12 h-12 text-destructive" />
                  <div className="text-center">
                    <p className="font-semibold text-foreground">Generation failed</p>
                    <p className="text-sm text-muted-foreground mt-1">{generatingError}</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="relative">
                    <Film className="w-12 h-12 text-primary/30" />
                    <Loader2 className="w-6 h-6 text-primary animate-spin absolute -bottom-1 -right-1" />
                  </div>
                  <div className="text-center">
                    <p className="font-semibold text-foreground">Creating your memory video…</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      This takes about 60–90 seconds. You can keep this open.
                    </p>
                    {jobId && (
                      <p className="text-xs text-muted-foreground/60 mt-2 font-mono">
                        Job: {jobId.slice(0, 8)}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── STEP 4: Result ── */}
          {step === "result" && videoUrl && (
            <div className="p-6 flex flex-col items-center gap-6">
              <CheckCircle2 className="w-14 h-14 text-green-500" />
              <div className="text-center">
                <p className="font-semibold text-foreground text-lg">Your memory video is ready!</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Share this link — it expires in 7 days.
                </p>
              </div>

              <div className="w-full flex gap-2">
                <div className="flex-1 flex items-center gap-2 bg-muted rounded-lg px-3 py-2 min-w-0">
                  <Link2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <input
                    readOnly
                    value={videoUrl}
                    className="flex-1 bg-transparent text-xs text-foreground outline-none truncate"
                    onFocus={(e) => e.target.select()}
                  />
                </div>
                <button
                  onClick={copyLink}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors shrink-0"
                >
                  {copied ? (
                    <><Check className="w-3.5 h-3.5" /> Copied</>
                  ) : (
                    <><Copy className="w-3.5 h-3.5" /> Copy</>
                  )}
                </button>
              </div>

              <a
                href={videoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline"
              >
                Open video in new tab ↗
              </a>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="px-6 py-4 border-t border-border flex items-center justify-between shrink-0">
          {/* Left: back or create another */}
          {step === "select" && (
            <button
              onClick={onClose}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          )}
          {step === "music" && (
            <button
              onClick={() => setStep("select")}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
          )}
          {step === "generating" && (
            <div />
          )}
          {step === "result" && (
            <button
              onClick={reset}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Create another
            </button>
          )}

          {/* Right: primary action */}
          {step === "select" && (
            <button
              onClick={() => setStep("music")}
              disabled={!canProceedFromSelect}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          )}
          {step === "music" && (
            <button
              onClick={startGeneration}
              disabled={!canGenerate}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <Film className="w-4 h-4" /> Create video
            </button>
          )}
          {step === "generating" && generatingError && (
            <button
              onClick={reset}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Try again
            </button>
          )}
          {step === "result" && (
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted transition-colors"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
