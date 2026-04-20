import { useState, useEffect, useRef } from "react";

interface BlurThumbProps {
  src: string;
  webpSrc?: string | null;
  lqipSrc?: string | null;
  dominantColor?: string | null;
  alt: string;
  className?: string;
  loading?: "lazy" | "eager";
  fetchPriority?: "high" | "low" | "auto";
  style?: React.CSSProperties;
}

/**
 * Photo thumbnail with LQIP blur-up effect, WebP support, and dominant-colour background.
 *
 * Rendering order (bottom → top):
 *   1. Wrapper div coloured with the dominant colour extracted server-side — shows instantly,
 *      no network request, prevents the white flash before the LQIP loads.
 *   2. <picture> / <img> for the actual thumbnail — lazy-loaded, webp-first.
 *   3. LQIP overlay — blurred low-quality placeholder, fades out once the main image loads.
 *   4. Pulse skeleton — used only when no LQIP is available.
 *
 * Cache behaviour:
 *   useEffect runs after first paint and checks img.complete — for cached images the LQIP
 *   is removed immediately (no blur flash). For network images onLoad drives the fade.
 */
export default function BlurThumb({
  src,
  webpSrc,
  lqipSrc,
  dominantColor,
  alt,
  className = "w-full h-full object-cover",
  loading = "lazy",
  fetchPriority = "auto",
  style,
}: BlurThumbProps) {
  const [lqipVisible, setLqipVisible] = useState(true);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
      setLqipVisible(false);
    }
  }, [src]);

  return (
    <>
      {/* Dominant-colour layer — instant background, no network request */}
      {dominantColor && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: dominantColor }}
          aria-hidden="true"
        />
      )}

      {/* Main image — WebP for modern browsers, JPEG fallback */}
      <picture className="contents">
        {webpSrc && <source srcSet={webpSrc} type="image/webp" />}
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          loading={loading}
          fetchPriority={fetchPriority}
          decoding="async"
          className={className}
          style={style}
          sizes="(max-width: 640px) 33vw, (max-width: 768px) 25vw, (max-width: 1024px) 20vw, 15vw"
          onLoad={() => setLqipVisible(false)}
        />
      </picture>

      {/* LQIP overlay — fades out after main image loads */}
      {lqipSrc && (
        <img
          src={lqipSrc}
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover pointer-events-none transition-opacity duration-300"
          style={{
            filter: "blur(20px)",
            transform: "scale(1.12)",
            opacity: lqipVisible ? 1 : 0,
          }}
        />
      )}

      {/* Pulse skeleton fallback when no LQIP available */}
      {!lqipSrc && lqipVisible && (
        <div className="absolute inset-0 bg-muted animate-pulse pointer-events-none" />
      )}
    </>
  );
}
