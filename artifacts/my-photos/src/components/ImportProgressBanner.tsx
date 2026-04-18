import { X, Loader2, CheckCircle, AlertCircle, RotateCcw, RefreshCw } from "lucide-react";
import { useImport } from "@/lib/importContext";

interface ImportProgressBannerProps {
  onImportMore?: () => void;
}

export default function ImportProgressBanner({ onImportMore }: ImportProgressBannerProps) {
  const { importId, importStatus, clearImport, cancelImport, resumeImport } = useImport();
  if (!importId || !importStatus) return null;

  const { status, albumName, imported, total, skipped, errors, resumable } = importStatus;
  const pct = total > 0 ? Math.round(((imported + errors) / total) * 100) : 0;
  const remaining = total > 0 ? total - imported - errors : 0;
  const isDone = status === "done";
  const isError = status === "error";
  const isActive = status === "importing" || status === "picking";

  return (
    <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[min(96vw,460px)] rounded-2xl border shadow-2xl overflow-hidden transition-all
      ${isDone ? "border-green-500/30 bg-green-50 dark:bg-green-950/40" : isError ? "border-destructive/30 bg-destructive/5" : "border-border bg-card"}`}>
      {/* Progress bar */}
      {isActive && total > 0 && (
        <div className="h-1 bg-muted">
          <div className="h-1 bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
      {isDone && <div className="h-1 bg-green-500" />}
      {isError && resumable && total > 0 && (
        <div className="h-1 bg-muted">
          <div className="h-1 bg-destructive/40" style={{ width: `${pct}%` }} />
        </div>
      )}

      <div className="flex items-center gap-3 px-4 py-3">
        {isActive && <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />}
        {isDone && <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />}
        {isError && <AlertCircle className="w-4 h-4 text-destructive shrink-0" />}

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {isDone
              ? imported > 0
                ? `${imported} photo${imported !== 1 ? "s" : ""} imported${skipped ? ` · ${skipped} already existed` : ""}`
                : skipped
                ? `All ${skipped} photos already in your library`
                : "Import complete"
              : isError
              ? resumable
                ? `Import stopped — ${imported} of ${total} done, ${remaining} remaining`
                : "Import failed"
              : status === "picking"
              ? "Waiting for Google Photos picker…"
              : `Importing from Google Photos`}
          </p>
          {(isActive || (isError && resumable)) && (
            <p className="text-xs text-muted-foreground">
              {albumName && <span className="font-medium">{albumName}</span>}
              {albumName && total > 0 && " · "}
              {total > 0
                ? isError
                  ? `${remaining} photo${remaining !== 1 ? "s" : ""} left to import`
                  : `${imported} / ${total} imported`
                : "Starting…"}
            </p>
          )}
          {isError && !resumable && importStatus.message && (
            <p className="text-xs text-muted-foreground truncate">{importStatus.message}</p>
          )}
        </div>

        {isError && resumable && (
          <button
            onClick={() => resumeImport()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors shrink-0"
            title="Resume import from where it stopped"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Resume
          </button>
        )}
        {isActive && (
          <button
            onClick={() => cancelImport()}
            className="p-1 rounded-lg hover:bg-muted text-muted-foreground hover:text-destructive transition-colors shrink-0"
            title="Stop import"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {(isDone || (isError && !resumable)) && (
          <div className="flex items-center gap-1 shrink-0">
            {isDone && onImportMore && (
              <button
                onClick={() => { clearImport(); onImportMore(); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
                title="Import more photos from Google"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Import more
              </button>
            )}
            <button onClick={clearImport} className="p-1 rounded-lg hover:bg-muted text-muted-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
