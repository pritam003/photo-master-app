import { useCallback, useState, useRef, useEffect } from "react";
import { X, CloudUpload, CheckCircle, AlertCircle, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListPhotosQueryKey, getGetPhotoStatsQueryKey,
  getListAlbumPhotosQueryKey, getListAlbumsQueryKey,
} from "@workspace/api-client-react";
import { API_BASE } from "@/lib/api";
import exifr from "exifr";

function parseExifDate(raw: unknown): string | null {
  if (!raw) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw.toISOString();
  if (typeof raw === "string") {
    const n = raw.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").replace(" ", "T");
    const d = new Date(n);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

interface UploadModalProps { onClose: () => void; albumId?: string; albumName?: string; initialFiles?: File[]; }
interface UploadFile {
  file: File; status: "pending" | "uploading" | "done" | "error";
  previewUrl: string; error?: string;
}

function VideoThumb({ file }: { file: File }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata"; v.muted = true; v.playsInline = true; v.src = url;
    v.addEventListener("loadedmetadata", () => { v.currentTime = Math.min(1, v.duration / 2); });
    v.addEventListener("seeked", () => {
      const c = document.createElement("canvas");
      c.width = v.videoWidth || 96; c.height = v.videoHeight || 96;
      c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
      setThumb(c.toDataURL()); URL.revokeObjectURL(url);
    });
    v.addEventListener("error", () => URL.revokeObjectURL(url));
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (!thumb) return <div className="w-full h-full bg-muted flex items-center justify-center text-muted-foreground text-xs">▶</div>;
  return <img src={thumb} alt="" className="w-full h-full object-cover" />;
}

export default function UploadModal({ onClose, albumId, albumName, initialFiles }: UploadModalProps) {
  const queryClient = useQueryClient();
  const [files, setFiles]     = useState<UploadFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [phase, setPhase]     = useState<"selecting" | "uploading">("selecting");
  const [collapsed, setCollapsed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (list: File[]) => {
    const valid = list.filter(f => f.type.startsWith("image/") || f.type.startsWith("video/"));
    setFiles(prev => [...prev, ...valid.map(f => ({
      file: f, status: "pending" as const,
      previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : "",
    }))]);
  };

  // Pre-populate files shared from the device gallery via the Share Target API
  useEffect(() => {
    if (initialFiles && initialFiles.length > 0) addFiles(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false); addFiles(Array.from(e.dataTransfer.files));
  }, []);

  const startUpload = async () => {
    setPhase("uploading");        // → switch to bottom panel immediately
    const snapshot = [...files];  // capture current list
    for (let i = 0; i < snapshot.length; i++) {
      if (snapshot[i].status !== "pending") continue;
      setFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: "uploading" } : f));
      try {
        const f = snapshot[i].file;
        let takenAt: string | null = null;
        if (f.type.startsWith("image/")) {
          const exif = await exifr.parse(f, { pick: ["DateTimeOriginal","DateTimeDigitized","CreateDate","DateTime"] }).catch(() => null);
          takenAt = parseExifDate(exif?.DateTimeOriginal ?? exif?.DateTimeDigitized ?? exif?.CreateDate ?? exif?.DateTime);
        }
        const presignRes = await fetch(`${API_BASE}/photos/presign`, {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify({ filename: f.name, contentType: f.type, albumId }),
        });
        if (!presignRes.ok) throw new Error(await presignRes.text());
        const { uploadUrl, blobName, cacheControl } = await presignRes.json() as { uploadUrl: string | null; blobName: string; cacheControl?: string };
        if (uploadUrl) {
          const putRes = await fetch(uploadUrl, {
            method: "PUT",
            headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": f.type, ...(cacheControl ? { "x-ms-blob-cache-control": cacheControl } : {}) },
            body: f,
          });
          if (!putRes.ok) throw new Error(`Blob upload failed: ${putRes.status}`);
          const regRes = await fetch(`${API_BASE}/photos/register`, {
            method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
            body: JSON.stringify({ blobName, filename: f.name, contentType: f.type, size: f.size, albumId, takenAt }),
          });
          if (!regRes.ok) throw new Error(await regRes.text());
        } else {
          const fd = new FormData();
          fd.append("file", f);
          if (albumId) fd.append("albumId", albumId);
          const res = await fetch(`${API_BASE}/photos`, { method: "POST", body: fd, credentials: "include" });
          if (!res.ok) throw new Error(await res.text());
        }
        setFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: "done" } : f));
        // Refresh the grid after each successful upload so photos appear live
        queryClient.invalidateQueries({ queryKey: getListPhotosQueryKey() });
        if (albumId) queryClient.invalidateQueries({ queryKey: getListAlbumPhotosQueryKey(albumId) });
      } catch (err) {
        setFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: "error", error: String(err) } : f));
      }
    }
    queryClient.invalidateQueries({ queryKey: getGetPhotoStatsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
  };

  const pendingCount = files.filter(f => f.status === "pending").length;
  const doneCount    = files.filter(f => f.status === "done").length;
  const isUploading  = files.some(f => f.status === "uploading");
  const allDone      = phase === "uploading" && files.length > 0 && files.every(f => f.status === "done" || f.status === "error");

  /* ─── PHASE: selecting — center modal ─────────────────────────────── */
  if (phase === "selecting") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
        <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <h2 className="text-base font-semibold text-foreground">
              {albumName ? `Upload to "${albumName}"` : "Upload Photos"}
            </h2>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-6 space-y-4">
            {/* Drop zone */}
            <div
              onDrop={handleDrop}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onClick={() => inputRef.current?.click()}
              data-testid="upload-dropzone"
              className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
                isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/30"
              }`}
            >
              <CloudUpload className={`w-10 h-10 mx-auto mb-3 ${isDragging ? "text-primary" : "text-muted-foreground"}`} />
              <p className="text-sm font-medium text-foreground">Drop photos here</p>
              <p className="text-xs text-muted-foreground mt-1">or click to browse — JPG, PNG, HEIC, MP4</p>
              <input ref={inputRef} type="file" multiple accept="image/*,video/*" className="hidden"
                onChange={e => addFiles(Array.from(e.target.files || []))} />
            </div>

            {/* Selected file list */}
            {files.length > 0 && (
              <div className="max-h-48 overflow-y-auto space-y-2">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-muted/40">
                    <div className="w-10 h-10 rounded overflow-hidden shrink-0 bg-muted">
                      {f.file.type.startsWith("video/")
                        ? <VideoThumb file={f.file} />
                        : <img src={f.previewUrl} alt="" className="w-full h-full object-cover" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground truncate">{f.file.name}</p>
                      <p className="text-xs text-muted-foreground">{(f.file.size / 1024 / 1024).toFixed(1)} MB</p>
                    </div>
                    <button
                      onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))}
                      className="p-1 rounded hover:bg-muted text-muted-foreground"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-border">
            <span className="text-sm text-muted-foreground">
              {files.length} file{files.length !== 1 ? "s" : ""} selected
            </span>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors">
                Cancel
              </button>
              {files.length > 0 && (
                <button
                  onClick={startUpload}
                  data-testid="button-start-upload"
                  className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  Upload {files.length} photo{files.length !== 1 ? "s" : ""}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ─── PHASE: uploading — bottom-right panel ───────────────────────── */
  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-2xl bg-card border border-border shadow-2xl overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <CloudUpload className="w-4 h-4 text-primary shrink-0" />
          <span className="text-sm font-semibold text-foreground truncate">
            {allDone
              ? `${doneCount} uploaded`
              : isUploading
                ? `Uploading ${doneCount + 1} / ${files.length}…`
                : `${doneCount} / ${files.length} uploaded`}
          </span>
          {isUploading && <Loader2 className="w-3.5 h-3.5 text-primary animate-spin shrink-0" />}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => setCollapsed(c => !c)} className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors">
            {collapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {allDone && (
            <button onClick={onClose} className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="p-3 space-y-3">
          {/* Progress bar */}
          <div className="h-1 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${allDone ? "bg-green-500" : "bg-primary"}`}
              style={{ width: `${files.length ? Math.round((doneCount / files.length) * 100) : 0}%` }}
            />
          </div>

          {/* Thumbnail grid — photos pop in as they complete */}
          <div className="grid grid-cols-5 gap-1">
            {files.map((f, i) => (
              <div key={i} className="relative aspect-square rounded overflow-hidden bg-muted">
                {f.file.type.startsWith("video/")
                  ? <VideoThumb file={f.file} />
                  : <img src={f.previewUrl} alt="" className="w-full h-full object-cover" />}
                {f.status === "uploading" && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                    <Loader2 className="w-4 h-4 text-white animate-spin" />
                  </div>
                )}
                {f.status === "pending" && (
                  <div className="absolute inset-0 bg-black/40" />
                )}
                {f.status === "done" && (
                  <div className="absolute bottom-0.5 right-0.5">
                    <CheckCircle className="w-3.5 h-3.5 text-green-400 drop-shadow" />
                  </div>
                )}
                {f.status === "error" && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                    <AlertCircle className="w-4 h-4 text-red-400" />
                  </div>
                )}
              </div>
            ))}
          </div>

          {allDone && (
            <button onClick={onClose}
              className="w-full py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-medium transition-colors">
              Done
            </button>
          )}
        </div>
      )}
    </div>
  );
}
