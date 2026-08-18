import { defineConfig, devices } from "@playwright/test";

/**
 * Visual-regression suite for Lawha (roadmap #25).
 *
 * A dev server is already running at http://localhost:3001 and proxies
 * `/api` and `/socket.io` to the backend — this config deliberately has no
 * `webServer` block. Starting a second server here would either collide with
 * the running one or point tests at a server with no proxy, so `baseURL` is
 * the only wiring needed.
 *
 * `workers: 1` is intentional, not a leftover default. Every project reuses
 * the same server-side account (registration is rate-limited, so the suite
 * creates exactly one), and the dashboard screenshot depends on that account
 * having zero boards. If two projects' tests ran concurrently, one test's
 * "create a board" step (in the `/b/:boardId` spec) could land in between
 * another test's navigation to `/` and its screenshot, making the dashboard
 * baseline flake on board count. Running serially removes the race entirely.
 * The suite is small enough (6 viewport x theme projects x 6 specs) that this
 * costs a couple of minutes, not the run.
 */

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  desktop: { width: 1440, height: 900 },
} as const;

const THEMES = ["light", "dark"] as const;

const visualProjects = Object.entries(VIEWPORTS).flatMap(
  ([sizeName, viewport]) =>
    THEMES.map((theme) => ({
      name: `${sizeName}-${theme}`,
      testMatch: /visual\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport,
        theme,
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    })),
);

/**
 * Behavioural specs, run once rather than across the matrix.
 *
 * Separate from the visual projects for two reasons. They create boards, and
 * the dashboard baseline depends on the shared account having none — so they
 * are listed last and clean up after themselves. And they drive the pointer at
 * desktop coordinates, which fall outside a 390px phone viewport entirely.
 */
const behaviourProject = {
  name: "behaviour",
  testMatch: /persistence\.spec\.ts/,
  use: {
    ...devices["Desktop Chrome"],
    viewport: VIEWPORTS.desktop,
    storageState: "e2e/.auth/user.json",
  },
  dependencies: ["setup"],
};

/**
 * The ADR 0012 spec: boards open without a key, and the account panel.
 *
 * Its own project, with no `storageState` and no dependency on `setup`,
 * because every test registers the account it needs — several of them exist
 * precisely to compare two browser contexts, and a pre-baked session would
 * hand both of them the same one.
 *
 * Not in the default run: it creates boards, and every dashboard screenshot
 * in the visual suite assumes the shared account has none.
 */
const openBoardsProject = {
  name: "open-boards",
  testMatch: /openBoards\.spec\.ts/,
  // Registrations, board creations and full editor loads. The suite-wide 30s
  // is a screenshot budget; a timeout here would report the feature broken
  // because a canvas was slow.
  timeout: 180_000,
  use: {
    ...devices["Desktop Chrome"],
    viewport: VIEWPORTS.desktop,
  },
};

/**
 * Invite codes and canvas panning (ADR 0014, ADR 0013).
 *
 * Kept out of the default run for the same reason as the two above: it
 * registers accounts and creates boards, and every dashboard screenshot in the
 * visual suite assumes the shared account has none. Long budget because it
 * opens four browser contexts and loads a full editor twice.
 */
const inviteCodesProject = {
  name: "invite-codes",
  testMatch: /inviteCodes\.spec\.ts/,
  timeout: 180_000,
  use: {
    ...devices["Desktop Chrome"],
    viewport: VIEWPORTS.desktop,
  },
};

/**
 * Two real accounts against a live deployment, including the reporter's own.
 *
 * Serial by construction and given a long budget: eleven steps, several of
 * which sign in twice and load a full editor. Kept out of the default run for
 * the same reason as the others — it creates boards.
 */
const twoAccountsProject = {
  name: "two-accounts",
  testMatch: /twoAccounts\.spec\.ts/,
  timeout: 180_000,
  use: {
    ...devices["Desktop Chrome"],
    viewport: VIEWPORTS.desktop,
  },
};

/*
 * `escrowProject` and `e2e/escrow.spec.ts` stood here and are deleted.
 *
 * The spec pinned ADR 0010's key escrow end to end — a board made in one
 * browser opening in another that never held its key. ADR 0012 removed the
 * encryption and migration 013 dropped the tables, so most of its assertions
 * had become vacuous rather than wrong: `.lw-board-card--locked` counted 0
 * because the class no longer exists, and the "This board is locked here"
 * heading was hidden because nothing renders it. A test that passes because
 * its subject is gone is worse than no test, since it reads as coverage.
 *
 * The property it was actually protecting — a board opens on a browser that
 * has never seen it — is not lost. `openBoards.spec.ts` asserts it, against
 * the mechanism that guarantees it now.
 */

/**
 * Tables, matrices and tensor blocks (ADR 0023).
 *
 * Registers accounts and creates boards, so it is kept out of the default run
 * like the three above — and it must be pointed at a **sandbox** stack with its
 * own database, never at a real deployment. Long budget: it opens a full editor
 * for every test and drives real pointer input at desktop coordinates.
 */
const gridObjectsProject = {
  name: "grid-objects",
  testMatch: /gridObjects\.spec\.ts/,
  timeout: 180_000,
  use: {
    ...devices["Desktop Chrome"],
    viewport: VIEWPORTS.desktop,
  },
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  // See the workers note above: this suite depends on serial execution for
  // correctness, not just speed, because all projects share one account.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // The canvas element itself is always masked, but antialiasing and
      // subpixel font rendering still drift a handful of pixels run to run —
      // this tolerance absorbs that without hiding a real regression.
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
    },
  },
  use: {
    // Overridable because the dev server has to run over TLS for any testing
    // that is not on localhost: board keys are minted with
    // `window.crypto.subtle`, which browsers withhold outside a secure context.
    // Point this at the https origin when the server is started that way.
    baseURL: process.env.LAWHA_E2E_BASE_URL ?? "http://localhost:3001",
    // The LAN certificate is self-signed; a person clicks through the warning
    // once, and this is the headless equivalent.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      teardown: "cleanup",
    },
    {
      name: "cleanup",
      testMatch: /auth\.teardown\.ts/,
    },
    ...visualProjects,
    // Last: these create boards, and every dashboard screenshot above assumes
    // the shared account has none.
    behaviourProject,
    openBoardsProject,
    twoAccountsProject,
    inviteCodesProject,
    gridObjectsProject,
  ],
});
