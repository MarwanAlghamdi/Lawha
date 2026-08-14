import fs from "node:fs";
import path from "node:path";

import { test as setup } from "@playwright/test";

import { ACCOUNT_FILE, AUTH_FILE, PASSWORD } from "./auth-shared";

/**
 * Registers the one account this whole suite shares.
 *
 * Registration is rate-limited to 40/hour per IP, and every one of the six
 * viewport x theme projects reuses this same account rather than creating
 * its own — so this runs exactly once per suite invocation, as a Playwright
 * "setup" project that every visual project depends on.
 *
 * The password and username picked here are also written to
 * `e2e/.auth/account.json` so specs that need to display or match the
 * username (to mask it) or delete the account (`auth.teardown.ts`) don't
 * have to guess it back out of a cookie.
 */

setup("register the shared visual-regression account", async ({ page }) => {
  const username = `pw-visual-${Date.now()}`;

  await page.goto("/signin");
  const registered = await page.evaluate(
    async ([u, p]) => {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      return { ok: response.ok, status: response.status };
    },
    [username, PASSWORD] as const,
  );

  if (!registered.ok) {
    throw new Error(
      `lawha e2e setup: registration failed (${registered.status}). ` +
        "If this is a 429, the per-IP rate limit (40/hour) was likely hit " +
        "by repeated suite runs — wait before retrying.",
    );
  }

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(
    ACCOUNT_FILE,
    JSON.stringify({ username, password: PASSWORD }),
  );

  // The register call above set an httpOnly session cookie in this page's
  // context; persisting it here is what lets every dependent project start
  // already signed in instead of re-registering.
  await page.context().storageState({ path: AUTH_FILE });
});
