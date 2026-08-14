import { generatePasswordResetCode, hashResetCode } from "../../lib/tokens.js";

import type { LawhaDatabase } from "../index.js";

/**
 * One-time password reset codes. See migration 017 and
 * docs/adr/0021-admin-password-reset-codes.md.
 *
 * A code is minted by an administrator and redeemed by the account holder
 * themselves — the whole point being that the administrator never learns the
 * resulting password. It is the entire credential on its redemption route
 * (spec §5): no session, no username, no second factor.
 *
 * Stored hashed, mirroring `SessionsRepository`/`sessions.token_hash` exactly
 * rather than inventing a second shape for an equivalent-entropy credential:
 * `create` generates the code, hashes it for storage, and hands the plaintext
 * back once in its return value — the only place it exists outside the
 * caller's immediate use of it. Every other method takes the plaintext a
 * caller presents (from a URL, typically) and hashes it before it touches a
 * query, so `code_hash` is the only thing that ever reaches SQL.
 */

/** One hour (spec §5): long enough to hand over by chat or in person, short
 * enough that an intercepted code is usually already dead. */
export const RESET_CODE_TTL_MS = 60 * 60_000;

export interface ResetCodeRow {
  code_hash: string;
  user_id: string;
  /** NULL for a master-password session, which has no account behind it. */
  created_by: string | null;
  created_at: number;
  expires_at: number;
  /** 0/1: whether minting this code also locked the account. See migration 017. */
  locked: number;
  redeemed_at: number | null;
  revoked_at: number | null;
}

export type ResetCodeStatus = "live" | "expired" | "revoked" | "redeemed";

/**
 * Why a code will not work, or `"live"` if it will.
 *
 * `redeemed` is checked before `expired`, deliberately: redemption stamps
 * `redeemed_at` and nothing else in this row, so a code redeemed 61 minutes
 * ago is BOTH redeemed and past `expires_at`. A person refreshing the page
 * they just redeemed on must not be told their code expired — the same
 * reasoning as `invites.ts:286-297` for a code that has already granted
 * membership.
 */
export const status = (
  row: ResetCodeRow,
  now = Date.now(),
): ResetCodeStatus => {
  if (row.redeemed_at !== null) {
    return "redeemed";
  }
  if (row.revoked_at !== null) {
    return "revoked";
  }
  if (row.expires_at <= now) {
    return "expired";
  }
  return "live";
};

export interface MintedResetCode {
  /**
   * The raw code. This field is the ONLY place it exists once `create`
   * returns — not in the row just written, not logged, not in an audit
   * entry. The caller hands it to its one recipient (a redirect, a page
   * render) and then lets it go out of scope.
   */
  code: string;
  /** The expiry `create` actually stored, so a caller never has to recompute
   * `now + RESET_CODE_TTL_MS` itself and risk it drifting from this row by a
   * clock tick. Mirrors `CreatedSession.expiresAt` (sessions.ts). */
  expiresAt: number;
}

export class PasswordResetCodesRepository {
  constructor(private readonly db: LawhaDatabase) {}

  /**
   * Mints a code and stores only its hash, mirroring
   * `SessionsRepository.create` generating `token` and storing
   * `hashSessionToken(token)`. The code itself is generated HERE rather than
   * accepted as a parameter, so there is no call site anywhere that has to be
   * trusted not to log or persist a plaintext value someone handed in.
   *
   * Expiry is likewise not a caller parameter, for the same reason:
   * `SessionsRepository.create` computes its own expiry from `this.ttlMs`
   * rather than taking one in. Spec §5 fixes a reset code's lifetime at one
   * hour — unlike a session's TTL, this is not operator-configurable — so
   * `RESET_CODE_TTL_MS` is applied here, unconditionally, rather than trusted
   * to every call site to pass correctly forever.
   */
  create(params: {
    userId: string;
    createdBy: string | null;
    locked: boolean;
  }): MintedResetCode {
    const code = generatePasswordResetCode();
    const now = Date.now();
    const expiresAt = now + RESET_CODE_TTL_MS;

    this.db
      .prepare(
        `INSERT INTO password_reset_codes
           (code_hash, user_id, created_by, created_at, expires_at, locked, redeemed_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        hashResetCode(code),
        params.userId,
        params.createdBy,
        now,
        expiresAt,
        params.locked ? 1 : 0,
      );

    return { code, expiresAt };
  }

  findByCode(code: string): ResetCodeRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM password_reset_codes WHERE code_hash = ?")
        .get(hashResetCode(code)) as ResetCodeRow | undefined) ?? null
    );
  }

  /**
   * Stamps the redemption, and reports whether THIS call was the one that did
   * it — the compare-and-swap the single-use guarantee rests on.
   *
   * The `WHERE … AND redeemed_at IS NULL` guard was already right; returning
   * `changes > 0` is what turns it into a claim rather than a fire-and-forget
   * write. `hashPassword` is ~40ms of argon2, so two concurrent redemptions
   * of the same code can both read `status() === "live"` inside that window;
   * without this return value, both `UPDATE`s "succeed" from the caller's
   * point of view and both requests would go on to set a password, with the
   * loser having no way to learn it lost. A `boolean` rather than the raw
   * `better-sqlite3` change count (unlike `sessions.ts`'s
   * `revokeAllExcept`/`revokeAllForUser`, which return counts because they
   * can touch many rows): this statement matches at most one row, by primary
   * key, so "how many" is never the honest question — "did I just claim it"
   * is.
   *
   * **`AND revoked_at IS NULL` is the second half of that guard, and it is
   * not decoration.** The scenario is an administrator who learns a code has
   * leaked, at the same moment the interceptor posts it: the interceptor's
   * `status(row)` read says `"live"`, `revoke()` lands during the argon2
   * hash, and without this clause the claim still succeeds and the revocation
   * is silently defeated — an authority decision overruled by a race, with
   * nothing anywhere to say so. It was deferred while nothing could produce
   * that state; `routes/passwordReset.ts` is what produces it.
   *
   * `expires_at` is deliberately NOT in this guard. A code that ticks past
   * its hour inside a 40ms hashing window was live when its holder began, and
   * refusing them there would trade a real person's recovery for no security
   * — nobody decided anything. Revocation is the opposite: somebody withdrew
   * the code on purpose, and that decision must win the race.
   */
  markRedeemed(code: string, at = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE password_reset_codes
            SET redeemed_at = ?
          WHERE code_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL`,
      )
      .run(at, hashResetCode(code));
    return result.changes > 0;
  }

  /**
   * Claims the code and performs the caller's writes as one transaction.
   *
   * Follows `InvitesRepository.redeem` (invites.ts:179-193) literally, and for
   * the same reason its comment gives — "Both writes or neither. Half of this
   * is a person who has spent a single-use code and cannot open the board."
   * The half-state here is one notch worse: a spent code plus an unchanged
   * password is an account holder locked out holding a dead credential, whose
   * only way to get another is to ask the administrator again. The boolean
   * above is a *prerequisite* for single use, not the whole of it — it stops
   * two callers both believing they won, and does nothing at all about one
   * caller winning and then failing partway through.
   *
   * `apply` is passed in rather than the statements being written here for
   * the same reason `grantMembership` is: the password write belongs to
   * `UsersRepository` and the session sweep to `SessionsRepository`, and
   * copies of either would drift. better-sqlite3's transactions are
   * synchronous, so this is a transaction and not a promise pretending to be
   * one — which is also why **the argon2 hash must already be done before
   * this is called, and `apply` must not be `async`.**
   *
   * Nothing catches that if you get it wrong. better-sqlite3 does ship a
   * guard — `throw new TypeError('Transaction function cannot return a
   * promise')` at
   * `better-sqlite3-multiple-ciphers/lib/methods/transaction.js:64-67` — but
   * it inspects only the **transaction function's own** return value, and
   * this one returns `true`/`false`, never `apply()`'s. An `async apply` is
   * assignable to `() => void`, so its promise is discarded, the guard sees a
   * boolean, `COMMIT` runs at the first `await`, and the rest of `apply`
   * executes outside the transaction it appears to be inside. TypeScript
   * cannot express the constraint and `lawha-server/**` resolves zero ESLint
   * rules, so this paragraph is the only enforcement that exists.
   *
   * Declining to claim returns `false` having written nothing, rather than
   * throwing: losing the race is an ordinary outcome on this route, and an
   * exception would be indistinguishable from the transaction failing.
   */
  redeem(code: string, apply: () => void, at = Date.now()): boolean {
    return this.db.transaction(() => {
      if (!this.markRedeemed(code, at)) {
        return false;
      }
      apply();
      return true;
    })();
  }

  /**
   * Recalls every code this account still has outstanding, and reports how
   * many that was.
   *
   * **This is what makes a leaked code recallable at all.** `revoke()` below
   * takes the plaintext, and the plaintext exists exactly once — in `create`'s
   * return value, on its way to one recipient. An administrator who has just
   * pasted a reset link into the wrong chat does not have it any more, and
   * neither does the server: only `code_hash` was stored. So the recall has to
   * be keyed on the account, not on the code, or there is no reachable path to
   * `revoked_at` in the whole product — which is precisely the state the audit
   * of 2026-08-07 found (`revoke()` had zero call sites, and every guard,
   * refusal and sentence written to defend the revoked state was unreachable).
   *
   * A count rather than a boolean, unlike {@link markRedeemed} and
   * {@link revoke}: this statement matches many rows by design, so "how many"
   * is the honest question here in a way it never is there. It follows
   * `sessions.ts`'s `revokeAllForUser`, which returns a count for the same
   * reason and whose value ends up in the same audit `detail`.
   *
   * `redeemed_at IS NULL AND revoked_at IS NULL` rather than a `status()`
   * check in TypeScript: a spent code must stay *spent* rather than becoming
   * *revoked*, because `status()` reports redemption first so that somebody
   * refreshing the page they have just redeemed on is told what actually
   * happened. `expires_at` is deliberately absent — an expired code is already
   * dead and stamping it would only make the count lie about what changed.
   */
  revokeAllLiveForUser(userId: string, at = Date.now()): number {
    return this.db
      .prepare(
        `UPDATE password_reset_codes
            SET revoked_at = ?
          WHERE user_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL`,
      )
      .run(at, userId).changes;
  }

  /** Same compare-and-swap shape as {@link markRedeemed}, and the same reason:
   * a caller revoking a code needs to know whether IT was the one that
   * revoked it, not merely that the statement ran. */
  revoke(code: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE password_reset_codes
            SET revoked_at = ?
          WHERE code_hash = ? AND revoked_at IS NULL`,
      )
      .run(Date.now(), hashResetCode(code));
    return result.changes > 0;
  }
}
