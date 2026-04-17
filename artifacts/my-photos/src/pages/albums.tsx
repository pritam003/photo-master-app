import { useState, useEffect } from "react";
import { Plus, BookImage, Trash2, FolderDown, Share2 } from "lucide-react";
import { useListAlbums, useCreateAlbum, useDeleteAlbum, getListAlbumsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import GoogleImportModal from "@/components/GoogleImportModal";
import ShareAlbumModal from "@/components/ShareAlbumModal";

export default function AlbumsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [activeImportId, setActiveImportId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [shareTarget, setShareTarget] = useState<{ id: string; name: string } | null>(null);

  // Auto-open modal when arriving from Google OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const importId = params.get("import_id");
    const importError = params.get("import_error");
    if (importId || importError) {
      setActiveImportId(importId);
      setShowImport(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);
  const queryClient = useQueryClient();

  const { data: albums, isLoading } = useListAlbums({
    query: { queryKey: getListAlbumsQueryKey() },
  });
  const createAlbum = useCreateAlbum();
  const deleteAlbum = useDeleteAlbum();

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await createAlbum.mutateAsync({ data: { name: name.trim() } });
    queryClient.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
    setName("");
    setShowCreate(false);
  };

  const handleDelete = async (id: string, albumName: string) => {
    if (!confirm(`Delete album "${albumName}"? Photos will not be deleted.`)) return;
    await deleteAlbum.mutateAsync({ id });
    queryClient.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
  };

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-background sticky top-0 z-10">
        <h1 className="text-lg font-semibold text-foreground">Albums</h1>
        <div className="flex-1" />
        <button
          onClick={() => setShowImport(true)}
          title="Import from Google Photos"
          className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 text-sm rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          {/* Google 'G' icon small */}
          <svg viewBox="0 0 24 24" className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          <span className="hidden sm:inline">Import from Google</span>
        </button>
        <button
          onClick={() => setShowCreate(true)}
          data-testid="button-create-album"
          className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">New album</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="aspect-square bg-muted animate-pulse rounded-xl" />
            ))}
          </div>
        ) : !albums || albums.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <BookImage className="w-12 h-12 mb-3 opacity-30" />
            <p>No albums yet</p>
            <button onClick={() => setShowCreate(true)} className="mt-3 text-sm text-primary hover:underline">Create your first album</button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {albums.map((album: any) => (
              <div key={album.id} className="group relative" data-testid={`album-${album.id}`}>
                <Link href={`/albums/${album.id}`}>
                  <a className="block">
                    <div className="aspect-square rounded-xl overflow-hidden bg-muted mb-2 relative">
                      {album.coverUrl ? (
                        <img src={album.coverUrl} alt={album.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <BookImage className="w-10 h-10 text-muted-foreground/40" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded-xl" />
                      {album.photoCount > 0 && (
                        <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-md bg-black/60 text-white text-[10px] font-semibold leading-tight">
                          {album.photoCount}
                        </div>
                      )}
                    </div>
                    <p className="text-sm font-medium text-foreground truncate">{album.name}</p>
                    <p className="text-xs text-muted-foreground">{album.photoCount} photo{album.photoCount !== 1 ? "s" : ""}</p>
                  </a>
                </Link>
                <button
                  onClick={() => handleDelete(album.id, album.name)}
                  className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/80"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                {/* Share button — always visible on mobile, hover on desktop */}
                <button
                  onClick={e => { e.preventDefault(); setShareTarget({ id: album.id, name: album.name }); }}
                  className="absolute top-2 left-2 p-1.5 rounded-lg bg-black/50 text-white sm:opacity-0 sm:group-hover:opacity-100 transition-opacity hover:bg-black/70"
                  title="Share album"
                >
                  <Share2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <h2 className="text-lg font-semibold text-foreground mb-4">New Album</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <input
                type="text"
                placeholder="Album name"
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
                data-testid="input-album-name"
                className="w-full px-3 py-2.5 text-sm bg-muted rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary placeholder:text-muted-foreground"
              />
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors">
                  Cancel
                </button>
                <button type="submit" data-testid="button-save-album" className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showImport && (
        <GoogleImportModal
          activeImportId={activeImportId}
          allowCreateAlbum
          onClose={() => {
            setShowImport(false);
            setActiveImportId(null);
            queryClient.invalidateQueries({ queryKey: getListAlbumsQueryKey() });
          }}
        />
      )}

      {shareTarget && (
        <ShareAlbumModal
          albumId={shareTarget.id}
          albumName={shareTarget.name}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}
