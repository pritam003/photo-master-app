import { test, expect, Page } from "@playwright/test";

// Mock a logged-in user by intercepting /api/auth/me
async function mockAuthenticated(page: Page) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "test-user-1",
        email: "test@example.com",
        name: "Test User",
        avatarUrl: null,
        provider: "microsoft",
      }),
    })
  );

  // Mock photo stats (shape must match PhotoStats schema)
  await page.route("**/api/photos/stats", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ total: 42, favorites: 5, trashed: 0, albums: 3, totalSize: 1048576 }),
    })
  );

  // Mock photos list
  await page.route("**/api/photos/months**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        months: [{ yearMonth: "2024-01", count: 5, covers: [] }],
      }),
    })
  );

  // Mock on-this-day
  await page.route("**/api/photos/on-this-day", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ days: [], todayDow: 0 }) })
  );
}

test.describe("App navigation (authenticated)", () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticated(page);
  });

  test("redirects from /login to library when already authenticated", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/(library)?$/, { timeout: 10_000 });
  });

  test("library page renders search bar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByPlaceholder(/search/i)).toBeVisible({ timeout: 10_000 });
  });

  test("sidebar shows navigation links", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Photos/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Favorites/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Albums/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Trash/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("navigates to favorites page", async ({ page }) => {
    // Mock favorites endpoint
    await page.route("**/api/photos**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ photos: [], total: 0 }) })
    );

    await page.goto("/");
    await page.getByText(/Favorites/i).first().click();
    await expect(page).toHaveURL(/\/favorites/, { timeout: 10_000 });
  });

  test("navigates to albums page", async ({ page }) => {
    await page.route("**/api/albums**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) })
    );

    await page.goto("/");
    await page.getByText(/Albums/i).first().click();
    await expect(page).toHaveURL(/\/albums/, { timeout: 10_000 });
  });
});

test.describe("Unauthenticated routing", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({ status: 401, body: JSON.stringify({ error: "Unauthorized" }) })
    );
  });

  test("/ redirects to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test("/library redirects to /login", async ({ page }) => {
    await page.goto("/library");
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test("/albums redirects to /login", async ({ page }) => {
    await page.goto("/albums");
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
