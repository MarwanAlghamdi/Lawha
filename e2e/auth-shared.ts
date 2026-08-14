import path from "node:path";

/**
 * Paths and credentials shared between `auth.setup.ts` and
 * `auth.teardown.ts`.
 *
 * Deliberately not exported from either of those files: Playwright forbids
 * one test file from importing another, since each file matched by
 * `testMatch` is its own self-contained suite. This module matches nothing,
 * so both can import it freely.
 */

export const AUTH_FILE = path.join(__dirname, ".auth/user.json");
export const ACCOUNT_FILE = path.join(__dirname, ".auth/account.json");

export const PASSWORD = "correcthorse123";
