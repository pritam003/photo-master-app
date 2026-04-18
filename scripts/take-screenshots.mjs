/**
 * take-screenshots.mjs
 *
 * Captures fresh screenshots of the live APhoto app for the README.
 * Usage:
 *   node scripts/take-screenshots.mjs
 *
 * Screenshots are saved to docs/screenshots/.
 * Requires: npx playwright install chromium  (first time)
 */

import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "docs", "screenshots");

const BASE_URL = "https://green-river-0bfcd7a0f.1.azurestaticapps.net";

const VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** Wait until all <img> elements currently in the viewport have finished loading. */
async function waitForImages(page) {
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll("img"));
    // Only check images that have a src (skip empty placeholders)
    const loaded = imgs.filter(img => img.src && img.src !== window.location.href);
    if (loaded.length === 0) return true;
    return loaded.every(img => img.complete && img.naturalWidth > 0);
  }, { timeout: 20000 }).catch(() => {/* some images may never load — proceed anyway */});
}

async function shot(page, name) {
  // Wait for images to finish loading before screenshotting
  await waitForImages(page);
  const dest = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: dest, fullPage: false });
  console.log(`  ✓ ${name}.png`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  // ── 1. Login page (desktop) ──────────────────────────────────────────────
  console.log("\nCapturing public pages…");
  {
    const page = await browser.newPage();
    await page.setViewportSize(VIEWPORT);
    await page.goto(`${BASE_URL}/login`, { waitUntil: "load" });
    // Wait for the animated bubbles + card to render
    await page.waitForTimeout(2500);
    await shot(page, "login");
    await page.close();
  }

  // ── 2. Login page (mobile) ───────────────────────────────────────────────
  {
    const page = await browser.newPage();
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`${BASE_URL}/login`, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    await shot(page, "login-mobile");
    await page.close();
  }

  // ── 3. Authenticated pages — requires saved auth state ───────────────────
  // If AUTH_STATE_PATH env var points to a Playwright storageState JSON,
  // we authenticate and capture the full app.
  const authStatePath = process.env.AUTH_STATE_PATH;
  if (authStatePath && fs.existsSync(authStatePath)) {
    console.log("\nCapturing authenticated pages…");
    const context = await browser.newContext({
      storageState: authStatePath,
      viewport: VIEWPORT,
    });
    const page = await context.newPage();

    // Library
    await page.goto(`${BASE_URL}/`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(4000); // allow TanStack Query to fetch + images to paint
    await shot(page, "library");

    // Favorites
    await page.goto(`${BASE_URL}/favorites`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(3000);
    await shot(page, "favorites");

    // Albums list
    await page.goto(`${BASE_URL}/albums`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(3000);
    await shot(page, "albums");

    // People
    await page.goto(`${BASE_URL}/people`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(3000);
    await shot(page, "people");

    // Trash
    await page.goto(`${BASE_URL}/trash`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(3000);
    await shot(page, "trash");

    // Archive (will show TOTP prompt if not unlocked — that's fine)
    await page.goto(`${BASE_URL}/archive`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(3000);
    await shot(page, "archive");

    // Upload modal — click Upload Photos button
    await page.goto(`${BASE_URL}/`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(4000);
    const uploadBtn = page.locator("button", { hasText: /upload/i }).first();
    if (await uploadBtn.isVisible()) {
      await uploadBtn.click();
      await page.waitForTimeout(800);
      await shot(page, "upload-modal");
    }

    // Multi-select — select a few photos
    await page.goto(`${BASE_URL}/`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(4000);
    // Long-press / hover to trigger select mode on first photo
    const firstPhoto = page.locator("[data-photo-id]").first();
    if (await firstPhoto.isVisible()) {
      await firstPhoto.hover();
      const checkbox = firstPhoto.locator("input[type=checkbox]");
      if (await checkbox.isVisible()) {
        await checkbox.click();
        await page.waitForTimeout(600);
        await shot(page, "multiselect");
      }
    }

    // Mobile library
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`${BASE_URL}/`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(4000);
    await shot(page, "library-mobile");

    await context.close();
  } else {
    console.log("\nSkipping authenticated pages.");
    console.log(
      "To capture them, log in once via the browser and save the auth state:\n"
    );
    console.log(
      "  npx playwright codegen --save-storage=auth.json " + BASE_URL
    );
    console.log(
      "Then re-run:\n  AUTH_STATE_PATH=auth.json node scripts/take-screenshots.mjs\n"
    );
  }

  await browser.close();
  console.log("\nDone! Screenshots saved to docs/screenshots/\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
