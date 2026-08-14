import { Algorithm, hash, verify } from "@node-rs/argon2";

/**
 * OWASP 2024 baseline for argon2id. ~40ms per hash on typical hardware, which
 * is also what bounds the login rate-limit budget.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (password: string): Promise<string> =>
  hash(password, ARGON2_OPTIONS);

/**
 * Written to `password_hash` when an administrator locks an account pending
 * a password reset (design spec §4), instead of adding a second mechanism or
 * a `password_reset_required` column. Not a valid argon2 PHC string — the
 * same trick `anonymousUser.ts` uses for its unreachable stand-in account —
 * so `verifyPassword` below always returns `false` for it. That is verified,
 * not assumed: a malformed hash is caught and read as "wrong password"
 * rather than thrown, which is what makes reusing this sentinel safe here —
 * the alternative was a locked account turning sign-in into a 500.
 */
export const LOCKED_PASSWORD_HASH = "!locked-pending-reset";

export const verifyPassword = async (
  passwordHash: string,
  password: string,
): Promise<boolean> => {
  try {
    return await verify(passwordHash, password, ARGON2_OPTIONS);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash.
    return false;
  }
};

/**
 * A real hash of a throwaway password, verified against when the supplied
 * username does not exist. Without this, response timing enumerates accounts.
 */
let dummyHash: Promise<string> | null = null;

export const consumeTimingBudget = async (password: string): Promise<void> => {
  dummyHash ??= hashPassword("lawha-timing-equaliser");
  await verifyPassword(await dummyHash, password);
};
