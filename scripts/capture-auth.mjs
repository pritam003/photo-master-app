/**
 * capture-auth.mjs
 *
 * Opens a real browser window so you can log in.
 * Once you're on the main library page, press Enter in this terminal.
 * The auth state (cookies) is saved to auth-state.json for use by take-screenshots.mjs.
 *
 * Usage:
 *   node scripts/capture-auth.mjs
 */

import { chromium } from "playwright";
import { createInterface } from "readline";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", "auth-state.json");
const BASE_URL = "https://green-river-0bfcd7a0f.1.azurestaticapps.net";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const waitForEnter = (msg) => new Promise((r) => rl.question(msg, r));

const browser = await chromium.launch({ headless: false, slowMo: 50 });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

await page.goto(`${BASE_URL}/login`);

console.log("\n┌─────────────────────────────────────────────┐");
console.log("│  Browser is open. Log in to APhoto.         │");
console.log("│  Once you reach the library page,           │");
console.log("│  come back here and press Enter.            │");
console.log("└─────────────────────────────────────────────┘\n");

await waitForEnter("Press Enter after you've logged in → ");

await context.storageState({ path: STATE_PATH });
console.log(`\nAuth state saved to: ${STATE_PATH}`);
console.log("Now run:\n  AUTH_STATE_PATH=auth-state.json node scripts/take-screenshots.mjs\n");

await browser.close();
rl.close();
