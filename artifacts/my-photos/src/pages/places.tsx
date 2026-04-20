import { useState, useEffect, useCallback } from "react";
import { MapPin, ArrowLeft } from "lucide-react";
import { API_BASE } from "@/lib/api";
import PhotoGrid from "@/components/PhotoGrid";

interface LocationCard {
  locationName: string;
  count: number;
  coverUrl: string | null;
}

function PlaceCard({ loc, onClick }: { loc: LocationCard; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group relative overflow-hidden rounded-2xl bg-muted border border-border text-left hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary/40"
    >
      {/* Cover photo */}
      <div className="aspect-[4/3] w-full overflow-hidden bg-muted">
        {loc.coverUrl ? (
          <img
            src={loc.coverUrl}
            alt={loc.locationName}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <MapPin className="w-10 h-10 text-muted-foreground/40" />
          </div>
        )}
      </div>

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />

      {/* Text */}
      <div className="absolute bottom-0 left-0 right-0 p-3">
        <p className="text-sm font-semibold text-white leading-tight line-clamp-2">{loc.locationName}</p>
        <p className="text-xs text-white/70 mt-0.5">{loc.count} photo{loc.count !== 1 ? "s" : ""}</p>
      </div>
    </button>
  );
}

export default function PlacesPage() {
  const [locations, setLocations] = useState<LocationCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);
  const [placePhotos, setPlacePhotos] = useState<any[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/photos/by-location`, { credentials: "include" })
      .then(r => r.ok ? r.json() : { locations: [] })
      .then(d => { setLocations(d.locations ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedPlace) { setPlacePhotos([]); return; }
    setPhotosLoading(true);
    const params = new URLSearchParams({ location: selectedPlace, trashed: "false", hidden: "false", limit: "500" });
    fetch(`${API_BASE}/photos?${params}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : { photos: [] })
      .then(d => setPlacePhotos(d.photos ?? []))
      .catch(() => setPlacePhotos([]))
      .finally(() => setPhotosLoading(false));
  }, [selectedPlace]);

  const handleBack = useCallback(() => setSelectedPlace(null), []);

  /* ── Place detail view ──────────────────────────────────────────────────── */
  if (selectedPlace) {
    return (
      <div className="flex-1 flex flex-col h-full">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-background sticky top-0 z-10">
          <button
            onClick={handleBack}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Places
          </button>
          <span className="text-muted-foreground">/</span>
          <MapPin className="w-4 h-4 text-primary shrink-0" />
          <h1 className="text-lg font-semibold text-foreground truncate flex-1">{selectedPlace}</h1>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {photosLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="aspect-square bg-muted animate-pulse rounded-sm" />
              ))}
            </div>
          ) : (
            <PhotoGrid photos={placePhotos} emptyMessage="No photos for this location" />
          )}
        </div>
      </div>
    );
  }

  /* ── Place grid view ────────────────────────────────────────────────────── */
  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-background sticky top-0 z-10">
        <MapPin className="w-5 h-5 text-primary shrink-0" />
        <h1 className="text-lg font-semibold text-foreground">Places</h1>
        {!loading && (
          <span className="text-sm text-muted-foreground">{locations.length} location{locations.length !== 1 ? "s" : ""}</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="aspect-[4/3] bg-muted animate-pulse rounded-2xl" />
            ))}
          </div>
        ) : locations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-4 text-muted-foreground">
            <MapPin className="w-12 h-12 opacity-30" />
            <p className="text-sm">No location data yet</p>
            <p className="text-xs text-center max-w-xs">
              Photos with GPS coordinates will be grouped here after the background worker geocodes them.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {locations.map(loc => (
              <PlaceCard key={loc.locationName} loc={loc} onClick={() => setSelectedPlace(loc.locationName)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
