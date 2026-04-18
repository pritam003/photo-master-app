const _apiOrigin = import.meta.env.VITE_API_URL || "";
export const API_BASE = `${_apiOrigin}/api`;

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function groupPhotosByDate(photos: any[], dateField: "taken" | "uploaded" = "taken"): Record<string, any[]> {
  // Group by calendar day — key is "YYYY-MM-DD" for deterministic ordering
  const groups: Record<string, any[]> = {};
  for (const photo of photos) {
    const raw = dateField === "uploaded" ? photo.uploadedAt : (photo.takenAt ?? photo.uploadedAt);
    const date = new Date(raw);
    // Build YYYY-MM-DD in LOCAL time to avoid midnight cross-over artefacts
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const key = `${y}-${m}-${d}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(photo);
  }
  // Sort each day newest-first
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => {
      const da = new Date(dateField === "uploaded" ? a.uploadedAt : (a.takenAt ?? a.uploadedAt)).getTime();
      const db = new Date(dateField === "uploaded" ? b.uploadedAt : (b.takenAt ?? b.uploadedAt)).getTime();
      return db - da;
    });
  }
  return groups;
}
