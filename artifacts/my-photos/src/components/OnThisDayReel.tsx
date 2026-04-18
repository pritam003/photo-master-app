import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronRight, ChevronLeft, X, Pause, Play } from "lucide-react";

interface ReelPhoto {
  id: string;
  thumbnailUrl?: string;
  url: string;
  takenAt?: string;
  uploadedAt?: string;
  filename?: string;
}

interface DayGroup {
  dow: number;
  dayName: string;
  photos: ReelPhoto[];
  isToday?: boolean;
}

interface WeeklyMemoriesProps {
  days: DayGroup[];
  todayDow: number;
}

function getYear(photo: ReelPhoto) {
  const d = photo.takenAt ?? photo.uploadedAt;
  if (!d) return null;
  return new Date(d).getFullYear();
}

// ── Stacked reel overlay ──────────────────────────────────────────────────────
const SLIDE_MS = 3500;

function ReelOverlay({ day, onClose }: { day: DayGroup; onClose: () => void }) {
  const { photos, dayName, isToday } = day;
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);
  const [dir, setDir] = useState<"next" | "prev">("next");
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const goTo = useCallback((idx: number, d: "next" | "prev") => {
    setDir(d);
    setCurrent(idx);
    setProgress(0);
  }, []);
  const goNext = useCallback(() => goTo((current + 1) % photos.length, "next"), [current, photos.length, goTo]);
  const goPrev = useCallback(() => goTo((current - 1 + photos.length) % photos.length, "prev"), [current, photos.length, goTo]);

  useEffect(() => {
    if (paused || photos.length <= 1) return;
    timerRef.current = setInterval(goNext, SLIDE_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [paused, goNext, photos.length]);

  useEffect(() => {
    if (paused) return;
    setProgress(0);
    const step = 100 / (SLIDE_MS / 50);
    progressRef.current = setInterval(() => setProgress(p => Math.min(p + step, 100)), 50);
    return () => { if (progressRef.current) clearInterval(progressRef.current); };
  }, [current, paused]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const photo = photos[current];
  const year = getYear(photo);
  const behind1 = photos[(current + 1) % photos.length];
  const behind2 = photos[(current + 2) % photos.length];

  return (
    <>
      <style>{`
        @keyframes card-in-next {
          from { opacity: 0; transform: translateX(56px) scale(0.86) rotate(4deg); }
          to   { opacity: 1; transform: translateX(0)    scale(1)    rotate(0deg); }
        }
        @keyframes card-in-prev {
          from { opacity: 0; transform: translateX(-56px) scale(0.86) rotate(-4deg); }
          to   { opacity: 1; transform: translateX(0)     scale(1)    rotate(0deg); }
        }
      `}</style>

      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center"
        onClick={onClose}
      >
        {/* Panel — stop propagation so clicks inside don't close */}
        <div
          className="relative flex flex-col items-center"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center gap-3 mb-6 text-white">
            <div className="text-center">
              <h2 className="text-xl font-bold">{isToday ? "On This Day" : `${dayName} memories`}</h2>
              <p className="text-sm text-white/60">{photos.length} {photos.length === 1 ? "memory" : "memories"} · Over the years</p>
            </div>
          </div>

          {/* Card stack */}
          <div
            className="relative flex items-center justify-center"
            style={{ width: 360, height: 420 }}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
          >
            {/* Card 3 back */}
            {photos.length > 2 && (
              <div className="absolute rounded-3xl overflow-hidden shadow-xl"
                style={{ width: 270, height: 360, zIndex: 1, opacity: 0.4, transform: "rotate(-7deg) translateY(18px) translateX(-12px)" }}>
                <img src={behind2.thumbnailUrl || behind2.url} className="w-full h-full object-cover" alt="" />
              </div>
            )}
            {/* Card 2 back */}
            {photos.length > 1 && (
              <div className="absolute rounded-3xl overflow-hidden shadow-2xl"
                style={{ width: 288, height: 376, zIndex: 2, opacity: 0.65, transform: "rotate(-3.5deg) translateY(9px) translateX(-6px)" }}>
                <img src={behind1.thumbnailUrl || behind1.url} className="w-full h-full object-cover" alt="" />
              </div>
            )}
            {/* Active card */}
            <div
              key={`${photo.id}-${current}`}
              className="absolute rounded-3xl overflow-hidden"
              style={{
                width: 306, height: 392, zIndex: 10,
                boxShadow: "0 32px 64px rgba(0,0,0,0.6)",
                animation: `card-in-${dir} 0.4s cubic-bezier(0.34,1.4,0.64,1) both`,
              }}
            >
              <img src={photo.thumbnailUrl || photo.url} alt={photo.filename} className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/5 to-transparent" />
              {/* Progress bar */}
              <div className="absolute top-0 inset-x-0 h-1 bg-white/20 overflow-hidden rounded-full">
                <div className="h-full bg-white rounded-full" style={{ width: `${progress}%` }} />
              </div>
              {/* Counter */}
              <div className="absolute top-3 right-3 bg-black/50 text-white text-xs font-semibold px-2.5 py-1 rounded-full backdrop-blur-sm">
                {current + 1} / {photos.length}
              </div>
              {/* Info */}
              <div className="absolute bottom-0 inset-x-0 p-5">
                {year && <p className="text-white/60 text-sm mb-0.5">{year}</p>}
                <p className="text-white font-bold text-lg">{dayName} memory</p>
              </div>
            </div>

            {/* Prev arrow */}
            {photos.length > 1 && (
              <button onClick={goPrev}
                className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-6 z-20
                           w-11 h-11 rounded-full bg-white/90 shadow-xl flex items-center justify-center
                           text-gray-800 hover:bg-white hover:scale-110 transition-all">
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            {/* Next arrow */}
            {photos.length > 1 && (
              <button onClick={goNext}
                className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-6 z-20
                           w-11 h-11 rounded-full bg-white/90 shadow-xl flex items-center justify-center
                           text-gray-800 hover:bg-white hover:scale-110 transition-all">
                <ChevronRight className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Dots */}
          {photos.length > 1 && (
            <div className="flex items-center gap-1.5 mt-5">
              {photos.map((_, i) => (
                <button key={i} onClick={() => goTo(i, i > current ? "next" : "prev")}
                  className="rounded-full transition-all duration-200"
                  style={{ width: i === current ? 20 : 7, height: 7, background: i === current ? "white" : "rgba(255,255,255,0.35)" }} />
              ))}
            </div>
          )}

          {/* Play/Pause + Close */}
          <div className="flex items-center gap-3 mt-5">
            {photos.length > 1 && (
              <button onClick={() => setPaused(p => !p)}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm transition-colors">
                {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                {paused ? "Play" : "Pause"}
              </button>
            )}
            <button onClick={onClose}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm transition-colors">
              <X className="w-4 h-4" /> Close
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Day tile — landscape card, auto-cycling with crossfade (Google Photos style) ──
const TILE_MS = 3000;
const FADE_MS = 600;

/** Generate a Google-Photos-style memory title from the photos in a day group */
function getMemoryTitle(photos: ReelPhoto[], dayName: string, isToday: boolean): { title: string; sub: string } {
  const years = [...new Set(photos.map(p => getYear(p)).filter(Boolean))] as number[];
  const isVideo = photos.some(p => (p as any).contentType?.startsWith("video/"));

  if (years.length === 0) return { title: isToday ? "On this day" : `${dayName} memories`, sub: "Over the years" };

  const oldest = Math.min(...years);
  const currentYear = new Date().getFullYear();
  const yearsAgo = currentYear - oldest;

  if (isVideo && years.length === 1) return { title: "Video spotlight", sub: String(oldest) };
  if (years.length === 1) {
    if (yearsAgo === 0) return { title: "Just captured", sub: "Today" };
    return { title: `${yearsAgo} year${yearsAgo !== 1 ? "s" : ""} ago`, sub: String(oldest) };
  }
  // Multiple years
  if (isToday) return { title: "On this day", sub: "Over the years" };
  return { title: `${dayName}, over the years`, sub: `${oldest} – ${Math.max(...years)}` };
}

function DayTile({ day, isToday, onClick }: { day: DayGroup; isToday: boolean; onClick: () => void }) {
  const { photos, dayName } = day;
  const [idx, setIdx] = useState(0);
  const [prevUrl, setPrevUrl] = useState<string | null>(null);
  const [fadingOut, setFadingOut] = useState(false);
  const rafRef = useRef<number | null>(null);
  const staggerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (photos.length <= 1) return;
    let timer: ReturnType<typeof setInterval>;
    const advance = () => {
      setIdx(cur => {
        const next = (cur + 1) % photos.length;
        const prevSrc = photos[cur].thumbnailUrl || photos[cur].url;
        setPrevUrl(prevSrc);
        setFadingOut(false);
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = requestAnimationFrame(() => {
            setFadingOut(true);
            setTimeout(() => { setPrevUrl(null); setFadingOut(false); }, FADE_MS);
          });
        });
        return next;
      });
    };
    const randomDelay = Math.random() * TILE_MS;
    staggerRef.current = setTimeout(() => { advance(); timer = setInterval(advance, TILE_MS); }, randomDelay);
    return () => {
      if (staggerRef.current) clearTimeout(staggerRef.current);
      clearInterval(timer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [photos.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const photo = photos[idx];
  const { title, sub } = getMemoryTitle(photos, dayName, isToday);

  // Landscape card: 270×160 — matches Google Photos memory card proportions
  return (
    <div
      onClick={onClick}
      className="relative flex-shrink-0 cursor-pointer rounded-2xl overflow-hidden group"
      style={{ width: 270, height: 160 }}
    >
      {/* New photo underneath */}
      <img
        src={photo.thumbnailUrl || photo.url}
        alt={dayName}
        className="absolute inset-0 w-full h-full object-cover"
        draggable={false}
      />
      {/* Previous photo fading out */}
      {prevUrl && (
        <img
          src={prevUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={{ opacity: fadingOut ? 0 : 1, transition: fadingOut ? `opacity ${FADE_MS}ms ease` : "none" }}
          draggable={false}
        />
      )}
      {/* Dark gradient */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />

      {/* Today badge */}
      {isToday && (
        <div className="absolute top-2.5 left-3 bg-blue-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide shadow">
          Today
        </div>
      )}

      {/* Photo count dots — top right */}
      {photos.length > 1 && (
        <div className="absolute top-2.5 right-3 flex gap-1">
          {photos.slice(0, 5).map((_, i) => (
            <div key={i} className="rounded-full" style={{
              width: i === idx ? 14 : 5, height: 5,
              background: i === idx ? "white" : "rgba(255,255,255,0.4)",
              transition: "width 0.3s ease",
            }} />
          ))}
          {photos.length > 5 && <div className="text-white text-[9px] ml-0.5 leading-none self-center opacity-70">+{photos.length - 5}</div>}
        </div>
      )}

      {/* Bottom info — Google Photos style title + subtitle */}
      <div className="absolute bottom-0 inset-x-0 px-3 pb-3">
        <p className="text-white font-bold text-sm leading-tight">{title}</p>
        <p className="text-white/65 text-[11px] mt-0.5">{sub}</p>
      </div>

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-white/0 group-hover:bg-white/8 transition-colors duration-200 rounded-2xl" />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function OnThisDayReel({ days, todayDow }: WeeklyMemoriesProps) {
  const [openDay, setOpenDay] = useState<DayGroup | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const updateScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 8);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
  };

  const scroll = (dir: "left" | "right") => {
    scrollRef.current?.scrollBy({ left: dir === "right" ? 360 : -360, behavior: "smooth" });
  };

  const handleDismiss = () => {
    setDismissed(true);
    // no callback needed — parent can keep showing other content
  };

  if (dismissed) return null;

  return (
    <>
      {openDay && <ReelOverlay day={openDay} onClose={() => setOpenDay(null)} />}

      <div className="mb-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-3 px-0.5">
          <h2 className="text-base font-semibold text-foreground">Memories</h2>
          <button
            onClick={handleDismiss}
            className="p-1.5 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tile strip */}
        <div className="relative group/strip">
          {canScrollLeft && (
            <button
              onClick={() => scroll("left")}
              className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-4 z-10
                         w-9 h-9 rounded-full bg-white shadow-lg flex items-center justify-center
                         text-gray-700 hover:shadow-xl transition-all
                         opacity-0 group-hover/strip:opacity-100"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
          {canScrollRight && (
            <button
              onClick={() => scroll("right")}
              className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-4 z-10
                         w-9 h-9 rounded-full bg-white shadow-lg flex items-center justify-center
                         text-gray-700 hover:shadow-xl transition-all
                         opacity-0 group-hover/strip:opacity-100"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          )}

          <div
            ref={scrollRef}
            onScroll={updateScroll}
            className="flex gap-3 overflow-x-auto"
            style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
          >
            {days.map((day, i) => (
              <DayTile
                key={`${day.dow}-${i}`}
                day={day}
                isToday={!!(day.isToday) || day.dow === todayDow}
                onClick={() => setOpenDay(day)}
              />
            ))}
            <div className="flex-shrink-0 w-1" />
          </div>
        </div>
      </div>
    </>
  );
}
