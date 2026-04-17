import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { VitePWA } from "vite-plugin-pwa";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      // Auto-generate all icon sizes from public/pwa-icon.svg
      pwaAssets: {
        disabled: false,
        config: true, // uses pwa-assets.config.ts
      },
      manifest: {
        name: "APhoto",
        short_name: "APhoto",
        description: "Your personal photo library",
        theme_color: "#FF3C00",
        background_color: "#000000",
        display: "standalone",
        start_url: "/",
        orientation: "portrait-primary",
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        // Appear in the Android/iOS share sheet so users can share photos
        // directly from their gallery app into APhoto
        share_target: {
          action: "/share-target",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            files: [
              {
                name: "photos",
                accept: ["image/*", "video/*"],
              },
            ],
          },
        },
        // Allow photos to be opened directly in APhoto from file manager
        file_handlers: [
          {
            action: "/",
            accept: {
              "image/*": [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif"],
              "video/*": [".mp4", ".mov", ".avi", ".mkv"],
            },
          },
        ],
        screenshots: [
          {
            src: "opengraph.jpg",
            sizes: "1200x630",
            type: "image/jpeg",
            // @ts-expect-error — non-standard but supported by Chrome
            form_factor: "wide",
            label: "APhoto Library",
          },
        ],
      },
      includeAssets: ["favicon.svg", "apple-touch-icon-180x180.png"],
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
        globIgnores: ["**/node_modules/**"],
      },
      devOptions: {
        // Keep SW disabled during dev to avoid interfering with HMR
        enabled: false,
      },
    }),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
