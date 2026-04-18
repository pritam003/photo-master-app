/**
 * record-demo.mjs
 *
 * Records a walkthrough video of the APhoto UI using Playwright's built-in
 * video recording, then converts the .webm to .mp4 via ffmpeg.
 *
 * Usage:
 *   AUTH_STATE_PATH=auth-state.json node scripts/record-demo.mjs
 *
 * Output: docs/demo.mp4
 */

import { chromium } from "playwright";
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR   = path.join(__dirname, "..", "docs");
const TEMP_DIR   = path.join(DOCS_DIR, ".video-tmp");
const OUTPUT_MP4 = path.join(DOCS_DIR, "demo.mp4");

const BASE_URL        = "https://green-river-0bfcd7a0f.1.azurestaticapps.net";
const VIEWPORT        = { width: 1440, height: 900 };
const AUTH_STATE_PATH = process.env.AUTH_STATE_PATH;

if (!AUTH_STATE_PATH || !fs.existsSync(AUTH_STATE_PATH)) {
  console.error("AUTH_STATE_PATH not set or file not found.");
  console.error("Run: AUTH_STATE_PATH=auth-state.json node scripts/record-demo.mjs");
  process.exit(1);
}

fs.mkdirSync(TEMP_DIR, { recursive: true });

/** Smooth scroll down by `px` pixels over ~duration ms */
async function smoothScroll(page, px, duration = 1800) {
  const steps = 30;
  const dy = px / steps;
  const delay = duration / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(delay);
  }
}

/** Dismiss any open modal/overlay by pressing Escape and waiting for it to clear */
async function dismissModals(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  // Wait until no fixed overlay is blocking the UI
  await page.waitForFunction(() => {
    const overlay = document.querySelector(".fixed.inset-0");
    return !overlay || overlay.style.display === "none";
  }, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
}

/** Wait until visible images are loaded */
async function waitForImages(page) {
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll("img"));
    const withSrc = imgs.filter(img => img.src && img.src !== window.location.href);
    if (withSrc.length === 0) return true;
    return withSrc.every(img => img.complete && img.naturalWidth > 0);
  }, { timeout: 20000 }).catch(() => {});
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    storageState: AUTH_STATE_PATH,
    viewport: VIEWPORT,
    recordVideo: {
      dir: TEMP_DIR,
      size: VIEWPORT,
    },
  });

  const page = await context.newPage();

  // ── 1. Library ─────────────────────────────────────────────────────────────
  console.log("▶ Library…");
  await page.goto(`${BASE_URL}/`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3000);
  await waitForImages(page);
  await page.waitForTimeout(1500); // let Memories reel settle

  // Scroll down to show the photo grid
  await smoothScroll(page, 600, 2000);
  await page.waitForTimeout(1000);

  // Scroll back up
  await smoothScroll(page, -600, 1200);
  await page.waitForTimeout(800);

  // ── 2. Scroll through the library ──────────────────────────────────────────
  console.log("▶ Scrolling library…");
  await smoothScroll(page, 800, 2500);
  await page.waitForTimeout(1200);
  await smoothScroll(page, -800, 1800);
  await page.waitForTimeout(800);

  // ── 3. Albums ──────────────────────────────────────────────────────────────
  console.log("▶ Albums…");
  await page.click("text=Albums");
  await page.waitForTimeout(2500);
  await waitForImages(page);
  await page.waitForTimeout(1000);

  // ── 4. People ──────────────────────────────────────────────────────────────
  console.log("▶ People…");
  await page.click("text=People");
  await page.waitForTimeout(2500);
  await waitForImages(page);
  await page.waitForTimeout(1000);

  // ── 5. Favorites ───────────────────────────────────────────────────────────
  console.log("▶ Favorites…");
  await page.click("text=Favorites");
  await page.waitForTimeout(2500);
  await waitForImages(page);
  await page.waitForTimeout(1000);

  // ── 6. Upload modal — full page reload to clear any SPA state ─────────────
  console.log("▶ Upload modal…");
  await page.goto(`${BASE_URL}/`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(3000);
  await waitForImages(page);
  const uploadBtn = page.locator("[data-testid='button-upload']");
  if (await uploadBtn.isVisible()) {
    await uploadBtn.click();
    await page.waitForTimeout(2500);
    // Close via the X button in the modal header
    await page.locator("div.fixed.inset-0 button").first().click();
    await page.waitForTimeout(1000);
    // Wait until the overlay is gone
    await page.waitForFunction(
      () => !document.querySelector("div.fixed.inset-0.z-50"),
      { timeout: 8000 }
    ).catch(() => {});
    await page.waitForTimeout(500);
  }

  // ── 7. Search ──────────────────────────────────────────────────────────────
  console.log("▶ Search…");
  const searchInput = page.locator("input[placeholder*='earch']");
  if (await searchInput.isVisible()) {
    await searchInput.click();
    await page.waitForTimeout(400);
    await page.keyboard.type("2025", { delay: 120 });
    await page.waitForTimeout(2500);
    await waitForImages(page);
    await page.waitForTimeout(800);
    // Clear search
    await searchInput.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(800);
  }

  // ── 8. Trash ───────────────────────────────────────────────────────────────
  console.log("▶ Trash…");
  await page.click("text=Trash");
  await page.waitForTimeout(2000);
  await page.waitForTimeout(800);

  // ── 9. Back to library — end ───────────────────────────────────────────────
  await page.click("text=Photos");
  await page.waitForTimeout(1500);

  // Stop recording
  await context.close();
  await browser.close();

  // Find the recorded .webm file
  const files = fs.readdirSync(TEMP_DIR).filter(f => f.endsWith(".webm"));
  if (files.length === 0) {
    console.error("No .webm file found in", TEMP_DIR);
    process.exit(1);
  }
  const webm = path.join(TEMP_DIR, files[0]);
  console.log(`\nConverting ${files[0]} → demo.mp4…`);

  execSync(
    `ffmpeg -y -i "${webm}" -vf "fps=30,scale=1440:-2" -c:v libx264 -crf 22 -preset fast -pix_fmt yuv420p "${OUTPUT_MP4}"`,
    { stdio: "inherit" }
  );

  // Clean up temp
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  console.log(`\n✓ Saved: docs/demo.mp4`);
}

main().catch(err => { console.error(err); process.exit(1); });
