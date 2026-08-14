import { expect, test } from "./fixtures";

import type { Locator, Page } from "@playwright/test";

/**
 * Visual-regression suite (roadmap #25) covering the six routes called out in
 * the task: `/`, both signed in and signed out, `/signin`, `/signup`,
 * `/account`, and `/b/:boardId`.
 *
 * Every project in playwright.config.ts runs this same file once per
 * viewport x theme combination. Auth comes from `e2e/.auth/user.json`,
 * written once by `auth.setup.ts` for the whole run — this file never
 * registers its own account. The `username` fixture (see fixtures.ts) reads
 * that same setup step's `e2e/.auth/account.json` lazily, at test-run time.
 */

/**
 * `STORAGE_KEYS.LOCAL_STORAGE_THEME` from excalidraw-app/app_constants.ts.
 * Set via an init script (before the app's first script runs) rather than
 * `page.evaluate` after navigation, because the app reads it once at boot —
 * setting it post-navigation would race the app's own read.
 */
const THEME_STORAGE_KEY = "excalidraw-theme";

/**
 * Everything that differs between runs and would otherwise make every
 * screenshot a guaranteed diff:
 *  - `canvas`              the dot grid and antialiasing render slightly
 *                          differently run to run, on every canvas layer
 *                          (static/interactive/new-element).
 *  - board-card meta        "private · 3 days ago" on the dashboard.
 *  - board-card live chip   "N editing" presence count.
 *  - board-card thumbnail   the board's decrypted scene, drawn small.
 *  - dashboard account pill  the generated username, its avatar initials,
 *                            and its aria-label, in `LawhaHomeBar`.
 *  - dashboard live count    "N on boards", summed presence.
 *  - account identity        the generated username + its avatar initials,
 *                            on `/account`.
 *  - canvas top-bar account  same username, shown again in the canvas chrome
 *                            (`LawhaAccountButton`, a different component
 *                            from the dashboard's account pill above).
 *  - collaborator list       who else is on the board (empty solo, but its
 *                            content is presence data).
 *  - save status             "Saved · 3s ago" in the canvas top bar.
 *  - board title             defaults through Excalidraw's own scene-name
 *                            logic, which is not guaranteed date-free.
 */
const NONDETERMINISTIC_SELECTORS = [
  "canvas",
  ".lw-board-card__meta",
  ".lw-board-card__live",
  ".lw-board-card__mini",
  ".lw-home__account",
  ".lw-home__live",
  ".lw-account-panel__identity",
  ".lw-account__avatar",
  ".lw-account__name",
  ".UserList__wrapper",
  ".lw-save-status",
  ".lw-presence",
  ".lw-topbar__title",
];

const maskLocators = (page: Page): Locator[] =>
  NONDETERMINISTIC_SELECTORS.map((selector) => page.locator(selector));

/**
 * An autofocused empty input (the username field on /signin and /signup)
 * leaves a blinking text caret whose phase at capture time is not
 * deterministic. Blurring focus before every screenshot removes it.
 */
const settle = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
};

test.beforeEach(async ({ page, theme }) => {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [THEME_STORAGE_KEY, theme] as const,
  );
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign in screen", async ({ page }) => {
    await page.goto("/signin");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot("signin.png", {
      mask: maskLocators(page),
    });
  });

  test("sign up screen", async ({ page }) => {
    await page.goto("/signup");
    await expect(
      page.getByRole("heading", { name: "Create an account" }),
    ).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot("signup.png", {
      mask: maskLocators(page),
    });
  });

  /*
   * "canvas when signed out" stood here, with six baselines, and both are
   * deleted.
   *
   * It screenshotted `/` for a visitor with no account, back when that was a
   * scratch canvas. `LandingRoute` now sends them to `/signin` instead, and
   * its own doc comment argues why: a canvas handed to everyone who lands on
   * the address is where work gets started somewhere it cannot be saved.
   *
   * So the test had been asserting a removed behaviour — and failing on a
   * missing `canvas.excalidraw__canvas.static` rather than on a pixel diff,
   * which is the failure mode that says "this test is about something else
   * now". What `/` does for a signed-out visitor — go to the sign-in
   * screen rather than hand out a canvas — has no automated cover any
   * more, and what that screen looks like is `signin.png` two tests up.
   * seventh baseline of the sign-in screen is what would be gained by
   * keeping it.
   */
});

test.describe("signed in", () => {
  // Order matters here: this runs before "board canvas" below, so the
  // dashboard is always screenshotted with zero boards — a state that stays
  // true for every project because "board canvas" deletes the board it
  // creates before it finishes. See playwright.config.ts for why the suite
  // also runs with workers: 1, which is what makes that guarantee hold across
  // projects too, not just within this file.
  test("dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "New board", exact: true }),
    ).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot("dashboard.png", {
      mask: maskLocators(page),
    });
  });

  test("account settings", async ({ page, username }) => {
    await page.goto("/account");
    await expect(
      page.getByRole("heading", { level: 2, name: username }),
    ).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot("account.png", {
      mask: maskLocators(page),
    });
  });

  test("board canvas", async ({ page }) => {
    await page.goto("/");
    const newBoardButton = page.getByRole("button", {
      name: "New board",
      exact: true,
    });
    await expect(newBoardButton).toBeVisible();

    // POSTs to /api/boards and remembers the board's key in this context's
    // IndexedDB key store before navigating — clicking through the dashboard
    // (rather than deep-linking to a fabricated /b/<id>) is what makes the
    // key store populated, so the canvas opens instead of showing "locked".
    await newBoardButton.click();
    await page.waitForURL(/\/b\//);
    await expect(
      page.locator("canvas.excalidraw__canvas.static"),
    ).toBeVisible();
    await settle(page);

    try {
      await expect(page).toHaveScreenshot("board-canvas.png", {
        mask: maskLocators(page),
      });
    } finally {
      // Cleanup, not correctness: the "dashboard" test above already ran for
      // this project, so a leftover board here cannot affect this run. It
      // would affect the *next* run's account, though — except each run
      // registers a fresh throwaway account, so even that is moot. This just
      // keeps the server from accumulating empty boards across runs.
      const boardId = new URL(page.url()).pathname.split("/b/")[1];
      if (boardId) {
        await page.evaluate(async (id) => {
          await fetch(`/api/boards/${id}`, { method: "DELETE" });
        }, boardId);
      }
    }
  });
});
