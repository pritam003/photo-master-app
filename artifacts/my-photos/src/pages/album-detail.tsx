import { useRoute, useLocation } from "wouter";
import { ArrowLeft, Pencil, Check, Upload, Plus, X, Share2, Archive, MoreHorizontal } from "lucide-react";
import GoogleImportModal from "@/components/GoogleImportModal";
import ShareAlbumModal from "@/components/ShareAlbumModal";
import { useState } from "react";
import { useGetAlbum, useListAlbumPhotos, useUpdateAlbum, useListPhotos, useAddPhotoToAlbum, useRemovePhotoFromAlbum, useTrashPhoto, getListAlbumsQueryKey, getListAlbumPhotosQueryKey, getListPhotosQueryKey, getGetPhotoStatsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import PhotoGrid from "@/components/PhotoGrid";
import UploadModal from "@/components/UploadModal";
import { useImport } from "@/lib/importContext";
import { API_BASE } from "@/lib/api";

export default function AlbumDetailPage() {
  const [, params] = useRoute("/albums/:id");
  const id = params?.id ?? "";
  const [, navigate] = useLocation();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerLimit, setPickerLimit] = useState(50);
  const [showGoogleImport, setShowGoogleImport] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [sortOrder, setSortOrder] = useState<"taken" | "uploaded">("taken");
  const [displayLimit, setDisplayLimit] = useState(50);
  const queryClient = useQueryClient();

  const { activeImportAlbumId } = useImport();

  const { data: album } = useGetAlbum(id, {
    query: { queryKey: ["album", id], enabled: !!id },
  });
  const { data, isLoading } = useListAlbumPhotos(id, {
    query: {
      queryKey: getListAlbumPhotosQueryKey(id),
      enabled: !!id,
      refetchInterval: activeImportAlbumId === id ? 3000 : false,
    },
  });
  const { data: allPhotosData } = useListPhotos({}, {
    query: { queryKey: ["all-photos-for-picker"], enabled: showPicker },
  });
  const updateAlbum = useUpdateAlbum();
  const addPhoto = useAddPhotoToAlbum();
  const removePhoto = useRemovePhotoFromAlbum();
  const trashPhoto = useTrashPhoto();

  const photos = (data?.photos ?? []).slice().sort((a: any, b: any) => {
    if (sortOrder === "uploaded") {
      return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
    }
    const da = new Date(a.takenAt ?? a.uploadedAt).getTime();
    const db2 = new Date(b.takenAt ?? b.uploadedAt).getTime();
    return db2 - da;
  });
  const albumPhotoIds = new Set(photos.map((p: any) => p.id));
  const libraryPhotos = (allPhotosData?.photos ?? []).filter((p: any) => !albumPhotoIds.has(p.id));

  const startEdit = () => {
    setEditName(album?.name ?? "");
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!editName.trim()) return;
    await updateAlbum.mutateAsync({ id, data: { name: editName.trim() } });
    queryClient.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
    setEditing(false);
  };

  const handleAddExisting = async (photoId: string) => {
    await addPhoto.mutateAsync({ id, data: { photoId } });
    queryClient.invalidateQueries({ queryKey: getListAlbumPhotosQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
  };

  const handleRemoveFromAlbum = async (photoId: string) => {
    // Remove from cache first so UI updates immediately
    queryClient.setQueryData(getListAlbumPhotosQueryKey(id), (old: any) => {
      if (!old) return old;
      return { ...old, photos: old.photos.filter((p: any) => p.id !== photoId) };
    });
    await removePhoto.mutateAsync({ id, photoId });
    // Invalidate after mutation so cover photo etc. updates in background
    queryClient.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
  };

  const handleTrash = async (photoId: string) => {
    // Remove from cache first so UI updates immediately
    queryClient.setQueryData(getListAlbumPhotosQueryKey(id), (old: any) => {
      if (!old) return old;
      return { ...old, photos: old.photos.filter((p: any) => p.id !== photoId) };
    });
    await trashPhoto.mutateAsync({ id: photoId, data: { trashed: true } });
    queryClient.invalidateQueries({ queryKey: getListPhotosQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPhotoStatsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAlbumPhotosQueryKey(id) });
  };

  const handleBulkTrash = async (ids: string[]) => {
    queryClient.setQueryData(getListAlbumPhotosQueryKey(id), (old: any) => {
      if (!old) return old;
      return { ...old, photos: old.photos.filter((p: any) => !ids.includes(p.id)) };
    });
    await Promise.all(ids.map(photoId => trashPhoto.mutateAsync({ id: photoId, data: { trashed: true } })));
    queryClient.invalidateQueries({ queryKey: getListPhotosQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPhotoStatsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAlbumPhotosQueryKey(id) });
  };

  const handleArchiveAlbum = async () => {
    if (!photos.length) return;
    if (!confirm(`Archive all ${photos.length} photos in "${album?.name}"? They will be moved to your Archive and hidden from the main library.`)) return;
    setArchiving(true);
    try {
      await fetch(`${API_BASE}/albums/${id}/archive`, {
        method: "PATCH",
        credentials: "include",
      });
      queryClient.invalidateQueries({ queryKey: getListPhotosQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetPhotoStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListAlbumPhotosQueryKey(id) });
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="flex items-center border-b border-border bg-background sticky top-0 z-10 px-4 py-3 sm:px-6 sm:py-4 gap-3">

        {/* ── MOBILE header ── */}
        <div className="flex sm:hidden items-center gap-1.5 w-full min-w-0">
          <button onClick={() => navigate("/albums")} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground shrink-0">
            <ArrowLeft className="w-4 h-4" />
          </button>
          {editing ? (
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                autoFocus
                className="text-base font-semibold bg-transparent border-b-2 border-primary outline-none text-foreground w-full min-w-0"
                onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(false); }}
              />
              <button onClick={saveEdit} className="p-1 text-primary shrink-0"><Check className="w-4 h-4" /></button>
            </div>
          ) : (
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <h1 className="text-base font-semibold text-foreground truncate">{album?.name}</h1>
              <button onClick={startEdit} className="p-1 rounded-lg text-muted-foreground shrink-0">
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {/* Share — always visible */}
          <button onClick={() => setShowShare(true)} title="Share album" className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0">
            <Share2 className="w-5 h-5" />
          </button>
          {/* Upload */}
          <button onClick={() => setShowUpload(true)} title="Upload photos" className="p-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shrink-0">
            <Upload className="w-4 h-4" />
          </button>
          {/* More ⋯ */}
          <div className="relative shrink-0">
            <button onClick={() => setShowMobileMenu(m => !m)} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <MoreHorizontal className="w-5 h-5" />
            </button>
            {showMobileMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMobileMenu(false)} />
                <div className="absolute right-0 top-full mt-1 w-52 bg-card border border-border rounded-xl shadow-xl z-50 py-1 text-sm overflow-hidden">
                  <p className="px-3 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Sort</p>
                  <button onClick={() => { setSortOrder("taken"); setDisplayLimit(50); setShowMobileMenu(false); }} className={`w-full text-left px-3 py-2 hover:bg-muted transition-colors ${sortOrder === "taken" ? "text-primary font-medium" : ""}`}>Date taken</button>
                  <button onClick={() => { setSortOrder("uploaded"); setDisplayLimit(50); setShowMobileMenu(false); }} className={`w-full text-left px-3 py-2 hover:bg-muted transition-colors ${sortOrder === "uploaded" ? "text-primary font-medium" : ""}`}>Date added</button>
                  <div className="h-px bg-border mx-3 my-1" />
                  <button onClick={() => { setShowPicker(true); setShowMobileMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-muted transition-colors flex items-center gap-2">
                    <Plus className="w-3.5 h-3.5" /> Add existing
                  </button>
                  <button onClick={() => { setShowGoogleImport(true); setShowMobileMenu(false); }} className="w-full text-left px-3 py-2 hover:bg-muted transition-colors flex items-center gap-2">
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0" xmlns="http://www.w3.org/2000/svg">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    Import from Google
                  </button>
                  <button onClick={() => { handleArchiveAlbum(); setShowMobileMenu(false); }} disabled={archiving || !photos.length} className="w-full text-left px-3 py-2 hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground disabled:opacity-50">
                    <Archive className="w-3.5 h-3.5" /> {archiving ? "Archiving…" : "Archive"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── DESKTOP header — unchanged ── */}
        <button onClick={() => navigate("/albums")} className="hidden sm:block p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        {editing ? (
          <div className="hidden sm:flex items-center gap-2 flex-1">
            <input
              value={editName}
              onChange={e => setEditName(e.target.value)}
              autoFocus
              className="text-lg font-semibold bg-transparent border-b-2 border-primary outline-none text-foreground"
              onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(false); }}
            />
            <button onClick={saveEdit} className="p-1 text-primary"><Check className="w-4 h-4" /></button>
          </div>
        ) : (
          <div className="hidden sm:flex items-center gap-2 flex-1">
            <h1 className="text-lg font-semibold text-foreground">{album?.name}</h1>
            <button onClick={startEdit} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        <span className="hidden sm:inline text-sm text-muted-foreground">{photos.length} photo{photos.length !== 1 ? "s" : ""}</span>
        <select
          value={sortOrder}
          onChange={e => { setSortOrder(e.target.value as "taken" | "uploaded"); setDisplayLimit(50); }}
          className="hidden sm:block text-xs px-2 py-1.5 rounded-md border border-border bg-background text-foreground cursor-pointer"
        >
          <option value="taken">Date taken</option>
          <option value="uploaded">Date added</option>
        </select>
        <button onClick={() => setShowPicker(true)} className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-muted transition-colors">
          <Plus className="w-4 h-4" /> Add existing
        </button>
        <button onClick={() => setShowGoogleImport(true)} className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Import from Google
        </button>
        <button onClick={handleArchiveAlbum} disabled={archiving || !photos.length} className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50" title="Move all photos in this album to Archive">
          <Archive className="w-4 h-4" />
          {archiving ? "Archiving…" : "Archive album"}
        </button>
        <button onClick={() => setShowShare(true)} className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-muted transition-colors">
          <Share2 className="w-4 h-4" /> Share
        </button>
        <button onClick={() => setShowUpload(true)} className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
          <Upload className="w-4 h-4" /> Upload
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-1">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="aspect-square bg-muted animate-pulse rounded-sm" />
            ))}
          </div>
        ) : (
          <>
            <PhotoGrid
              photos={photos.slice(0, displayLimit)}
              dateField={sortOrder}
              emptyMessage="No photos in this album yet. Upload or add existing photos."
              onRemoveFromAlbum={handleRemoveFromAlbum}
              onTrash={handleTrash}
              onBulkTrash={handleBulkTrash}
            />
            {displayLimit < photos.length && (
              <div className="flex justify-center py-6">
                <button
                  onClick={() => setDisplayLimit(l => l + 50)}
                  className="px-5 py-2 text-sm rounded-xl border border-border hover:bg-muted transition-colors"
                >
                  Show more
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          albumId={id}
          albumName={album?.name}
        />
      )}

      {showGoogleImport && (
        <GoogleImportModal
          onClose={() => setShowGoogleImport(false)}
          targetAlbumId={id}
          albumDisplayName={album?.name ?? ""}
          onDone={() => queryClient.invalidateQueries({ queryKey: getListAlbumPhotosQueryKey(id) })}
        />
      )}

      {showPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-lg font-semibold text-foreground">Add photos to "{album?.name}"</h2>
              <button onClick={() => { setShowPicker(false); setPickerLimit(50); }} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {libraryPhotos.length === 0 ? (
                <p className="text-center text-muted-foreground py-12">All your photos are already in this album.</p>
              ) : (
                <>
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                    {libraryPhotos.slice(0, pickerLimit).map((photo: any) => (
                      <button
                        key={photo.id}
                        onClick={() => handleAddExisting(photo.id)}
                        className="relative aspect-square rounded-lg overflow-hidden bg-muted group hover:ring-2 hover:ring-primary transition-all"
                      >
                        <img src={photo.thumbnailUrl || photo.url} alt={photo.filename} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                          <Plus className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </button>
                    ))}
                  </div>
                  {pickerLimit < libraryPhotos.length && (
                    <div className="mt-4 flex justify-center">
                      <button
                        onClick={() => setPickerLimit(l => l + 50)}
                        className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors"
                      >
                        Show more
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="px-6 py-3 border-t border-border">
              <button onClick={() => { setShowPicker(false); setPickerLimit(50); }} className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors">
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {showShare && (
        <ShareAlbumModal
          albumId={id}
          albumName={album?.name ?? ""}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}
