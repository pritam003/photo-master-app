import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import { Heart, FolderPlus, Check, FolderMinus, Trash2, Download, X, EyeOff, Eye, Share2 } from "lucide-react";
import { groupPhotosByDate } from "@/lib/api";
import Lightbox from "./Lightbox";
import { useListAlbums, useAddPhotoToAlbum, useCreateAlbum, useTrashPhoto, getListAlbumsQueryKey, getListAlbumPhotosQueryKey, getListPhotosQueryKey, getGetPhotoStatsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";

interface PhotoGridProps {
  photos: any[];
  emptyMessage?: string;
  dateField?: "taken" | "uploaded";
  onRemoveFromAlbum?: (photoId: string) => void;
  onTrash?: (photoId: string) => void;
  onBulkTrash?: (ids: string[]) => Promise<void>;
  onHide?: (photoId: string) => void;
  onBulkHide?: (ids: string[]) => Promise<void>;
  onPhotoTrash?: (id: string) => void;
}

export default function PhotoGrid({ photos, emptyMessage = "No photos yet", dateField = "taken", onRemoveFromAlbum, onTrash, onBulkTrash, onHide, onBulkHide, onPhotoTrash }: PhotoGridProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkAlbumPicker, setShowBulkAlbumPicker] = useState(false);
  const [bulkAlbumAdded, setBulkAlbumAdded] = useState<string | null>(null);
  const [showNewAlbumInput, setShowNewAlbumInput] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const queryClient = useQueryClient();
  const trashPhoto = useTrashPhoto();
  const addPhotoToAlbum = useAddPhotoToAlbum();
  const createAlbum = useCreateAlbum();
  const { data: albumList } = useListAlbums({ query: { queryKey: getListAlbumsQueryKey(), enabled: showBulkAlbumPicker } });
  const selecting = selectedIds.size > 0;

  // ── Drag-to-select ────────────────────────────────────────────────────────
  const gridRef = useRef<HTMLDivElement>(null);
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const hasDragged = useRef(false);
  const dragRafRef = useRef<number | null>(null);

  const getDragRect = (ox: number, oy: number, cx: number, cy: number) => ({
    x: Math.min(ox, cx), y: Math.min(oy, cy),
    w: Math.abs(cx - ox), h: Math.abs(cy - oy),
  });

  const handleGridMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Only start drag on the background, not on a button/interactive element
    const target = e.target as HTMLElement;
    if (target.closest("button, a, [role='button']")) return;
    if (e.button !== 0) return;
    const grid = gridRef.current;
    if (!grid) return;
    const gr = grid.getBoundingClientRect();
    dragOrigin.current = { x: e.clientX - gr.left + grid.scrollLeft, y: e.clientY - gr.top + grid.scrollTop };
    hasDragged.current = false;
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragOrigin.current || !gridRef.current) return;
      // Throttle to one RAF per frame — avoids layout thrashing on Windows
      if (dragRafRef.current !== null) return;
      const clientX = e.clientX;
      const clientY = e.clientY;
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = null;
        if (!dragOrigin.current || !gridRef.current) return;
        const grid = gridRef.current;
        const gr = grid.getBoundingClientRect();
        const cx = clientX - gr.left + grid.scrollLeft;
        const cy = clientY - gr.top + grid.scrollTop;
        const rect = getDragRect(dragOrigin.current.x, dragOrigin.current.y, cx, cy);
        if (rect.w > 6 || rect.h > 6) {
          hasDragged.current = true;
          setDragRect(rect);
          // Hit-test all photo elements
          const photoEls = grid.querySelectorAll<HTMLElement>("[data-photo-id]");
          const newSelected = new Set<string>();
          photoEls.forEach(el => {
            const er = el.getBoundingClientRect();
            const elLeft = er.left - gr.left + grid.scrollLeft;
            const elTop = er.top - gr.top + grid.scrollTop;
            const elRight = elLeft + er.width;
            const elBottom = elTop + er.height;
            const rRight = rect.x + rect.w;
            const rBottom = rect.y + rect.h;
            if (elLeft < rRight && elRight > rect.x && elTop < rBottom && elBottom > rect.y) {
              newSelected.add(el.dataset.photoId!);
            }
          });
          if (newSelected.size > 0) setSelectedIds(newSelected);
        }
      });
    };
    const onMouseUp = () => {
      dragOrigin.current = null;
      setDragRect(null);
      if (dragRafRef.current !== null) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = null; }
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // O(1) index lookup — avoids scanning allPhotos on every thumbnail render
  const photoIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    photos.forEach((p, i) => m.set(p.id, i));
    return m;
  }, [photos]);

  const grouped = useMemo(() => groupPhotosByDate(photos, dateField), [photos, dateField]);

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleOpenLightbox = useCallback((idx: number) => setLightboxIndex(idx), []);

  const handleBulkDownload = useCallback(async () => {
    const selectedPhotos = photos.filter(p => selectedIds.has(p.id));
    for (const photo of selectedPhotos) {
      const a = document.createElement("a");
      a.href = photo.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.download = photo.filename || "photo.jpg";
      a.click();
      await new Promise(r => setTimeout(r, 150));
    }
  }, [photos, selectedIds]);

  const handleBulkShare = useCallback(async () => {
    const selectedPhotos = photos.filter(p => selectedIds.has(p.id));
    if (navigator.share && selectedPhotos.length > 0) {
      try {
        const files: File[] = [];
        for (const photo of selectedPhotos) {
          try {
            const res = await fetch(photo.url);
            const blob = await res.blob();
            files.push(new File([blob], photo.filename || "photo.jpg", { type: blob.type }));
          } catch { /* skip failed */ }
        }
        if (files.length > 0 && navigator.canShare?.({ files })) {
          await navigator.share({ files, title: `${files.length} photo${files.length !== 1 ? "s" : ""}` });
        } else {
          await navigator.share({ url: selectedPhotos[0].url, title: "Photo" });
        }
      } catch { /* user cancelled */ }
    }
  }, [photos, selectedIds]);

  const handleBulkTrash = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (onBulkTrash) {
      await onBulkTrash(ids);
    } else {
      await Promise.all(ids.map(id => trashPhoto.mutateAsync({ id, data: { trashed: true } })));
      queryClient.invalidateQueries({ queryKey: getListPhotosQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetPhotoStatsQueryKey() });
    }
    setSelectedIds(new Set());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onBulkTrash, selectedIds]);

  // Keyboard shortcut: Delete / Backspace trashes selected photos
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selectedIds.size === 0) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      handleBulkTrash();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, handleBulkTrash]);

  const handleBulkHide = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (onBulkHide) {
      await onBulkHide(ids);
    } else {
      await Promise.all(ids.map(id =>
        fetch(`${API_BASE}/photos/${id}/hide`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ hidden: true }),
        })
      ));
      queryClient.invalidateQueries({ queryKey: getListPhotosQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetPhotoStatsQueryKey() });
    }
    setSelectedIds(new Set());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onBulkHide, selectedIds]);

  const handleBulkAddToAlbum = useCallback(async (albumId: string) => {
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map(photoId => addPhotoToAlbum.mutateAsync({ id: albumId, data: { photoId } })));
    queryClient.invalidateQueries({ queryKey: getListAlbumPhotosQueryKey(albumId) });
    queryClient.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
    setBulkAlbumAdded(albumId);
    setTimeout(() => { setBulkAlbumAdded(null); setShowBulkAlbumPicker(false); setSelectedIds(new Set()); }, 800);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  const handleCreateAndAddToAlbum = useCallback(async () => {
    const trimmed = newAlbumName.trim();
    if (!trimmed) return;
    setCreatingAlbum(true);
    try {
      const album = await createAlbum.mutateAsync({ data: { name: trimmed } });
      await handleBulkAddToAlbum(album.id);
      queryClient.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
      setNewAlbumName("");
      setShowNewAlbumInput(false);
    } finally {
      setCreatingAlbum(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newAlbumName, handleBulkAddToAlbum]);

  if (photos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
        <p className="text-base">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <>
      <div ref={gridRef} className="relative select-none" onMouseDown={handleGridMouseDown}>
        {/* Drag-select lasso overlay */}
        {dragRect && (
          <div
            className="pointer-events-none fixed z-50 border-2 border-primary bg-primary/10 rounded"
            style={{
              left: gridRef.current ? gridRef.current.getBoundingClientRect().left + dragRect.x - (gridRef.current.scrollLeft || 0) : dragRect.x,
              top: gridRef.current ? gridRef.current.getBoundingClientRect().top + dragRect.y - (gridRef.current.scrollTop || 0) : dragRect.y,
              width: dragRect.w,
              height: dragRect.h,
            }}
          />
        )}
      {Object.entries(grouped).map(([month, monthPhotos]) => (
        <MonthGroup
          key={month}
          month={month}
          monthPhotos={monthPhotos}
          photoIndexMap={photoIndexMap}
          onOpenLightbox={handleOpenLightbox}
          onRemoveFromAlbum={onRemoveFromAlbum}
          onTrash={onTrash}
          onHide={onHide}
          selectedIds={selectedIds}
          selecting={selecting}
          onToggleSelect={handleToggleSelect}
        />
      ))}
      </div>

      {lightboxIndex !== null && (
        <Lightbox
          photos={photos}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onPhotoTrash={onPhotoTrash}
        />
      )}

      {/* Multi-select floating action bar */}
      {selecting && (
        <div className="fixed bottom-[calc(56px+env(safe-area-inset-bottom)+8px)] sm:bottom-6 left-1/2 -translate-x-1/2 z-50
          flex items-center gap-1 sm:gap-2 px-3 sm:px-4 py-2 sm:py-2.5
          bg-card border border-border rounded-2xl shadow-2xl
          max-w-[calc(100vw-2rem)]">

          {/* Count + select-all */}
          <span className="text-sm font-medium text-foreground whitespace-nowrap">{selectedIds.size}</span>
          <button
            onClick={() => setSelectedIds(new Set(photos.map(p => p.id)))}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded hover:bg-muted whitespace-nowrap"
          >
            All
          </button>

          <div className="w-px h-4 bg-border mx-0.5" />

          {/* Share — mobile Web Share API */}
          <button
            onClick={handleBulkShare}
            title="Share"
            className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <Share2 className="w-4 h-4" />
          </button>

          {/* Download */}
          <button
            onClick={handleBulkDownload}
            title="Download"
            className="flex items-center gap-1.5 p-2 sm:px-3 sm:py-1.5 text-sm rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">Download</span>
          </button>

          {/* Add to album */}
          <div className="relative">
            <button
              onClick={() => setShowBulkAlbumPicker(v => !v)}
              title="Add to album"
              className="flex items-center gap-1.5 p-2 sm:px-3 sm:py-1.5 text-sm rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <FolderPlus className="w-4 h-4" />
              <span className="hidden sm:inline">Add to album</span>
            </button>
            {showBulkAlbumPicker && (
              <div className="absolute bottom-full mb-2 left-0 z-20 bg-card border border-border rounded-xl shadow-2xl min-w-52 max-h-72 overflow-y-auto">
                <p className="text-xs text-muted-foreground px-3 py-2 border-b border-border">Add {selectedIds.size} photo{selectedIds.size !== 1 ? "s" : ""} to…</p>
                {albumList && albumList.map((album: any) => (
                  <button
                    key={album.id}
                    onClick={() => handleBulkAddToAlbum(album.id)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center justify-between gap-2 transition-colors"
                  >
                    <span className="truncate">{album.name}</span>
                    {bulkAlbumAdded === album.id && <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />}
                  </button>
                ))}
                <div className="border-t border-border">
                  {showNewAlbumInput ? (
                    <div className="flex items-center gap-1.5 px-2 py-2">
                      <input
                        autoFocus
                        value={newAlbumName}
                        onChange={e => setNewAlbumName(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") handleCreateAndAddToAlbum(); if (e.key === "Escape") { setShowNewAlbumInput(false); setNewAlbumName(""); } }}
                        placeholder="Album name…"
                        className="flex-1 min-w-0 text-sm px-2 py-1 bg-muted rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground"
                      />
                      <button
                        onClick={handleCreateAndAddToAlbum}
                        disabled={!newAlbumName.trim() || creatingAlbum}
                        className="shrink-0 px-2 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                      >
                        {creatingAlbum ? "…" : "Create"}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowNewAlbumInput(true)}
                      className="w-full text-left px-3 py-2 text-sm text-primary hover:bg-muted flex items-center gap-2 transition-colors"
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      New album
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Hide */}
          <button
            onClick={handleBulkHide}
            title="Hide"
            className="flex items-center gap-1.5 p-2 sm:px-3 sm:py-1.5 text-sm rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <EyeOff className="w-4 h-4" />
            <span className="hidden sm:inline">Hide</span>
          </button>

          {/* Delete */}
          <button
            onClick={handleBulkTrash}
            title="Delete"
            className="flex items-center gap-1.5 p-2 sm:px-3 sm:py-1.5 text-sm rounded-lg text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            <span className="hidden sm:inline">Delete</span>
          </button>

          {/* Dismiss */}
          <button
            onClick={() => setSelectedIds(new Set())}
            title="Clear selection"
            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </>
  );
}

const STACK_THRESHOLD = 50;

function StackCell({ hiddenCount, previews, onExpand }: { hiddenCount: number; previews: any[]; onExpand: () => void }) {
  return (
    <button
      onClick={onExpand}
      className="relative aspect-square overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-primary transition-[transform,box-shadow] duration-200 hover:scale-[1.03] hover:shadow-lg hover:z-10"
      title={`Show ${hiddenCount} more photos`}
    >
      {/* Stacked card layers behind (bottom to top) */}
      {previews.slice(0, 3).reverse().map((photo, i) => (
        <div
          key={photo.id}
          className="absolute inset-0 rounded-sm overflow-hidden border border-background"
          style={{
            transform: `translate(${(2 - i) * 4}px, ${(2 - i) * -4}px) rotate(${(2 - i) * 2}deg)`,
            zIndex: i,
          }}
        >
          <img
            src={photo.thumbnailUrl || photo.url}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-black/20" />
        </div>
      ))}
      {/* Top card with count badge */}
      <div className="absolute inset-0 rounded-sm overflow-hidden border border-background bg-muted" style={{ zIndex: 3 }}>
        <img
          src={previews[0]?.thumbnailUrl || previews[0]?.url}
          alt=""
          className="w-full h-full object-cover opacity-60"
          loading="lazy"
        />
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40">
          <span className="text-white font-bold text-xl leading-tight">+{hiddenCount}</span>
          <span className="text-white/80 text-xs mt-0.5">more</span>
        </div>
      </div>
    </button>
  );
}

const MonthGroup = memo(function MonthGroup({ month, monthPhotos, photoIndexMap, onOpenLightbox, onRemoveFromAlbum, onTrash, onHide, selectedIds, selecting, onToggleSelect }: {
  month: string;
  monthPhotos: any[];
  photoIndexMap: Map<string, number>;
  onOpenLightbox: (idx: number) => void;
  onRemoveFromAlbum?: (photoId: string) => void;
  onTrash?: (photoId: string) => void;
  onHide?: (photoId: string) => void;
  selectedIds: Set<string>;
  selecting: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(STACK_THRESHOLD);
  const hasMore = monthPhotos.length > visibleCount;
  const visiblePhotos = monthPhotos.slice(0, visibleCount);

  return (
    <div className="mb-10" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 600px" }}>
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-2.5">
          <span className="w-1 h-5 rounded-full bg-primary inline-block" />
          <h2 className="text-base font-bold text-foreground tracking-tight">{month}</h2>
          <span className="text-xs text-muted-foreground font-normal">({monthPhotos.length})</span>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 gap-2">
        {visiblePhotos.map((photo: any) => {
          const globalIdx = photoIndexMap.get(photo.id) ?? -1;
          return (
            <PhotoThumbnail
              key={photo.id}
              photo={photo}
              globalIndex={globalIdx}
              onOpenLightbox={onOpenLightbox}
              onRemoveFromAlbum={onRemoveFromAlbum}
              onTrash={onTrash}
              onHide={onHide}
              selected={selectedIds.has(photo.id)}
              selecting={selecting}
              onToggleSelect={onToggleSelect}
            />
          );
        })}
      </div>
      {hasMore && (
        <div className="flex justify-center mt-4">
          <button
            onClick={() => setVisibleCount(c => c + STACK_THRESHOLD)}
            className="px-5 py-2 text-sm font-medium rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            Load more ({monthPhotos.length - visibleCount} remaining)
          </button>
        </div>
      )}
    </div>
  );
});

function VideoThumbnailCell({ videoSrc, isHovered }: { thumbSrc: string; videoSrc: string; alt: string; isHovered: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const thumbTime = useRef(0);

  // Lazy-mount the video element only when near the viewport
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setInView(true); obs.disconnect(); }
    }, { rootMargin: "300px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // After metadata loads seek to a representative frame so the poster is visible
  useEffect(() => {
    if (!inView) return;
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      const t = v.duration > 0 ? Math.min(1, v.duration * 0.05) : 0;
      thumbTime.current = t;
      v.currentTime = t;
    };
    const onSeeked = () => setFrameReady(true);
    const onCanPlay = () => setFrameReady(true);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("canplay", onCanPlay);
    // Fallback: show whatever is there after 2 s
    const fallback = setTimeout(() => setFrameReady(true), 2000);
    if (v.readyState >= 2) { onMeta(); }
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("canplay", onCanPlay);
      clearTimeout(fallback);
    };
  }, [inView]);

  // Play on hover (desktop), pause and return to thumb frame on leave
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (isHovered) {
      v.play().catch(() => {});
    } else {
      v.pause();
      if (v.readyState >= 1) v.currentTime = thumbTime.current;
    }
  }, [isHovered]);

  return (
    <div ref={containerRef} className="w-full h-full relative pointer-events-none">
      {inView && (
        <video
          ref={videoRef}
          src={videoSrc}
          className="w-full h-full object-cover"
          muted
          loop
          playsInline
          preload="metadata"
        />
      )}
      {/* Pulse placeholder until first frame is painted */}
      {(!frameReady || !inView) && (
        <div className="absolute inset-0 bg-muted animate-pulse" />
      )}
      {/* Play badge — fades out while hovering */}
      <div className={`absolute inset-0 flex items-center justify-center pointer-events-none transition-opacity duration-200 ${isHovered ? "opacity-0" : "opacity-100"}`}>
        <div className="w-9 h-9 rounded-full bg-black/55 shadow-md flex items-center justify-center">
          <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>
    </div>
  );
}

const PhotoThumbnail = memo(function PhotoThumbnail({ photo, globalIndex, onOpenLightbox, onRemoveFromAlbum, onTrash, onHide, selected, selecting, onToggleSelect }: {
  photo: any;
  globalIndex: number;
  onOpenLightbox: (idx: number) => void;
  onRemoveFromAlbum?: (photoId: string) => void;
  onTrash?: (photoId: string) => void;
  onHide?: (photoId: string) => void;
  selected: boolean;
  selecting: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [videoHovered, setVideoHovered] = useState(false);
  const isVideo = photo.contentType?.startsWith("video/") || /\.(mp4|mov|webm|avi|mkv)$/i.test(photo.filename || "");
  const thumbUrl = photo.thumbnailUrl || photo.url;
  const [showAlbumPicker, setShowAlbumPicker] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: albums } = useListAlbums({ query: { queryKey: getListAlbumsQueryKey(), enabled: showAlbumPicker } });
  const addPhoto = useAddPhotoToAlbum();

  // Long-press to select on mobile
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);
  const touchMoved = useRef(false);

  const handleTouchStart = () => {
    touchMoved.current = false;
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      onToggleSelect(photo.id);
      if (navigator.vibrate) navigator.vibrate(40);
    }, 500);
  };
  const handleTouchMove = () => {
    touchMoved.current = true;
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };
  const handleTouchEnd = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };

  const handleAddToAlbum = async (e: React.MouseEvent, albumId: string) => {
    e.stopPropagation();
    await addPhoto.mutateAsync({ id: albumId, data: { photoId: photo.id } });
    queryClient.invalidateQueries({ queryKey: getListAlbumPhotosQueryKey(albumId) });
    queryClient.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
    setAdded(albumId);
    setTimeout(() => { setAdded(null); setShowAlbumPicker(false); }, 800);
  };

  return (
    <button
      onClick={(e) => {
        if (longPressTriggered.current) { longPressTriggered.current = false; return; }
        selecting ? onToggleSelect(photo.id) : onOpenLightbox(globalIndex);
      }}
      data-testid={`photo-${photo.id}`}
      data-photo-id={photo.id}
      className="photo-thumb relative aspect-square bg-muted overflow-hidden rounded-lg group focus:outline-none focus:ring-2 focus:ring-primary transition-[transform,box-shadow] duration-200 hover:scale-[1.03] hover:shadow-lg hover:z-10"
      style={{ contain: "layout style paint" }}
      onMouseEnter={() => isVideo && setVideoHovered(true)}
      onMouseLeave={() => isVideo && setVideoHovered(false)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {!error ? (
        isVideo ? (
          <VideoThumbnailCell
            thumbSrc={photo.thumbnailUrl || photo.url}
            videoSrc={photo.url}
            alt={photo.filename}
            isHovered={videoHovered}
          />
        ) : (
        <img
          src={photo.thumbnailUrl || photo.url}
          alt={photo.filename}
          loading="lazy"
          decoding="async"
          className={`w-full h-full object-cover ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
        )
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-muted">
          <span className="text-muted-foreground text-xs text-center px-1 break-all">{photo.filename}</span>
        </div>
      )}
      {!loaded && !error && !isVideo && (
        <div className="absolute inset-0 bg-muted animate-pulse" />
      )}

      {/* Selection checkbox — top left */}
      <div
        className={`absolute top-1.5 left-1.5 z-10 transition-opacity ${selected || selecting ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        onClick={e => { e.stopPropagation(); onToggleSelect(photo.id); }}
      >
        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${selected ? "bg-primary border-primary" : "border-white bg-black/40"}`}>
          {selected && <Check className="w-3 h-3 text-white" />}
        </div>
      </div>

      {photo.favorite && (
        <div className="absolute top-1.5 right-1.5">
          <Heart className="w-3.5 h-3.5 text-white fill-red-400 drop-shadow-sm" />
        </div>
      )}

      {/* Per-photo action buttons — hidden in select mode */}
      {!selecting && (
        <div
          className="absolute bottom-1.5 left-1.5 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1"
          onClick={e => e.stopPropagation()}
        >
          <div
            onClick={e => { e.stopPropagation(); setShowAlbumPicker(v => !v); }}
            className="bg-black/60 hover:bg-black/80 rounded-md p-1 cursor-pointer"
            title="Add to album"
          >
            <FolderPlus className="w-3.5 h-3.5 text-white" />
          </div>
          {onRemoveFromAlbum && (
            <div
              onClick={e => { e.stopPropagation(); onRemoveFromAlbum(photo.id); }}
              className="bg-black/60 hover:bg-black/80 rounded-md p-1 cursor-pointer"
              title="Remove from album"
            >
              <FolderMinus className="w-3.5 h-3.5 text-white" />
            </div>
          )}
          {onHide && (
            <div
              onClick={e => { e.stopPropagation(); onHide(photo.id); }}
              className="bg-black/60 hover:bg-black/80 rounded-md p-1 cursor-pointer"
              title={photo.hidden ? "Unhide photo" : "Hide photo"}
            >
              {photo.hidden
                ? <Eye className="w-3.5 h-3.5 text-white" />
                : <EyeOff className="w-3.5 h-3.5 text-white" />
              }
            </div>
          )}
          {onTrash && (
            <div
              onClick={e => { e.stopPropagation(); onTrash(photo.id); }}
              className="bg-black/60 hover:bg-red-600/80 rounded-md p-1 cursor-pointer"
              title="Move to trash"
            >
              <Trash2 className="w-3.5 h-3.5 text-white" />
            </div>
          )}
        </div>
      )}

      <div className={`absolute inset-0 transition-colors ${selected ? "bg-primary/20" : "bg-black/0 group-hover:bg-black/10"}`} />

      {/* Album picker dropdown */}
      {showAlbumPicker && !selecting && (
        <div
          className="absolute bottom-8 left-1 z-20 bg-card border border-border rounded-lg shadow-lg min-w-36 max-h-48 overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          {!albums || albums.length === 0 ? (
            <p className="text-xs text-muted-foreground px-3 py-2">No albums yet</p>
          ) : (
            albums.map((album: any) => (
              <button
                key={album.id}
                onClick={e => handleAddToAlbum(e, album.id)}
                className="w-full text-left px-3 py-2 text-xs hover:bg-muted flex items-center justify-between gap-2"
              >
                <span className="truncate">{album.name}</span>
                {added === album.id && <Check className="w-3 h-3 text-green-500 shrink-0" />}
              </button>
            ))
          )}
        </div>
      )}
    </button>
  );
});
