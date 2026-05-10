import { test, expect } from "@playwright/test";

test.describe("Login page", () => {
  test.beforeEach(async ({ page }) => {
    // Return 401 so AuthGuard doesn't redirect away from /login
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({ status: 401, body: JSON.stringify({ error: "Unauthorized" }) })
    );
    await page.goto("/login");
  });

  test("shows app name and tagline", async ({ page }) => {
    await expect(page.getByText("APhoto")).toBeVisible();
    await expect(page.getByText("Your memories, beautifully organized")).toBeVisible();
  });

  test("shows Microsoft sign-in button", async ({ page }) => {
    const btn = page.getByTestId("button-microsoft-login");
    await expect(btn).toBeVisible();
    await expect(btn).toContainText("Continue with Microsoft");
  });

  test("shows rotating inspiration quote", async ({ page }) => {
    // The quote container wraps any of the known quotes
    const quote = page.getByText(
      /Life is a collection|One day or day one|Happiness is not|The best thing to hold|In every smile|Photography is the story|A photograph is a pause/i
    );
    await expect(quote.first()).toBeVisible({ timeout: 10_000 });
  });

  test("Microsoft login button click shows device-code flow", async ({ page }) => {
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user_code: "ABC123XY",
          verification_uri: "https://microsoft.com/devicelogin",
          device_code: "fake-device-code",
          expires_in: 900,
          interval: 5,
        }),
      })
    );
    // Also intercept the device-code-status poll so it doesn't hit the real API
    await page.route("**/api/auth/device-code-status", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "pending" }) })
    );

    await page.getByTestId("button-microsoft-login").click();
    // The device-code UI shows "One more step" heading when the code is received
    await expect(page.getByText("One more step")).toBeVisible({ timeout: 10_000 });
  });
});
