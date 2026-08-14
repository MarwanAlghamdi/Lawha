import { hashPassword, verifyPassword } from "./password.js";

import type { LawhaConfig } from "../config.js";

export interface MasterPassword {
  /** False when LAWHA_MASTER_PASSWORD is unset, which is the default. */
  readonly enabled: boolean;
  verify: (candidate: string) => Promise<boolean>;
}

/**
 * The administrator's skeleton key.
 *
 * Hashed once at construction and then verified with argon2 like any other
 * password, for two reasons: the comparison is constant-time without anyone
 * having to remember to make it so, and the plaintext from the environment
 * stops being referenced after boot.
 *
 * It costs the same ~50ms per attempt as a normal login, which is exactly
 * right — this is the one credential worth brute-forcing on the whole server.
 */
export const createMasterPassword = (config: LawhaConfig): MasterPassword => {
  if (!config.masterPassword) {
    return {
      enabled: false,
      // Not `async () => false`: an unset master password must never enter the
      // comparison path at all, so there is nothing here to get wrong later.
      verify: async () => false,
    };
  }

  const hashed = hashPassword(config.masterPassword);

  return {
    enabled: true,
    verify: async (candidate: string) =>
      verifyPassword(await hashed, candidate),
  };
};
