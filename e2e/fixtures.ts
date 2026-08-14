import fs from "node:fs";

import { test as base } from "@playwright/test";

import { ACCOUNT_FILE } from "./auth-shared";

/**
 * The theme half of the viewport x theme matrix.
 *
 * Declared as a Playwright test option (rather than a plain constant) so each
 * `playwright.config.ts` project can set it via `use: { theme: "dark" }`
 * alongside the viewport, and specs can read it back through the `theme`
 * fixture instead of re-deriving it from the project name.
 */
export type ThemeOptions = {
  theme: "light" | "dark";
};

type AccountFixtures = {
  /** The username `auth.setup.ts` registered, for masking and readiness checks. */
  username: string;
};

export const test = base.extend<ThemeOptions & AccountFixtures>({
  theme: ["light", { option: true }],
  // A fixture, not a module-level constant: Playwright parses every spec file
  // during test *collection*, before the "setup" project has run, so reading
  // e2e/.auth/account.json at import time fails with ENOENT. Fixtures resolve
  // lazily at test *execution* time, by which point setup has already run.
  // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature
  username: async ({}, use) => {
    const { username } = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf-8")) as {
      username: string;
    };
    await use(username);
  },
});

export { expect } from "@playwright/test";
