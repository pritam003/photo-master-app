/**
 * record-demo.mjs
 * 36-second slideshow — each tab gets exactly 3 seconds, no waiting for images.
 * Usage: AUTH_STATE_PATH=auth-state.json node scripts/record-demo.mjs
 */

import { chromium } from "playwright";
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR   = path.join(__dirname, "..", "docs");
const TEMP_DIR   = path.join(DOCS_DIR, ".video-tmp");
const OUTPUT_MP4 = path.join(DOCS_DIR, "demo.mp4");
const OUTPUT_GIF = path.join(DOCS_DIR, "demo.gif");

const BASE_URL        = "https://green-river-0bfcd7a0f.1.azurestaticapps.net";
const VIEWPORT        = { width: 1280, height: 800 };
const AUTH_STATE_PATH = process.env.AUTH_STATE_PATH;
const SCENE_MS        = 3000; // exactly 3s per scene

if (!AUTH_STATE_PATH || !fs.existsSync(AUTH_STATE_PATH)) {
  console.error("AUTH_STATE_PATH not set or file not found.");
  process.exit(1);
}

fs.mkdirSync(TEMP_DIR, { recursive: true });

const pause = (ms) => new Promise(r => setTimeout(r, ms));

/** Navigate and immediately start the 3s clock — don't wait for images */
async function go(page, urlPath) {
  await page.goto(`${BASE_URL}${urlPath}`, { waitUntil: "domcontentloaded", timeout: 30000 });
}

/** Click a nav link by visible text */
async function nav(page, name) {
  await page.getByRole("link", { name }).first().click();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_STATE_PATH,
    viewport: VIEWPORT,
    recordVideo: { dir: TEMP_DIR, size: VIEWPORT },
  });

  const page = await context.newPage();

  // Pre-warm: load the app once so subsequent navigations are faster (cached assets)
  console.log("\nRecording demo…\n");
  await go(page, "/");
  await pause(4000); // let the library fully paint before we start the tour

  // ── 1. Library (scroll to show grid) ──────────────────────────────────────
  console.log("  📷 Library…");
  await go(page, "/");
  await pause(800);
  // quick scroll to reveal photo grid
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 90);
    await pause(80);
  }
  await pause(SCENE_MS - 6 * 80 - 800);

  // ── 2. Albums ─────────────────────────────────────────────────────────────
  console.log("  📁 Albums…");
  await nav(page, "Albums");
  await pause(SCENE_MS);

  // ── 3. People ─────────────────────────────────────────────────────────────
  console.log("  👤 People…");
  await nav(page, "People");
  await pause(SCENE_MS);

  // ── 4. Favorites ──────────────────────────────────────────────────────────
  console.log("  ❤️  Favorites…");
  await nav(page, "Favorites");
  await pause(SCENE_MS);

  // ── 5. Archive ────────────────────────────────────────────────────────────
  console.log("  🔒 Archive…");
  await nav(page, "Archive");
  await pause(SCENE_MS);

  // ── 6. Trash ──────────────────────────────────────────────────────────────
  console.log("  🗑  Trash…");
  await nav(page, "Trash");
  await pause(SCENE_MS);

  // ── 7. Search ─────────────────────────────────────────────────────────────
  console.log("  🔎 Search…");
  await go(page, "/");
  await pause(800);
  const searchInput = page.locator("input[data-testid='input-search']");
  if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await searchInput.click();
    await page.keyboard.type("beach", { delay: 80 });
  }
  await pause(SCENE_MS - 800);

  // ── 8. Upload modal ───────────────────────────────────────────────────────
  console.log("  ⬆️  Upload…");
  await go(page, "/");
  await pause(800);
  const uploadBtn = page.locator("[data-testid='button-upload']");
  if (await uploadBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await uploadBtn.click();
    await pause(SCENE_MS - 800);
    // close modal
    const closeBtn = page.locator("div.fixed.inset-0.z-50 button").first();
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeBtn.click();
    } else {
      await page.keyboard.press("Escape");
    }
  } else {
    await pause(SCENE_MS - 800);
  }

  // ── 9. Lightbox (open a photo) ────────────────────────────────────────────
  console.log("  🔍 Lightbox…");
  await go(page, "/");
  await pause(1500);
  const photos = page.locator("[data-photo-id]");
  const count  = await photos.count().catch(() => 0);
  if (count > 0) {
    await photos.nth(Math.min(2, count - 1)).click();
    await pause(1200);
    await page.keyboard.press("ArrowRight");
    await pause(800);
    await page.keyboard.press("Escape");
    await pause(500);
  } else {
    await pause(SCENE_MS);
  }

  // ── 10. Library scroll-out ────────────────────────────────────────────────
  console.log("  📷 Library (scroll)…");
  await go(page, "/");
  await pause(600);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 80);
    await pause(60);
  }
  await pause(SCENE_MS - 600 - 10 * 60);

  await context.close();
  await browser.close();

  // ── Find .webm ─────────────────────────────────────────────────────────────
  const files = fs.readdirSync(TEMP_DIR).filter(f => f.endsWith(".webm"));
  if (!files.length) { console.error("No .webm found"); process.exit(1); }
  const webm = path.join(TEMP_DIR, files[0]);

  // ── MP4 ────────────────────────────────────────────────────────────────────
  console.log("\nConverting to MP4…");
  execSync(
    `ffmpeg -y -i "${webm}" -vf "fps=30,scale=1280:-2" -c:v libx264 -crf 20 -preset fast -pix_fmt yuv420p "${OUTPUT_MP4}"`,
    { stdio: "inherit" }
  );
  console.log(`✓  docs/demo.mp4  (${(fs.statSync(OUTPUT_MP4).size / 1e6).toFixed(1)} MB)`);

  // ── GIF (full recording, ~36s) ─────────────────────────────────────────────
  console.log("\nConverting to GIF…");
  const palette = path.join(TEMP_DIR, "palette.png");
  execSync(
    `ffmpeg -y -i "${webm}" -vf "fps=10,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" -update 1 "${palette}"`,
    { stdio: "inherit" }
  );
  execSync(
    `ffmpeg -y -i "${webm}" -i "${palette}" -lavfi "fps=10,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5" -loop 0 "${OUTPUT_GIF}"`,
    { stdio: "inherit" }
  );
  console.log(`✓  docs/demo.gif  (${(fs.statSync(OUTPUT_GIF).size / 1e6).toFixed(1)} MB)`);

  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  console.log("\nDone!\n");
}

main().catch(err => { console.error(err); process.exit(1); });
