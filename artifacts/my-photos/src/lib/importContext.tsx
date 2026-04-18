import { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { API_BASE } from "./api";

interface ImportStatus {
  status: "picking" | "importing" | "done" | "error";
  albumName: string;
  albumId?: string;
  total: number;
  imported: number;
  skipped: number;
  errors: number;
  message?: string;
  resumable?: boolean;
}

interface ImportCtx {
  importId: string | null;
  importStatus: ImportStatus | null;
  activeImportAlbumId: string | null;
  startImport: (id: string) => void;
  clearImport: () => void;
  cancelImport: () => Promise<void>;
  resumeImport: () => Promise<void>;
}

const ImportContext = createContext<ImportCtx>({
  importId: null,
  importStatus: null,
  activeImportAlbumId: null,
  startImport: () => {},
  clearImport: () => {},
  cancelImport: async () => {},
  resumeImport: async () => {},
});

export function useImport() { return useContext(ImportContext); }

const SESSION_KEY = "aphoto_active_import_id";

// Use localStorage so tracking survives both refresh and tab close
function saveImportId(id: string)  { try { localStorage.setItem(SESSION_KEY, id); } catch {} }
function loadImportId(): string | null { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } }
function removeImportId()           { try { localStorage.removeItem(SESSION_KEY); } catch {} }

export function ImportProvider({ children }: { children: React.ReactNode }) {
  const [importId, setImportIdState] = useState<string | null>(
    () => loadImportId()
  );
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startImport = useCallback((id: string) => {
    saveImportId(id);
    setImportIdState(id);
  }, []);

  const clearImport = useCallback(() => {
    removeImportId();
    setImportIdState(null);
    setImportStatus(null);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const cancelImport = useCallback(async () => {
    if (!importId) return;
    try {
      await fetch(`${API_BASE}/google/import/${importId}`, { method: "DELETE", credentials: "include" });
    } catch { /* ignore */ }
    clearImport();
  }, [importId, clearImport]);

  const resumeImport = useCallback(async () => {
    if (!importId) return;
    try {
      await fetch(`${API_BASE}/google/import/${importId}/resume`, { method: "POST", credentials: "include" });
      // Re-start polling — status will move back to "importing"
      setImportStatus(prev => prev ? { ...prev, status: "importing", resumable: false, message: undefined } : prev);
      // Re-trigger the polling effect by briefly clearing then restoring importId
      const id = importId;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      const poll = async () => {
        try {
          const res = await fetch(`${API_BASE}/google/import/${id}`, { credentials: "include" });
          if (res.status === 404) { clearImport(); return; }
          if (!res.ok) return;
          const data = await res.json() as ImportStatus;
          setImportStatus(data);
          if (data.status === "done" || data.status === "error") {
            clearInterval(pollRef.current!); pollRef.current = null;
          }
        } catch { /* keep polling */ }
      };
      poll();
      pollRef.current = setInterval(poll, 2000);
    } catch { /* ignore */ }
  }, [importId, clearImport]);

  // Poll when we have an importId
  useEffect(() => {
    if (!importId) return;
    if (pollRef.current) clearInterval(pollRef.current);

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/google/import/${importId}`, { credentials: "include" });
        if (res.status === 404) {
          // Server restarted — import state lost, clear tracking
          clearImport();
          return;
        }
        if (!res.ok) return;
        const data = await res.json() as ImportStatus;
        setImportStatus(data);
        if (data.status === "done" || data.status === "error") {
          clearInterval(pollRef.current!);
          pollRef.current = null;
        }
      } catch { /* keep polling */ }
    };

    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [importId, clearImport]);

  // No beforeunload warning needed — import runs server-side and survives refresh/tab reopen

  return (
    <ImportContext.Provider value={{
      importId,
      importStatus,
      activeImportAlbumId: importStatus?.albumId ?? null,
      startImport,
      clearImport,
      cancelImport,
      resumeImport,
    }}>
      {children}
    </ImportContext.Provider>
  );
}
