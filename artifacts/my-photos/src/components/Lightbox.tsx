import { useState, useEffect, useRef } from "react";
import { X, Heart, Trash2, Share2, ChevronLeft, ChevronRight, Info, Download, Keyboard } from "lucide-react";
import { useToggleFavorite, useTrashPhoto, useCreateShare, useListAlbums, useAddPhotoToAlbum, getListPhotosQueryKey, getGetPhotoStatsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatBytes, formatDate } from "@/lib/api";

interface LightboxProps {
  photos: any[];
  initialIndex: number;
  onClose: () => void;
  onPhotoChange?: (photo: any) => void;
  onPhotoTrash?: (id: string) => void;
}

export default function Lightbox({ photos, initialIndex, onClose, onPhotoTrash }: LightboxProps) {
  const [index, setIndex] = useState(initialIndex);
  const [showInfo, setShowInfo] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [showAlbumPicker, setShowAlbumPicker] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const queryClient = useQueryClient();

  const photo = photos[index];
  const toggleFavorite = useToggleFavorite();
  const trashPhoto = useTrashPhoto();
  const createShare = useCreateShare();
  const { data: albums } = useListAlbums();
  const addToAlbum = useAddPhotoToAlbum();

  // Auto-focus container so keyboard events work immediately
  useEffect(() => { containerRef.current?.focus(); }, []);

  const prev = () => setIndex(i => Math.max(0, i - 1));
  const next = () => setIndex(i => Math.min(photos.length - 1, i + 1));

  const handleFavorite = () => {
    toggleFavorite.mutate({ id: photo.id, data: { favorite: !photo.favorite } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPhotosQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPhotoStatsQueryKey() });
      },
    });
  };

  const handleTrash = () => {
    trashPhoto.mutate({ id: photo.id, data: { trashed: !photo.trashed } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPhotosQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPhotoStatsQueryKey() });
        onPhotoTrash?.(photo.id);
        if (photos.length <= 1) onClose();
        else setIndex(i => Math.min(i, photos.length - 2));
      },
    });
  };

  const handleShare = () => {
    createShare.mutate({ data: { photoId: photo.id, expiresInHours: 48 } }, {
      onSuccess: (res: any) => setShareUrl(res.url),
    });
  };

  const handleAddToAlbum = (albumId: string) => {
    addToAlbum.mutate({ id: albumId, data: { photoId: photo.id } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPhotosQueryKey() });
        setShowAlbumPicker(false);
      },
    });
  };

  const handleDownload = async () => {
    try {
      const res = await fetch(photo.url, { credentials: "include" });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = photo.filename || "photo"; a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
    if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    if (e.key === "Escape") onClose();
    if (e.key === "f" || e.key === "F") handleFavorite();
    if (e.key === "Delete" || e.key === "Backspace") handleTrash();
    if (e.key === "d" || e.key === "D") handleDownload();
    if (e.key === "i" || e.key === "I") setShowInfo(v => !v);
    if (e.key === "?") setShowShortcuts(v => !v);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    touchStartX.current = null;
    touchStartY.current = null;
    // Only horizontal swipes of at least 50px, more horizontal than vertical
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) next(); else prev();
  };

  if (!photo) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 bg-black/95 flex flex-col"
      onKeyDown={handleKeyDown}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      tabIndex={0}
      style={{ outline: "none" }}
    >
      <div className="flex items-center justify-between px-4 py-3 shrink-0">
        <button onClick={onClose} className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors">
          <X className="w-5 h-5" />
        </button>
        <div className="text-white/60 text-sm">{index + 1} / {photos.length}</div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleFavorite}
            data-testid="button-toggle-favorite"
            className={`p-2 rounded-lg transition-colors ${photo.favorite ? "text-red-400 hover:bg-red-400/10" : "text-white/70 hover:text-white hover:bg-white/10"}`}
          >
            <Heart className={`w-5 h-5 ${photo.favorite ? "fill-current" : ""}`} />
          </button>
          <button onClick={handleShare} className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors" title="Share (S)">
            <Share2 className="w-5 h-5" />
          </button>
          <button onClick={handleDownload} className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors" title="Download (D)">
            <Download className="w-5 h-5" />
          </button>
          <button
            onClick={handleTrash}
            data-testid="button-trash-photo"
            className="p-2 rounded-lg text-white/70 hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="w-5 h-5" />
          </button>
          <button onClick={() => setShowInfo(v => !v)} className={`p-2 rounded-lg transition-colors ${showInfo ? "text-white bg-white/10" : "text-white/70 hover:text-white hover:bg-white/10"}`} title="Info (I)">
            <Info className="w-5 h-5" />
          </button>
          <button onClick={() => setShowAlbumPicker(v => !v)} className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors text-xs font-medium px-3">
            + Album
          </button>
          <button onClick={() => setShowShortcuts(v => !v)} className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors" title="Keyboard shortcuts (?)">
            <Keyboard className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center relative overflow-hidden">
        {index > 0 && (
          <button onClick={prev} className="absolute left-4 z-10 p-2 rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors">
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}

        {(photo.contentType?.startsWith("video/") || /\.(mp4|mov|webm|avi|mkv)$/i.test(photo.filename || "")) ? (
          <video
            key={photo.id}
            src={photo.url}
            controls
            autoPlay
            playsInline
            className="max-h-full max-w-full"
            data-testid="lightbox-video"
          />
        ) : (
          <img
            src={photo.previewUrl || photo.url}
            alt={photo.filename}
            className="max-h-full max-w-full object-contain"
            data-testid="lightbox-image"
          />
        )}

        {index < photos.length - 1 && (
          <button onClick={next} className="absolute right-4 z-10 p-2 rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors">
            <ChevronRight className="w-6 h-6" />
          </button>
        )}
      </div>

      {shareUrl && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-60 bg-card border border-border rounded-xl shadow-2xl p-4 w-80">
          <p className="text-sm font-medium text-foreground mb-2">Share link created</p>
          <div className="flex gap-2">
            <input value={shareUrl} readOnly className="flex-1 text-xs bg-muted rounded px-2 py-1.5 text-foreground border border-border" />
            <button
              onClick={() => { navigator.clipboard.writeText(shareUrl); setShareUrl(null); }}
              className="px-3 py-1.5 bg-primary text-primary-foreground text-xs rounded font-medium"
            >
              Copy
            </button>
          </div>
          <button onClick={() => setShareUrl(null)} className="mt-2 text-xs text-muted-foreground">Dismiss</button>
        </div>
      )}

      {showAlbumPicker && albums && (
        <div className="fixed top-16 right-4 z-60 bg-card border border-border rounded-xl shadow-2xl p-3 w-56">
          <p className="text-xs font-medium text-muted-foreground mb-2 px-1">Add to album</p>
          {albums.length === 0 && <p className="text-xs text-muted-foreground px-1">No albums yet</p>}
          {albums.map((album: any) => (
            <button
              key={album.id}
              onClick={() => handleAddToAlbum(album.id)}
              className="w-full text-left px-2 py-2 text-sm rounded-lg hover:bg-muted transition-colors"
            >
              {album.name}
            </button>
          ))}
        </div>
      )}

      {showShortcuts && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60" onClick={() => setShowShortcuts(false)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl p-6 w-72" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-foreground mb-4">Keyboard Shortcuts</h3>
            <div className="space-y-2 text-sm">
              {[["←  /  →", "Previous / Next"], ["F", "Favorite"], ["D", "Download"], ["I", "Info panel"], ["Delete", "Move to trash"], ["Esc", "Close"]].map(([key, label]) => (
                <div key={key} className="flex items-center justify-between">
                  <kbd className="px-2 py-0.5 rounded bg-muted text-foreground font-mono text-xs">{key}</kbd>
                  <span className="text-muted-foreground text-xs">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showInfo && (
        <div className="absolute right-0 top-14 bottom-0 w-72 bg-black/80 backdrop-blur p-5 overflow-y-auto">
          <h3 className="text-white font-medium mb-4">Info</h3>
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-white/50 text-xs mb-0.5">Filename</p>
              <p className="text-white break-all">{photo.filename}</p>
            </div>
            {photo.uploadedAt && (
              <div>
                <p className="text-white/50 text-xs mb-0.5">Uploaded</p>
                <p className="text-white">{formatDate(photo.uploadedAt)}</p>
              </div>
            )}
            {photo.size && (
              <div>
                <p className="text-white/50 text-xs mb-0.5">Size</p>
                <p className="text-white">{formatBytes(photo.size)}</p>
              </div>
            )}
            {photo.description && (
              <div>
                <p className="text-white/50 text-xs mb-0.5">Description</p>
                <p className="text-white">{photo.description}</p>
              </div>
            )}
            {photo.locationName && (
              <div>
                <p className="text-white/50 text-xs mb-0.5">Location</p>
                <p className="text-white">{photo.locationName}</p>
              </div>
            )}
            {photo.tags && (
              <div>
                <p className="text-white/50 text-xs mb-1">AI Tags</p>
                <div className="flex flex-wrap gap-1">
                  {photo.tags.split(", ").slice(0, 20).map((tag: string) => (
                    <span key={tag} className="text-xs bg-white/10 text-white/80 px-2 py-0.5 rounded-full">{tag}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
