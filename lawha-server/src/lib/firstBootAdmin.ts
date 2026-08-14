import crypto from "node:crypto";

import { hashPassword } from "./password.js";
import { passwordSchema } from "./validation.js";

import type { LawhaContext } from "../context.js";

/**
 * The name used when nothing is configured.
 *
 * `admin` is in RESERVED_USERNAMES, so nobody can register it themselves —
 * which is exactly what makes it safe to hand to the seeded account. A name a
 * stranger could have claimed first would turn "sign in as admin" into an
 * invitation to squat on it before the operator's first boot.
 */
const DEFAULT_ADMIN_USERNAME = "admin";

/**
 * 24 characters from a 31-symbol alphabet: ~119 bits, which is far past
 * anything argon2id at ~50ms a guess needs.
 *
 * `l`, `1`, `I`, `0` and `O` are absent because this password's whole life is
 * being read off a terminal and typed into a browser, quite possibly over the
 * phone. A character nobody can transcribe is a support call, and the entropy
 * cost of dropping five symbols is a fraction of one character.
 */
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const PASSWORD_LENGTH = 24;

/**
 * Exported for the administrator's password reset in `http/routes/admin.ts`.
 *
 * One generator, not two, and the reason is the alphabet comment above rather
 * than tidiness: both call sites exist to produce a password that gets read off
 * a screen and dictated to somebody, and a second implementation is how one of
 * them ends up with an `l` in it. It lives here because this is where the rule
 * was worked out and where it is documented; the module is `firstBootAdmin`
 * only by accident of which feature needed it first.
 */
export const generatePassword = (): string => {
  let password = "";
  for (let index = 0; index < PASSWORD_LENGTH; index += 1) {
    // crypto.randomInt, not randomBytes() % length: the alphabet is 31 symbols
    // and 256 is not a multiple of it, so modulo would make the first few
    // letters measurably more likely. randomInt rejects and re-draws.
    password += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
};

/**
 * A box that fits whatever is inside it.
 *
 * Written by hand rather than padded to a fixed width because the username is
 * configurable and a banner whose right edge is ragged reads as a bug in the
 * thing that printed it — which is not the impression to give on the one line
 * of output the operator has to trust.
 */
const banner = (lines: readonly string[]): string => {
  const width = Math.max(...lines.map((line) => line.length)) + 2;
  const rule = "─".repeat(width);

  return [
    `┌${rule}┐`,
    ...lines.map((line) => `│ ${line.padEnd(width - 2)} │`),
    `└${rule}┘`,
    "",
  ].join("\n");
};

export interface SeedFirstAdminResult {
  /** False when accounts already existed, which is the usual case. */
  created: boolean;
  username: string | null;
  /** True when the password came from LAWHA_ADMIN_PASSWORD. */
  fromConfig: boolean;
}

/**
 * Creates an administrator when — and only when — the server has no accounts.
 *
 * Self-hosting this used to mean reading the source to work out that the first
 * person to register becomes the admin. That is fine when the operator is also
 * the first user and terrible otherwise: on a server with open registration
 * closed, an empty database is a locked door with nobody on either side of it.
 *
 * Three rules this deliberately keeps:
 *
 *  - **Idempotent, and silent when it does nothing.** Any existing account
 *    means the operator has already been through this once. A banner on every
 *    restart would train them to scroll past the one that matters.
 *  - **Only a password we just generated is ever printed.** Echoing
 *    `LAWHA_ADMIN_PASSWORD` back would copy a secret out of the environment
 *    and into a log file, a systemd journal and `docker compose logs`, none of
 *    which the operator asked for. A hash is never printed either — it is not
 *    useful to a human and it is useful to an attacker.
 *  - **A refused configured password does not leave the server without an
 *    admin.** It says so and generates one instead, because failing closed
 *    here means nobody can ever sign in.
 */
export const seedFirstAdmin = async (
  ctx: LawhaContext,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<SeedFirstAdminResult> => {
  if (ctx.users.countAccounts() > 0) {
    return { created: false, username: null, fromConfig: false };
  }

  const username = ctx.config.adminUsername ?? DEFAULT_ADMIN_USERNAME;
  const configured = ctx.config.adminPassword;

  let password: string | null = null;

  if (configured !== null) {
    const checked = passwordSchema.safeParse(configured);
    if (checked.success) {
      password = configured;
    } else {
      // Loud, and on the operator's own terminal, which is the only place this
      // can be fixed. Silently accepting a 4-character admin password would be
      // worse than either alternative.
      write(
        "lawha: LAWHA_ADMIN_PASSWORD was refused — " +
          `${checked.error.errors[0]?.message ?? "invalid password"}\n` +
          "       Seeding the administrator with a generated password instead.\n",
      );
    }
  }

  // Captured before the assignment below, because "did we make this up" is
  // the single fact that decides whether it may be printed.
  const generated = password === null;
  if (password === null) {
    password = generatePassword();
  }

  const user = ctx.users.create({
    username,
    passwordHash: await hashPassword(password),
    isAdmin: true,
  });

  if (!generated) {
    // Configured: say that an account was made and nothing more. The operator
    // already holds this password; the log does not need a copy.
    write(
      `lawha: first boot — created administrator ${user.username_display} ` +
        "with LAWHA_ADMIN_PASSWORD.\n",
    );
    return { created: true, username: user.username_display, fromConfig: true };
  }

  write(
    banner([
      "LAWHA — first boot",
      "",
      "No accounts existed, so an administrator was created.",
      "",
      `  username:  ${user.username_display}`,
      `  password:  ${password}`,
      "",
      "This password is shown ONCE and is never shown again — only its",
      "argon2 hash is stored, and the server cannot recover it. Copy it",
      "now, sign in, and change it.",
      "",
      "Set LAWHA_ADMIN_USERNAME and LAWHA_ADMIN_PASSWORD before the first",
      "boot to choose these yourself. See lawha.env.example.",
    ]),
  );

  return { created: true, username: user.username_display, fromConfig: false };
};
