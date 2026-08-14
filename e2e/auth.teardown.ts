import fs from "node:fs";

import { test as teardown } from "@playwright/test";

import { ACCOUNT_FILE, AUTH_FILE } from "./auth-shared";

/**
 * Deletes the account `auth.setup.ts` created, so repeated suite runs don't
 * leave throwaway `pw-visual-*` accounts (and their boards) piling up in the
 * server's user store. Runs once, after every visual project has finished —
 * wired up via the `setup` project's `teardown: "cleanup"` in
 * playwright.config.ts, which Playwright guarantees runs last.
 *
 * Best-effort: a failure here means one leftover test account, not a broken
 * suite, so it logs rather than throws.
 */
teardown("delete the shared visual-regression account", async ({ page }) => {
  if (!fs.existsSync(ACCOUNT_FILE) || !fs.existsSync(AUTH_FILE)) {
    return;
  }

  const { password } = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf-8")) as {
    username: string;
    password: string;
  };

  await page
    .context()
    .addCookies(JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8")).cookies);
  await page.goto("/");

  const result = await page.evaluate(async (pw) => {
    const response = await fetch("/api/auth/me", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    return response.ok;
  }, password);

  if (!result) {
    console.warn(
      "lawha e2e teardown: could not delete the shared test account " +
        "(non-fatal — it is a disposable pw-visual-* account).",
    );
  }

  fs.rmSync(ACCOUNT_FILE, { force: true });
  fs.rmSync(AUTH_FILE, { force: true });
});
