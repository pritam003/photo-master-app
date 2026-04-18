/**
 * record-demo.mjs
 *
 * Records a polished slideshow-style walkthrough of the APhoto UI.
 * Each feature gets a dedicated scene. Output: docs/demo.gif (inline on GitHub)
 * and docs/demo.mp4 (full quality).
 *
 * Usage:
 *   AUTH_STATE_PATH=auth-state.json node scripts/record-demo.mjs
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

if (!AUTH_STATE_PATH || !fs.existsSync(AUTH_STATE_PATH)) {
  console.error("AUTH_STATE_PATH not set or file not found.");
  process.exit(1);
}

fs.mkdirSync(TEMP_DIR, { recursive: true });

const pause   = (ms) => new Promise(r => setTimeout(r, ms));

async function smoothScroll(page, px, duration = 1500) {
  const steps = 25;
  const dy    = px / steps;
  const delay = duration / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy);
    await pause(delay);
  }
}

async function waitForImages(page) {
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll("img"));
    const loaded = imgs.filter(img => img.src && img.src !== window.location.href);
    if (loaded.length === 0) return true;
    return loaded.every(img => img.complete && img.naturalWidth > 0);
  }, { timeout: 15000 }).catch(() => {});
}

async function waitNoOverlay(page) {
  await page.waitForFunction(
    () => !document.querySelector("div.fixed.inset-0.z-50"),
    { timeout: 6000 }
  ).catch(() => {});
  await pause(300);
}

async function goTo(page, path) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "load", timeout: 60000 });
  await pause(1200);
  await waitForImages(page);
  await pause(300);
}

// ── Scene helpers ──────────────────────────────────────────────────────────────

async function sceneLibrary(page) {
  console.log("  📷 Library…");
  await goTo(page, "/");
  await pause(500);
  await smoothScroll(page, 600, 1200);
  await pause(400);
  await smoothScroll(page, -600, 900);
  await pause(300);
}

async function sceneMemories(page) {
  console.log("  🗓  Memories reel…");
  await goTo(page, "/");
  await pause(1500);
}

async function sceneLightbox(page) {
  console.log("  🔍 Lightbox…");
  await goTo(page, "/");
  // Click the first photo in the grid (below the memories reel)
  const photos = page.locator("[data-photo-id]");
  const count = await photos.count();
  if (count > 0) {
    const idx = Math.min(2, count - 1);
    await photos.nth(idx).click();
    await pause(1200);
    await waitForImages(page);
    await pause(1000);
    await page.keyboard.press("ArrowRight");
    await pause(800);
    await page.keyboard.press("Escape");
    await waitNoOverlay(page);
    await pause(300);
  }
}

async function sceneAlbums(page) {
  console.log("  📁 Albums…");
  await page.getByRole('link', { name: 'Albums' }).first().click();
  await pause(1500);
  await waitForImages(page);
  await pause(700);

  const albumCards = page.locator("a[href*='/albums/']");
  if (await albumCards.count() > 0) {
    await albumCards.first().click();
    await pause(1200);
    await waitForImages(page);
    await pause(800);
  }
}

async function scenePeople(page) {
  console.log("  👤 People…");
  await page.getByRole('link', { name: 'People' }).first().click();
  await pause(1500);
  await waitForImages(page);
  await pause(700);

  const personCards = page.locator("a[href*='/people/']");
  if (await personCards.count() > 0) {
    await personCards.first().click();
    await pause(1200);
    await waitForImages(page);
    await pause(800);
  }
}

async function sceneFavorites(page) {
  console.log("  ❤️  Favorites…");
  await page.getByRole('link', { name: 'Favorites' }).first().click();
  await pause(1500);
  await waitForImages(page);
  await pause(700);
}

async function sceneArchive(page) {
  console.log("  🔒 Archive…");
  await page.getByRole('link', { name: 'Archive' }).first().click();
  await pause(1500);
  await pause(800); // show the TOTP unlock screen
}

async function sceneSearch(page) {
  console.log("  🔎 Search…");
  // Full reload to clean state
  await goTo(page, "/");
  const searchInput = page.locator("input[data-testid='input-search']");
  if (await searchInput.isVisible()) {
    await searchInput.click();
    await pause(400);
    await page.keyboard.type("microsoft", { delay: 80 });
    await pause(1500);
    await waitForImages(page);
    await pause(800);
    await searchInput.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await pause(300);
  }
}

async function sceneUpload(page) {
  console.log("  ⬆️  Upload…");
  await goTo(page, "/");
  const uploadBtn = page.locator("[data-testid='button-upload']");
  if (await uploadBtn.isVisible()) {
    await uploadBtn.click();
    await pause(1500);
    const closeBtn = page.locator("div.fixed.inset-0.z-50 button").first();
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
    } else {
      await page.keyboard.press("Escape");
    }
    await waitNoOverlay(page);
  }
}

async function sceneTrash(page) {
  console.log("  🗑  Trash…");
  await page.getByRole('link', { name: 'Trash' }).first().click();
  await pause(1500);
  await waitForImages(page);
  await pause(700);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_STATE_PATH,
    viewport: VIEWPORT,
    recordVideo: { dir: TEMP_DIR, size: VIEWPORT },
  });

  const page = await context.newPage();

  console.log("\nRecording demo…\n");

  await sceneLibrary(page);
  await sceneMemories(page);
  await sceneLightbox(page);
  await sceneAlbums(page);
  await scenePeople(page);
  await sceneFavorites(page);
  await sceneArchive(page);
  await sceneSearch(page);
  await sceneUpload(page);
  await sceneTrash(page);

  // End on the library
  await goTo(page, "/");
  await pause(500);

  await context.close();
  await browser.close();

  // Find .webm
  const files = fs.readdirSync(TEMP_DIR).filter(f => f.endsWith(".webm"));
  if (files.length === 0) { console.error("No .webm found"); process.exit(1); }
  const webm = path.join(TEMP_DIR, files[0]);

  // ── Convert to MP4 ──────────────────────────────────────────────────────────
  console.log("\nConverting to MP4…");
  execSync(
    `ffmpeg -y -i "${webm}" -vf "fps=30,scale=1280:-2" -c:v libx264 -crf 20 -preset fast -pix_fmt yuv420p "${OUTPUT_MP4}"`,
    { stdio: "inherit" }
  );
  console.log(`✓  docs/demo.mp4  (${(fs.statSync(OUTPUT_MP4).size / 1e6).toFixed(1)} MB)`);

  // ── Convert to optimised GIF (GitHub inline playback) ──────────────────────
  console.log("\nConverting to GIF…");
  const paletteFile = path.join(TEMP_DIR, "palette.png");
  // Step 1: generate optimal palette
  execSync(
    `ffmpeg -y -i "${webm}" -vf "fps=12,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" "${paletteFile}"`,
    { stdio: "inherit" }
  );
  // Step 2: apply palette
  execSync(
    `ffmpeg -y -i "${webm}" -i "${paletteFile}" -lavfi "fps=12,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5" -loop 0 "${OUTPUT_GIF}"`,
    { stdio: "inherit" }
  );
  console.log(`✓  docs/demo.gif  (${(fs.statSync(OUTPUT_GIF).size / 1e6).toFixed(1)} MB)`);

  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  console.log("\nDone!\n");
}

main().catch(err => { console.error(err); process.exit(1); });


