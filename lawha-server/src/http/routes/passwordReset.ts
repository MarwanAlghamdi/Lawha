import { Router } from "express";

import { status } from "../../db/repositories/passwordResetCodes.js";
import { isAccountActive, toPublicUser } from "../../db/repositories/users.js";
import { ANONYMOUS_USERNAME } from "../../lib/anonymousUser.js";
import { hashPassword } from "../../lib/password.js";
import { resetPasswordSchema } from "../../lib/validation.js";
import { notifyUserSessionsRevoked } from "../../socket/liveAccess.js";
import { asyncHandler, forbidden, notFound } from "../middleware/errors.js";
import { RateLimiter, clientIpOf, rateLimit } from "../middleware/rateLimit.js";
import { startSession } from "../middleware/session.js";

import type { LawhaContext } from "../../context.js";
import type {
  ResetCodeRow,
  ResetCodeStatus,
} from "../../db/repositories/passwordResetCodes.js";
import type { UserRow } from "../../db/repositories/users.js";

/**
 * Redeeming a one-time password reset code. See
 * docs/adr/0021-admin-password-reset-codes.md
 * and `routes/admin.ts`'s `/users/:userId/reset-code` for the other end.
 *
 * **Unauthenticated, deliberately.** Somebody locked out cannot authenticate,
 * so there is no session to require and no username to ask for — the code is
 * the entire credential on this route. That is the whole reason it needs a
 * session token's entropy (`lib/tokens.ts`) and its own rate limit (below),
 * and it is why this is the one route in the server that mints a session for
 * a caller it has never seen.
 *
 * "Requires no session" is not "carries none", and the difference matters:
 * `sessionMiddleware` is mounted app-wide in `app.ts` ahead of this router
 * with no path guard, so `req.user` IS populated when the redemption comes
 * from a signed-in browser. Nothing here authorizes on it — the code is still
 * the whole credential — but the redemption's audit row records it, because
 * it is the only thing that tells an administrator redeeming a code they
 * intercepted from the account holder redeeming their own.
 *
 * A file of its own rather than a handler in `routes/auth.ts`, which is 700
 * lines in which every branch of `/login` exists to keep that route's cost and
 * its status code blind to which usernames exist. An unrelated handler added
 * there is a handler somebody has to reason about against that constraint
 * for ever.
 *
 * It is the point of the whole feature. An administrator who sets a password
 * *knows* it, so nothing the account does afterwards can be attributed to the
 * person who owns it (§1); this route is the redemption path where the owner
 * chooses a password nobody else ever sees, and the audit row it writes names
 * **them** as the actor — the line §7 calls "the one the product cannot
 * currently write".
 */

const FIFTEEN_MINUTES = 15 * 60_000;

/**
 * How many reset attempts one address gets in a quarter hour.
 *
 * A literal, and it must stay one. The obvious-looking alternative —
 * `ctx.config.loginLimitPerIp` — is a limiter that may be **off**: setting
 * `LAWHA_LOGIN_LIMIT_PER_IP=0` and `LAWHA_LOGIN_LIMIT_PER_USERNAME=0` is a
 * supported configuration and this deployment runs it, and `limit: 0` means
 * OFF rather than "allow
 * nothing" (`rateLimit.ts:43-45` returns before it accumulates anything). A
 * recovery route that inherited that setting would have no limit at all, and
 * nothing about it would look wrong.
 */
const RESET_ATTEMPT_LIMIT = 10;

/**
 * Why a code will not work, in the words the person holding it needs.
 *
 * Four distinguishable refusals rather than one, mirroring `invites.ts`'s
 * `REFUSALS` and taking the same trade for the same reason: telling "no such
 * code" and "that code has expired" apart leaks that a code exists, but only
 * to somebody who already holds a well-formed 43-character one, and the
 * alternative is a person staring at a code they were handed a minute ago
 * being told it is wrong when it is merely late. The rate limit above is what
 * makes that trade affordable, and 256 bits of entropy is what makes it
 * uninteresting.
 */
const REFUSALS: Record<Exclude<ResetCodeStatus, "live">, string> = {
  expired: "That code has expired.",
  revoked: "That code has been turned off.",
  redeemed: "That code has already been used.",
};

export const createPasswordResetRouter = (ctx: LawhaContext): Router => {
  const router = Router();

  /**
   * Built here rather than at module scope, like every other router's
   * (`invites.ts:192-193`) — a limiter's buckets should not outlive the server
   * they belong to, and a module-scope one is shared by every `createApp` a
   * test suite makes.
   *
   * **Per address only, and there is deliberately no global counter.**
   * `auth.ts:166`'s `MASTER_ATTEMPT_KEY` is a bucket keyed on a constant, and
   * that shape was taken knowingly there because the master password has no
   * username, so an attacker rotating names fills nothing. Its own comment
   * records the cost: ten wrong guesses from any device on the LAN close the
   * skeleton key for the rest of the window. Copying it here would buy
   * nothing and cost exactly that. A 43-character base64url code is 256 bits;
   * it is not brute-forceable online at any rate a global counter could
   * shave, so the counter would defend nothing while handing anyone on the
   * network a way to close the recovery path — precisely when somebody is
   * locked out and this route is the only way back in.
   *
   * `RateLimiterOptions.message` (`rateLimit.ts:13`) is not set, because
   * nothing reads it: the middleware always answers `retryMessage(retryInMs)`
   * at `rateLimit.ts:103`. `invites.ts:198` and `:202` set it and it has never
   * appeared anywhere.
   */
  const resetAttempts = new RateLimiter({
    limit: RESET_ATTEMPT_LIMIT,
    windowMs: FIFTEEN_MINUTES,
  });

  /**
   * One budget across both verbs, mirroring the shared `limits` array at
   * `invites.ts:206-209`. Spelt as an array so a route added below cannot be
   * given one half of the pair by accident — and so a prober cannot simply
   * switch method to buy a second budget.
   */
  const limits = [rateLimit(resetAttempts, clientIpOf)];

  /**
   * The code, or the reason there is nothing to show.
   *
   * Existence and spendability are separate steps, the same split
   * `invites.ts:219-253` makes: a person refreshing the page they have just
   * redeemed on needs the first without the second.
   */
  const find = (raw: string): ResetCodeRow => {
    const row = ctx.passwordResetCodes.findByCode(raw);
    if (!row) {
      throw notFound("That code is not valid.", "NO_SUCH_CODE");
    }
    return row;
  };

  const assertSpendable = (row: ResetCodeRow): void => {
    const state = status(row);
    if (state !== "live") {
      throw forbidden(REFUSALS[state], state.toUpperCase());
    }
  };

  /**
   * The account behind a code, refusing if it cannot come back through this
   * door.
   *
   * A missing user is `NO_SUCH_CODE` rather than a fifth refusal, and that is
   * an assertion rather than a hope: `password_reset_codes.user_id` is
   * `ON DELETE CASCADE` (migration 017), so deleting an account takes its
   * outstanding codes with it and `find` above has already answered. This
   * branch is the backstop for the day somebody changes that.
   *
   * A disabled account is refused with the sentence `auth.ts:409` already
   * uses, character for character, because it is the same fact: "this person
   * may not sign in" would mean very little if a code minted before they were
   * turned off let them back in.
   *
   * **This must run AFTER `assertSpendable`, and that order is load-bearing
   * rather than incidental.** The GET hands back `username`, which is what
   * stops a person handed the wrong code from setting a password on somebody
   * else's account — and, worse, producing a `password.reset.redeemed` row
   * naming **the wrong person**, corrupting the one line this entire change
   * exists to write. That disclosure is only defensible because a dead code
   * never reaches here: expired, revoked and redeemed codes are all refused
   * before any account is looked up. A refactor that hoisted this above
   * `assertSpendable` would turn every dead code into a username oracle for
   * anyone holding one, the tests would stay green, and nothing in the type
   * system would notice.
   */
  const liveAccountFor = (row: ResetCodeRow): UserRow => {
    const user = ctx.users.findById(row.user_id);
    if (!user) {
      throw notFound("That code is not valid.", "NO_SUCH_CODE");
    }
    /**
     * The reserved stand-in cannot come back through this door either.
     *
     * `anonymous` is the single shared account used while
     * `LAWHA_REQUIRE_AUTH=false`, and `anonymousUser.ts` stores a deliberately
     * malformed hash for it, describing that as "unreachable as a credential".
     * This route falsified that claim: a code minted against the row let
     * anybody choose a real password for it, and `POST /auth/login` then
     * accepted it. The account owns every board made in that configuration and
     * `GET /admin/users` filters the row out, so nobody could see or disable
     * what they had just given away.
     *
     * `NO_SUCH_CODE` rather than a fifth refusal or a borrowed
     * `ACCOUNT_DISABLED`: the honest answer is that there is nothing here for
     * anyone, and it is the same answer the missing-user backstop above gives.
     * Both verbs go through this function, so the page never renders a form
     * that cannot succeed (invariant 24).
     *
     * The mint route refuses this row as well. Two layers on purpose — a
     * permission enforced in one layer is not enforced (invariant 21), and
     * `create` is reachable from the CLI and from any future caller that does
     * not go past `/admin`.
     */
    if (user.username_lower === ANONYMOUS_USERNAME) {
      throw notFound("That code is not valid.", "NO_SUCH_CODE");
    }
    if (!isAccountActive(user)) {
      throw forbidden("This account has been turned off.", "ACCOUNT_DISABLED");
    }
    return user;
  };

  /**
   * Enough to render the page, and nothing else.
   *
   * The username is not a secret from somebody holding a code minted for that
   * account — the page has to be able to say whose password is being set, or
   * a person handed the wrong code sets the wrong account's password without
   * ever seeing that they did. What it does not carry is the account's id,
   * its role, whether it has an avatar, or anything else `toPublicUser` would
   * have handed over for free. And no email, because there is none anywhere
   * in this product (invariant 9).
   *
   * The refusals here are the same four the POST gives, so the page never
   * renders a form that cannot succeed (invariant 24).
   */
  router.get(
    "/reset/:code",
    ...limits,
    asyncHandler(async (req, res) => {
      const raw = req.params.code as string;
      const row = find(raw);
      assertSpendable(row);
      const user = liveAccountFor(row);

      // The URL is itself a live credential, so nothing between here and the
      // browser may keep a copy of the answer — the same reasoning
      // `admin.ts:258` sets it under for the generated-password body.
      res.set("Cache-Control", "no-store");
      res.json({
        // Echoed back rather than invented: the caller sent it in the path
        // and the page keeps using it. It is not read out of the row, which
        // holds only `code_hash`.
        code: raw,
        username: user.username_display,
        /** Whether minting this code also locked the account (migration 017). */
        locked: row.locked === 1,
        expiresAt: row.expires_at,
      });
    }),
  );

  /**
   * Spending the code: the account holder sets their own password.
   *
   * **The order below is the requirement, not a preference.**
   *
   *  1. The body, then the code, then the account — a refusal must not cost an
   *     argon2 hash it did not have to.
   *  2. `hashPassword`, which is ~40ms and **yields the event loop**. Every
   *     check above it was made against a state that may have moved by the
   *     time it resolves, which is what the next step exists to handle.
   *  3. `ctx.passwordResetCodes.redeem(...)` — one transaction that claims the
   *     code and, only if the claim succeeded, writes the password and revokes
   *     the sessions. Claiming first is what makes the code single-use under
   *     concurrency; doing all three atomically is what stops a half-state in
   *     which the code is spent and the password is not, which would leave the
   *     account holder locked out holding a dead credential.
   *  4. `startSession`, **after** the revocation and outside the transaction.
   *     Mint the session first and the sweep in step 3 deletes the row that
   *     was just written; the caller gets a cookie that resolves to nothing
   *     and the failure presents as "redeeming did not sign me in", with
   *     nothing in any log.
   *
   * Sessions are revoked **even when the code did not lock the account**
   * (§5), matching what `/auth/password` does at `auth.ts:727`: a password
   * change should end other devices. That route uses `revokeAllExcept`
   * because its caller holds a session to keep; this one is unauthenticated,
   * so there is nothing to keep and it is `revokeAllForUser`.
   */
  router.post(
    "/reset/:code",
    ...limits,
    asyncHandler(async (req, res) => {
      const raw = req.params.code as string;
      const { newPassword } = resetPasswordSchema.parse(req.body);

      const row = find(raw);
      assertSpendable(row);
      const user = liveAccountFor(row);

      // The yield. Everything read above is stale from here down.
      const passwordHash = await hashPassword(newPassword);

      let revoked = 0;
      const claimed = ctx.passwordResetCodes.redeem(raw, () => {
        ctx.users.updatePassword(user.id, passwordHash);
        revoked = ctx.sessions.revokeAllForUser(user.id);

        /**
         * §7's line, and the reason this feature exists: the *user* is the
         * actor. **Inside the transaction**, with the three writes it
         * describes, rather than after them.
         *
         * It was outside, and outside is a hole. `ctx.sessions.create` below
         * can throw — `SQLITE_FULL`, a disk error, `SQLITE_BUSY` on a locked
         * database — and `asyncHandler` turns that into a 500. By then the
         * password IS changed, the code IS spent and the sessions ARE
         * revoked, so an audit row written after that point never lands: an
         * account's password changed with nothing in the log saying who did
         * it, which is precisely the state this whole feature was built to
         * make impossible. A synchronous better-sqlite3 write with `revoked`
         * already in hand, so moving it in costs nothing and buys atomicity.
         *
         * `auditActor(req)` cannot be used — it is built for the admin
         * router, where `req.user` is the administrator, and the actor here
         * has to be the account holder whatever session the request carried.
         * `viaMaster: false` for the same reason: it describes the actor, and
         * the actor on this route is never the master password.
         *
         * **A session on this route is not impossible, and the previous
         * version of this comment said it was.** It asserted `req.user` "is
         * undefined by construction"; `sessionMiddleware` is mounted app-wide
         * in `app.ts` ahead of this router with no path guard, so a redemption
         * sent from a signed-in browser arrives carrying that account.
         * Reproduced by the audit of 2026-08-07 (finding 13(a)): the abusive
         * redemption arrived with `req.user` set to the administrator, the
         * honest one with `req.user` undefined — the single fact separating
         * them, thrown away.
         *
         * So it is recorded, in the free-text column that already exists.
         * `detail` rather than `actor_*`: the actor is still the account
         * holder, because they are whose password this is and §7's line is
         * about attribution, not about which browser the packet came from.
         * The two facts sit side by side and the reader compares them —
         * `actorLabel: yasmin` next to "signed in as alex" is the whole
         * finding, and it needs no migration and no new column.
         *
         * Never the code and never the password. That rule predates this
         * route (`admin.ts`'s mint) and is not relaxed for the one credential
         * this server hands out in a URL. A username is not one: the row
         * beside it already names an account, and there is no email anywhere
         * in this product to leak instead (invariant 9).
         */
        const carriedSession = req.user
          ? `; redeemed from a session signed in as ${req.user.username}${
              req.viaMaster === true ? " (via the master password)" : ""
            }`
          : "";

        ctx.audit.record({
          actorUserId: user.id,
          actorLabel: user.username_display,
          viaMaster: false,
          action: "password.reset.redeemed",
          targetUserId: user.id,
          targetLabel: user.username_display,
          detail: `${revoked} session(s) revoked${carriedSession}`,
        });
      });

      if (!claimed) {
        // Lost the claim inside the hashing window, and the caller is owed
        // the real reason rather than a guess (invariant 24). Two things can
        // take it: another request redeeming the same code, or an
        // administrator revoking it — `markRedeemed`'s WHERE guards both.
        const current = ctx.passwordResetCodes.findByCode(raw);
        if (!current) {
          throw notFound("That code is not valid.", "NO_SUCH_CODE");
        }
        assertSpendable(current);
        // Unreachable: the claim declines only when one of those two columns
        // is set, and `assertSpendable` throws for both. Kept because an
        // "impossible" branch that falls through is how a lost claim would
        // quietly become a 200 with no password written.
        throw forbidden(REFUSALS.redeemed, "REDEEMED");
      }

      /**
       * The session sweep inside the transaction reaches the sockets here, and
       * **before `startSession` below** — that order is the requirement.
       *
       * Eviction is keyed on the account id, because a socket's credential is
       * resolved once at the handshake and there is nothing else on it to key
       * on. So the set "every socket of this account" only equals the set
       * "every socket holding a session that no longer exists" while the
       * account has none — which is exactly the window between the revocation
       * that just committed and the session minted below. Move this line after
       * `startSession` and it starts racing the one person it must never
       * touch: whoever has just recovered their own account, whose fresh
       * socket is indistinguishable from the dead ones by account id and would
       * be thrown off the board they recovered access for.
       *
       * Awaited rather than fire-and-forget for the same reason: an eviction
       * that resolves after the response has gone out is an eviction that can
       * land after the client has reconnected.
       */
      await notifyUserSessionsRevoked(user.id);

      // Here rather than after `startSession`, so the operator's live view and
      // the durable row above cannot disagree: both now record the redemption
      // the instant it has committed, and a failure minting the session is a
      // separate fact that fails separately. The code never reaches this line
      // — `admin.ts:240-243`'s rule, and a test sweeps stdout for it.
      process.stdout.write(
        `lawha: ${user.username_display} redeemed a password reset code (${revoked} session(s) revoked)\n`,
      );

      startSession(ctx, req, res, user.id, req.headers["user-agent"]);

      res.set("Cache-Control", "no-store");
      // Re-read rather than serialising `user`, which was fetched above and is
      // a snapshot from BEFORE the password write on a route whose entire
      // purpose is that the row changed. `toPublicUser` exposes no password
      // field, so nothing is wrong today — this is about not leaving a stale
      // read on the one route guaranteed to have invalidated it. `?? user`
      // because the account cannot plausibly vanish between two synchronous
      // statements, and answering 500 if it somehow did would be worse than
      // answering with the snapshot: the redemption has already committed.
      res.json({ user: toPublicUser(ctx.users.findById(user.id) ?? user) });
    }),
  );

  return router;
};
