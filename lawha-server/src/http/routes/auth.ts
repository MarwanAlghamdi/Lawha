import fs from "node:fs/promises";
import path from "node:path";

import { Router } from "express";
import { z } from "zod";

import { isAccountActive, toPublicUser } from "../../db/repositories/users.js";
import { ANONYMOUS_USERNAME } from "../../lib/anonymousUser.js";
import { isValidRoomId } from "../../protocol.js";
import {
  notifyBoardAccessChanged,
  notifyUserSessionsRevoked,
} from "../../socket/liveAccess.js";
import {
  consumeTimingBudget,
  hashPassword,
  verifyPassword,
} from "../../lib/password.js";
import {
  changePasswordSchema,
  credentialsSchema,
  deleteAccountSchema,
  loginSchema,
  normalizeUsername,
  updateProfileSchema,
} from "../../lib/validation.js";
import {
  asyncHandler,
  conflict,
  forbidden,
  tooManyRequests,
  unauthorized,
} from "../middleware/errors.js";
import {
  FailureBackoff,
  RateLimiter,
  clientIpOf,
  rateLimit,
  retryMessage,
  sleep,
} from "../middleware/rateLimit.js";
import {
  buildAdminSessionCookie,
  buildClearedAdminSessionCookie,
  buildClearedSessionCookie,
  startSession,
} from "../middleware/session.js";
import { resolveAvatarDir } from "./users.js";

import type { LawhaContext } from "../../context.js";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

/**
 * Login, plus the one field that is meaningful to this route and nowhere else.
 *
 * Composed here rather than widening `loginSchema` in `lib/validation.ts`: that
 * schema describes a credential pair, and `master` is not a credential — it is
 * the caller saying *which* credential the password field holds.
 */
const loginBodySchema = loginSchema.extend({
  /**
   * "The password below is the master password; sign me in as the named
   * account." Optional, and absent means the old behaviour: try the account's
   * own password and fall back to the master one.
   *
   * The flag is not merely cosmetic. Ticked, it *skips accepting* the
   * account's own password, which is the only way a person whose own password
   * happens to equal the master password can get a session flagged
   * `via_master` — see the "prefers the account's own password" test, which
   * pins the unticked half of exactly that case.
   *
   * Skipping the *acceptance* is the feature. Skipping the *hash* was a
   * username oracle, and the comment that used to sit here got it wrong: it
   * reasoned that a faster ticked attempt only disclosed whether a master
   * password was configured, which `GET /api/auth/config` publishes anyway.
   * What it actually disclosed was which usernames exist. With no master
   * password configured — the default — `!askedForMaster && await verify(...)`
   * short-circuits, so a ticked probe at a real account ran zero argon2 (0.90ms
   * median, measured) while the `!user` branch still ran one. Every hash in
   * this handler is now unconditional; see `verifyAccountPassword`.
   *
   * The flag is deliberately *not* rejected when no master password is
   * configured. A 400 there would be a second, quieter channel for
   * `hasMasterPassword` that keeps answering after an operator has decided the
   * front door should say less, and it would answer before any of the
   * equalising work below has run — the fastest possible response on the whole
   * route. Accepting the flag and refusing the attempt with the ordinary
   * "Incorrect username or password." costs the same as every other refusal
   * and tells the caller nothing they did not already know.
   */
  master: z.boolean().optional(),
});

/**
 * How many master-password verifications this server will perform in a window,
 * across every username and every address.
 *
 * The other two limiters cannot cover this credential. `loginByUsername` and
 * `FailureBackoff` are keyed on the username, and the master password *has* no
 * username — an attacker rotating usernames spreads their guesses across as
 * many buckets as the server has accounts and none of the buckets fills. That
 * leaves only `loginByIp`, which is deliberately loose (60/quarter hour)
 * because a whole office can sit behind one NAT address, so it is not a
 * brute-force defence and was never meant to be. A counter keyed on nothing at
 * all is the only one that keys on the credential actually being guessed.
 *
 * It is a *global* counter and it is spent by ordinary mistyped passwords too,
 * because on a server with a master password configured every rejected
 * password reaches this check — there is no way to tell a typo from a guess
 * until the hash has been run. That collateral is why the failure mode matters
 * more than the number: a successful sign-in never reaches here, so a spent
 * budget closes the skeleton key for the rest of the window and nothing else.
 * Everyone can still sign in with their own password, and the administrator
 * still has `LAWHA_ADMIN_USERNAME` and
 * `yarn --cwd lawha-server reset-password`.
 *
 * Note what this does *not* survive: the buckets are in memory, so a restart
 * clears them. For this one credential that is a real weakness rather than an
 * acceptable simplification — a crash-loop, or an attacker who can provoke a
 * restart, resets the budget — and it is recorded here rather than papered
 * over. It is still worth having: it turns an unbounded online guess into ~960
 * a day, and the durable answer (a counter in SQLite) is a schema change that
 * should be taken deliberately rather than smuggled in beside a UI feature.
 */
const MASTER_ATTEMPT_LIMIT = 10;

/**
 * `POST /auth/master`: the credential and nothing else.
 *
 * No username field, not even an optional one. The route resolves whose
 * session to mint itself, and an ignored field on the wire is an invitation to
 * believe it does something.
 *
 * The upper bound matches `loginSchema`'s: argon2 hashes whatever it is given,
 * and an unbounded body is CPU an unauthenticated caller gets to spend.
 */
const masterOnlySchema = z.object({
  password: z.string().min(1).max(200),
});

/**
 * There is one master password, so there is one bucket.
 *
 * One bucket keyed on a constant is also a denial of service anyone can mount:
 * ten wrong guesses from any device on the LAN close the skeleton key for the
 * rest of the window, and that is the path that matters most precisely when
 * someone is locked out. The trade is taken knowingly — the alternative shapes
 * are worse. Keying it per address lets an attacker who can rotate addresses
 * (trivial on a LAN) buy back an unbounded budget, and keying it per username
 * is the hole this bucket exists to close, because the master password has no
 * username and an attacker rotating names fills nothing. The administrator
 * keeps two paths that this bucket cannot touch: their own password, and
 * `yarn --cwd lawha-server reset-password`.
 *
 * A spent bucket must not become an oracle, which is a separate concern and is
 * handled at the refusal below: the check is reached identically whether or
 * not the username exists, so the 429 says something about the bucket and
 * nothing about the account. That has a cost worth naming — a username that
 * does not exist now spends the budget too, so it can be exhausted without
 * knowing a single account name. It is a widening of a denial of service that
 * was already trivial for anyone holding one valid username, and it is not
 * avoidable: a counter consulted on only one of two paths *is* the difference
 * between them.
 */
const MASTER_ATTEMPT_KEY = "master";

/**
 * One argon2id verification, whether or not there is an account behind the
 * username.
 *
 * A missing account used to be an early return — hash a dummy, 401 — which
 * made every hash *after* that point a username oracle. Ticked, the account's
 * own verification short-circuited away entirely, so an existing username cost
 * zero hashes and a missing one cost one; measured on this project's own
 * harness at N=15, one probe per username, an existing name answered in a
 * median of 0.90ms. Nothing caught it: `loginByUsername` is 5 per quarter hour
 * keyed on the username so one probe per candidate never fills a bucket, and
 * `FailureBackoff` does not start delaying until the fifth failure.
 *
 * Absence is modelled here as "an account whose password can never match", so
 * there is exactly one path through the handler and it costs the same either
 * way.
 */
const verifyAccountPassword = async (
  user: { password_hash: string } | null,
  password: string,
): Promise<boolean> => {
  if (!user) {
    // A real verify against a real hash of a throwaway password. Anything
    // cheaper — a fixed sleep, a shorter hash — is a different cost and
    // therefore still a signal.
    await consumeTimingBudget(password);
    return false;
  }
  // Against the account's own stored hash rather than the dummy, so the cost
  // tracks whatever parameters that hash was actually written with.
  return verifyPassword(user.password_hash, password);
};

/**
 * The second verification, so that every *rejected* sign-in costs exactly two
 * argon2id verifications and every accepted one exactly one.
 *
 * Three cases would otherwise be free, and each of them is reachable by a
 * caller who chooses it: no master password configured (the default
 * deployment), the global budget already spent (a state any caller can
 * provoke), and the box ticked. Equalising them means the price of a refusal
 * says nothing about which username, which flag, or which server
 * configuration produced it — a successful sign-in still costs one hash,
 * because a 200 has already said everything a stopwatch could.
 */
const verifyMasterCredential = async (
  masterPassword: LawhaContext["masterPassword"],
  password: string,
): Promise<boolean> => {
  if (!masterPassword.enabled) {
    await consumeTimingBudget(password);
    return false;
  }
  return masterPassword.verify(password);
};

export const createAuthRouter = (ctx: LawhaContext): Router => {
  const router = Router();

  /**
   * Per-IP limits are deliberately loose and per-username limits are not.
   *
   * On a private network a whole office can sit behind one NAT address, so an
   * IP is barely an identity: a tight per-IP limit mostly locks out the fifth
   * colleague to sign up on their first morning. The per-username limit is the
   * one that actually stops password guessing, because an attacker cannot
   * spread attempts against one account across addresses they do not have.
   *
   * These are in memory, so restarting the server clears them.
   */
  const loginByIp = new RateLimiter({
    limit: ctx.config.loginLimitPerIp,
    windowMs: FIFTEEN_MINUTES,
  });
  const loginByUsername = new RateLimiter({
    limit: ctx.config.loginLimitPerUsername,
    windowMs: FIFTEEN_MINUTES,
  });
  const registerByIp = new RateLimiter({
    limit: ctx.config.registerLimitPerIp,
    windowMs: ONE_HOUR,
  });
  const masterAttempts = new RateLimiter({
    limit: MASTER_ATTEMPT_LIMIT,
    windowMs: FIFTEEN_MINUTES,
  });
  // Same number as the limiter above, so one setting turns the whole
  // per-username story off. A deployment that has said "do not count sign-in
  // attempts" has not said "sleep on them for eight seconds instead".
  const backoff = new FailureBackoff(ctx.config.loginLimitPerUsername);

  // `startSession` used to be a closure here, over `ctx`. It moved to
  // `middleware/session.ts` — taking `ctx` as its first argument instead —
  // when `POST /api/auth/reset/:code` needed the same four lines from a
  // different router. Nothing about `/login`'s behaviour changed with it, and
  // `auth.test.ts` and `loginEnumeration.test.ts` are unmodified, which is
  // what says so.

  router.post(
    "/register",
    rateLimit(registerByIp, clientIpOf),
    asyncHandler(async (req, res) => {
      if (!ctx.config.allowOpenRegistration) {
        throw forbidden("Registration is closed on this server.");
      }

      const { username, password } = credentialsSchema.parse(req.body);

      if (ctx.users.findByUsername(username)) {
        // Enumeration is unavoidable here — "username taken" is the point of
        // the endpoint. LAWHA_ALLOW_OPEN_REGISTRATION=false is the mitigation.
        throw conflict("That username is taken.", "USERNAME_TAKEN");
      }

      const user = ctx.users.create({
        username,
        passwordHash: await hashPassword(password),
        // The very first account on a fresh server becomes the admin; without
        // this, granting the role would need a role nobody has yet.
        isAdmin: ctx.users.countAdmins() === 0,
        // `colorIndex` is left off rather than passed as null: omitting it is
        // what makes UsersRepository.create assign one. This used to be NULL,
        // which the client reads as "no choice on record" and answers with
        // hash(socketId) — a value regenerated on every reconnect, so a
        // collaborator's cursor changed colour mid-session and looked like a
        // different colour to each peer. See migration 004 for the backfill.
      });

      startSession(ctx, req, res, user.id, req.headers["user-agent"]);
      res.status(201).json({ user: toPublicUser(user) });
    }),
  );

  router.post(
    "/login",
    rateLimit(loginByIp, clientIpOf),
    rateLimit(loginByUsername, (req) =>
      String(
        (req.body as { username?: unknown })?.username ?? "",
      ).toLowerCase(),
    ),
    asyncHandler(async (req, res) => {
      const { username, password, master } = loginBodySchema.parse(req.body);
      const key = username.toLowerCase();
      const askedForMaster = master === true;

      await sleep(backoff.delayFor(key));

      // Not an early return when this is null. Everything below runs for a
      // username that does not exist as well, and only the refusal at the end
      // knows the difference — an early return is what made this route's cost
      // and its status code both depend on whether the account was real.
      const user = ctx.users.findByUsername(username);

      // Ticking the box means "this is the master password", so the account's
      // own is not *accepted*. It is still verified and the answer discarded:
      // `!askedForMaster && (await verifyPassword(...))` read better and was a
      // username oracle, because `&&` short-circuits and the hash never ran.
      // Order these the other way round again and the leak comes straight back.
      const ownPasswordMatched = await verifyAccountPassword(user, password);
      const ownPasswordAccepted = !askedForMaster && ownPasswordMatched;

      let viaMaster = false;
      /** Non-null once the global master budget is spent for this window. */
      let masterRetryInMs: number | null = null;

      if (!ownPasswordAccepted) {
        // The administrator's skeleton key. Tried second so a user whose own
        // password happens to match it still signs in as themselves, and so
        // the common path costs one hash rather than two.
        //
        // The budget is consulted whether or not the username exists, and that
        // is the fix for the status-code oracle: it used to sit behind the
        // `!user` early return, so with the bucket full a real username got
        // 429 RATE_LIMITED and an invented one 401 UNAUTHENTICATED. Since
        // `RateLimiter.check` does not increment once blocked, that difference
        // was stable for the whole quarter-hour window and free to repeat —
        // an attacker who deliberately exhausted a bucket that is global by
        // construction converted it into an unlimited existence oracle.
        //
        // Still gated on `enabled`, because that is public (`/api/auth/config`
        // publishes `hasMasterPassword`) and because spending this budget on
        // ordinary typos would start answering 429 on servers that have no
        // master password to guess at.
        masterRetryInMs = ctx.masterPassword.enabled
          ? masterAttempts.check(MASTER_ATTEMPT_KEY)
          : null;

        if (masterRetryInMs === null) {
          viaMaster = await verifyMasterCredential(
            ctx.masterPassword,
            password,
          );
        } else {
          // Spent: there is no verification left to run, but the cost is paid
          // anyway. Otherwise the *unticked* caller — who is answered 401
          // either way — could time the difference and read the state of this
          // counter, which is the oracle the 401 was chosen to deny them.
          await consumeTimingBudget(password);
        }
      }

      // A master password authenticates against the server, not against an
      // account, so it opens no door on its own — there has to be someone to
      // sign in as. `!user` is folded into this one refusal rather than
      // returned early above so that a username that does not exist reaches it
      // through the same code, the same two hashes and the same branch.
      if (!user || (!ownPasswordAccepted && !viaMaster)) {
        // Two different refusals, and the difference is deliberate. Both are
        // now blind to whether the username exists; what they distinguish is
        // what the caller asked for.
        //
        // A caller who ticked the box asked for this credential by name and is
        // owed the real reason (invariant 24) — otherwise an administrator
        // locked out by someone else's guessing reads it as "my master
        // password stopped working" and starts looking for a configuration
        // fault that is not there. 429 here discloses the state of a bucket
        // that is global by construction and says nothing about any account.
        //
        // A caller who did *not* tick it never asked for the master path at
        // all: they mistyped their own password. Answering them 429 would
        // report a limit they did not hit, and would hand anyone probing
        // implicitly a free oracle for the state of this counter. They get the
        // ordinary wrong-password answer.
        if (askedForMaster && masterRetryInMs !== null) {
          throw tooManyRequests(retryMessage(masterRetryInMs));
        }
        backoff.recordFailure(key);
        throw unauthorized("Incorrect username or password.");
      }

      // The credential was right and the account is stopped (migration 016).
      // *After* the password check, not before, so a disabled username costs
      // the same two hashes as any other and this route stays blind to which
      // accounts exist — the property the branch above exists to protect.
      //
      // The master password does not override it, and that is the point:
      // "this person may not sign in" would mean very little if the
      // administration credential could sign in as them anyway.
      //
      // One of three enforcement points; the others are `sessionMiddleware`
      // and the socket authenticator (invariant 21).
      if (!isAccountActive(user)) {
        throw forbidden(
          "This account has been turned off.",
          "ACCOUNT_DISABLED",
        );
      }

      if (viaMaster) {
        // Proof of holding the credential, so the budget an attacker was
        // burning is released — the same shape as `backoff.recordSuccess`.
        masterAttempts.reset(MASTER_ATTEMPT_KEY);
        process.stdout.write(
          `lawha: master-password sign-in as ${user.username_display}\n`,
        );
      }

      backoff.recordSuccess(key);
      loginByUsername.reset(key);
      startSession(
        ctx,
        req,
        res,
        user.id,
        req.headers["user-agent"],
        viaMaster,
      );
      res.json({ user: toPublicUser(user) });
    }),
  );

  /**
   * The master password on its own — the application's administration password.
   *
   * **It is not an account, and it does not sign you in as one.** An earlier
   * version resolved an administrator and minted an ordinary session for them,
   * which kept every administrative action attributable to a person; that was
   * reversed deliberately, because borrowing somebody's identity to open a
   * panel is not what this credential is for. What it opens now is an
   * administration session with nobody behind it — `admin_sessions`, its own
   * cookie, twelve hours, no sliding refresh. Migration 007 has the reasoning
   * and the cost.
   *
   * `req.user` stays undefined for such a session, which is the safety
   * property: every board, folder, tag, scene and file route already refuses a
   * caller with no user, so this cannot reach one. Only `requireAdmin` looks at
   * the flag.
   *
   * `POST /login` with `master: true` still exists and still needs a username.
   * That is the other job the credential has — signing in *as* somebody to
   * reproduce a problem on their account — and it is unchanged.
   *
   * A separate route rather than a widened `loginSchema`, because `/login` is
   * tuned so that neither its cost nor its status code discloses which
   * usernames exist, and every branch of it exists to keep that true.
   */
  router.post(
    "/master",
    rateLimit(loginByIp, clientIpOf),
    asyncHandler(async (req, res) => {
      const { password } = masterOnlySchema.parse(req.body);

      // Checked before the hash, exactly as in `/login`: `check` does not
      // increment once blocked, so a spent budget must not also buy an
      // unlimited supply of free argon2 verifications.
      const retryInMs = ctx.masterPassword.enabled
        ? masterAttempts.check(MASTER_ATTEMPT_KEY)
        : null;

      if (retryInMs !== null) {
        // The cost is paid anyway, so the state of a global counter cannot be
        // read off a stopwatch.
        await consumeTimingBudget(password);
        throw tooManyRequests(retryMessage(retryInMs));
      }

      if (!(await verifyMasterCredential(ctx.masterPassword, password))) {
        throw unauthorized("Incorrect password.");
      }

      masterAttempts.reset(MASTER_ATTEMPT_KEY);
      process.stdout.write(
        "lawha: administration panel opened with the master password\n",
      );

      const { token, expiresAt } = ctx.adminSessions.create(
        req.headers["user-agent"],
      );
      res.append(
        "Set-Cookie",
        buildAdminSessionCookie(ctx, req, token, expiresAt),
      );
      res.json({ masterAdmin: true, expiresAt });
    }),
  );

  router.post("/logout", (req, res) => {
    if (req.sessionToken) {
      ctx.sessions.revoke(req.sessionToken);
    }
    res.append("Set-Cookie", buildClearedSessionCookie(ctx, req));

    // Both, because they are independent and somebody may hold both. Signing
    // out of an account while silently leaving the administration panel open
    // is the kind of surprise this exists to avoid.
    if (req.adminSessionToken) {
      ctx.adminSessions.revoke(req.adminSessionToken);
    }
    res.append("Set-Cookie", buildClearedAdminSessionCookie(ctx, req));

    res.status(204).end();
  });

  /**
   * What the sign-in UI needs to know before it renders: whether an account is
   * required at all, and whether the "Create one" path exists on this server.
   * Deliberately unauthenticated and deliberately narrow — it is a description
   * of the front door, not of what is behind it.
   */
  router.get("/config", (_req, res) => {
    res.json({
      requireAuth: ctx.config.requireAuth,
      allowOpenRegistration: ctx.config.allowOpenRegistration,
      // Lets the sign-in screen say who to call rather than offering a
      // self-service reset that does not exist.
      hasMasterPassword: ctx.masterPassword.enabled,
      /**
       * Singular name, singular value: `lanOrigins[0]` and nothing else.
       * This route has no auth middleware and is fetched on boot by
       * `useLawhaSession` before the app knows whether anyone is signed in,
       * so whatever it returns is readable by anyone who can reach the
       * server — including a stranger who found the ngrok URL. Publishing
       * the primary address costs that stranger nothing: a LAN hostname or
       * private IP is unreachable from outside the network, so it grants no
       * capability they did not already lack. Publishing the whole
       * `lanOrigins` array would not — it would hand that same stranger
       * every internal address this deployment answers to, for zero benefit
       * to the one caller this exists for, the sign-in page, which only
       * ever renders one recommended LAN link. The plural on this route is
       * the thing that must never happen.
       *
       * `?.[0] ?? null`, not `? [0] : null` — a truthy check on `lanOrigins`
       * treats `[]` the same as a populated array, and `[][0]` is
       * `undefined`, which `JSON.stringify` drops from the response
       * entirely. That would turn "no LAN route" into a *missing key*
       * instead of `null`, breaking the one contract this field promises.
       * `parseOriginList` never actually returns `[]` today — it collapses
       * to `null` — but that invariant lives in config.ts, not here, and
       * `LawhaConfig.lanOrigins` is typed `string[] | null`, so nothing
       * stops a future caller (this test suite already builds config
       * objects directly) from constructing one that does.
       */
      lanOrigin: ctx.config.lanOrigins?.[0] ?? null,
      // Already public in the sense that matters: whoever is asking either
      // typed this origin into a browser to get here, or is about to be
      // handed it to share with someone off-network. Nothing here narrows
      // who can reach it beyond what possessing the tunnel URL already does.
      publicShareOrigin: ctx.config.publicShareOrigin,
    });
  });

  /**
   * The authenticated half of the pair started by `/config` above. That
   * route hands every caller — including a stranger who found the ngrok
   * URL, since it has no auth middleware — only `lanOrigins[0]`. This route
   * sits behind `req.user` and hands a SIGNED-IN caller the full list,
   * because the rest of the addresses are internal topology, useful to the
   * share panel picking the best link for a specific invitee, and worth
   * nothing to a stranger who cannot reach a LAN address anyway.
   *
   * Gated on `req.user`, not on `ctx.config.requireAuth`.
   * `LAWHA_REQUIRE_AUTH=false` is a supported shape (invariant 22 and the
   * roadmap both turn it on) and describes whether an anonymous connection
   * gets in, not whether this deployment's internal addressing is public —
   * those are two different questions, and answering the second off the
   * first would mean flipping one setting silently widened this route too.
   * The 401 body matches `/me`'s below exactly (same error, same code, same
   * `masterAdmin` flag), so a caller already handling that shape does not
   * need a second one for this route.
   *
   * `lanOrigins` answers `[]`, not `null`, when unset — the opposite of
   * `config.lanOrigins`. `null` there is `loadConfig`'s own vocabulary for
   * "no LAN route configured" (see the long comment in config.ts); here the
   * value lands in a JSON array the client maps over, and `[]` is the shape
   * that needs no special case to render, where `null` would.
   */
  router.get("/origins", (req, res) => {
    if (!req.user) {
      res.status(401).json({
        error: "Sign in to continue.",
        code: "UNAUTHENTICATED",
        masterAdmin: req.masterAdmin === true,
      });
      return;
    }
    res.json({
      lanOrigins: ctx.config.lanOrigins ?? [],
      publicShareOrigin: ctx.config.publicShareOrigin,
    });
  });

  router.get("/me", (req, res) => {
    if (!req.user) {
      // A master-password session has no account, so this is still not a
      // signed-in *user* — and the 401 is still the right answer to "who am
      // I?". What it carries is the one extra fact the client needs to decide
      // whether to render `/admin`, and it is on the error body rather than a
      // 200 so that nothing which treats a 200 here as "there is a user" can
      // be fooled by it.
      res.status(401).json({
        error: "Sign in to continue.",
        code: "UNAUTHENTICATED",
        masterAdmin: req.masterAdmin === true,
      });
      return;
    }
    // `viaMaster` rides alongside the user rather than inside it: it is a fact
    // about this session, not about the account, and it must not survive into
    // anything that caches a user.
    res.json({
      user: req.user,
      viaMaster: req.viaMaster === true,
      masterAdmin: req.masterAdmin === true,
    });
  });

  router.patch(
    "/me",
    asyncHandler(async (req, res) => {
      if (!req.user) {
        throw unauthorized();
      }

      // Destructured and re-assembled below rather than passed through as one
      // object, so a field added to the schema and forgotten here shows up as
      // a type error instead of as a setting that silently never saves. ADR
      // 0003 records the client-side version of that mistake: the account form
      // built its PATCH body from a subset of the dirty fields, so changing
      // only the laser colour sent `{}` and came back 400 "Nothing to update".
      const { username, colorIndex, laserColorIndex, avatarOnCursor } =
        updateProfileSchema.parse(req.body);

      if (username !== undefined) {
        const existing = ctx.users.findByUsername(username);
        // Re-casing your own name is allowed; taking someone else's is not.
        if (existing && existing.id !== req.user.id) {
          throw conflict("That username is taken.", "USERNAME_TAKEN");
        }
        if (normalizeUsername(username) === ANONYMOUS_USERNAME) {
          throw conflict("That username is reserved.", "USERNAME_TAKEN");
        }
      }

      const updated = ctx.users.updateProfile(req.user.id, {
        username,
        colorIndex,
        laserColorIndex,
        avatarOnCursor,
      });

      if (!updated) {
        throw unauthorized();
      }

      res.json({ user: toPublicUser(updated) });
    }),
  );

  router.delete(
    "/me",
    asyncHandler(async (req, res) => {
      if (!req.user) {
        throw unauthorized();
      }

      const { password } = deleteAccountSchema.parse(req.body);
      const user = ctx.users.findById(req.user.id);

      // Session-authenticated is not enough for an irreversible delete: an
      // unattended browser is a plausible threat and a borrowed one is common.
      if (!user || !(await verifyPassword(user.password_hash, password))) {
        throw unauthorized("Password is incorrect.");
      }

      const { deletedBoardIds } = ctx.users.deleteAccount(user.id);

      // Every live socket this account holds, anywhere — its own boards
      // (about to lose their file trees below, and already gone from the
      // database above) and any other board it had merely joined. No
      // `keepSessionToken`: unlike a password change there is no session left
      // to spare, and a "delete my data" that answers 204 has to mean nothing
      // of this account survives it, sockets included.
      await notifyUserSessionsRevoked(user.id);

      // The account's OWN boards are gone as rows, not just this account's
      // access to them — `deleteAccount` cascades them away. Anyone else still
      // in one of those rooms (a co-member, a share-link guest) has to be
      // re-checked and evicted the same way `DELETE /:boardId` already does
      // for a single board, or they keep relaying edits into a room whose
      // board no longer exists.
      await Promise.all(
        deletedBoardIds.map((boardId) => notifyBoardAccessChanged(boardId)),
      );

      // Resolved rather than interpolated, for the same reason the board
      // directories below are: a user id is a path component here, and nothing
      // outside the avatars root may be reachable from one.
      const avatarDir = resolveAvatarDir(ctx.config.filesDir, user.id);

      // A failure here must not turn an irreversible, re-authenticated delete
      // into a 500 — the database rows are already gone, and telling the
      // caller their own deletion failed when the account really is deleted
      // would be worse than the leak. But it must not stay quiet either: this
      // catch used to be `.catch(() => undefined)`, and the operator had no
      // way to learn that a directory did not go with the account it belonged
      // to. Logged with the user id, the board id (or "avatar"), and the exact
      // path, because that is what somebody cleaning this up by hand needs —
      // the avatar in particular is, as the comment below says, still a
      // recognisable picture of a deleted person until this succeeds.
      const logCleanupFailure = (
        what: string,
        target: string,
        error: unknown,
      ) => {
        process.stderr.write(
          `lawha: failed to remove ${what} for deleted user ${user.id} ` +
            `(${target}): ` +
            `${error instanceof Error ? error.message : String(error)}\n`,
        );
      };

      // Encrypted blobs whose key died with the account are unreadable, but
      // they are not free — remove the directories rather than leak disk. The
      // avatar directory is not encrypted at all and is the one thing here that
      // would still be a recognisable picture of a deleted person.
      await Promise.all([
        // Re-validated before touching the filesystem. Board ids arrive from
        // clients, and `..` reaching path.resolve here would delete the wrong
        // tree entirely — the id having been accepted elsewhere is not a
        // licence to trust it as a path component.
        ...deletedBoardIds.filter(isValidRoomId).map((boardId) => {
          const roomDir = path.resolve(ctx.config.filesDir, "rooms", boardId);
          return fs
            .rm(roomDir, { recursive: true, force: true })
            .catch((error: unknown) =>
              logCleanupFailure(`board ${boardId}`, roomDir, error),
            );
        }),
        ...(avatarDir
          ? [
              fs
                .rm(avatarDir, { recursive: true, force: true })
                .catch((error: unknown) =>
                  logCleanupFailure("avatar", avatarDir, error),
                ),
            ]
          : []),
      ]);

      res.append("Set-Cookie", buildClearedSessionCookie(ctx, req));
      res.status(204).end();
    }),
  );

  router.post(
    "/password",
    asyncHandler(async (req, res) => {
      if (!req.user || !req.sessionToken) {
        throw unauthorized();
      }

      const { currentPassword, newPassword } = changePasswordSchema.parse(
        req.body,
      );
      const user = ctx.users.findById(req.user.id);

      if (
        !user ||
        !(await verifyPassword(user.password_hash, currentPassword))
      ) {
        throw unauthorized("Current password is incorrect.");
      }

      ctx.users.updatePassword(user.id, await hashPassword(newPassword));
      // Every other device must re-authenticate.
      ctx.sessions.revokeAllExcept(user.id, req.sessionToken);
      // ...and every other device's SOCKET has to go with it. Deleting the
      // session row does nothing to a connection that is already up:
      // `authenticate` is a socket.io handshake middleware and has long since
      // run. Without this, somebody changing their password *because* they
      // think a session was stolen kills the thief's cookie and leaves the
      // thief's open socket relaying the board — reading every element, and
      // writing elements that the victim's own peers then persist under their
      // sessions (`rooms.ts` documents that laundering path).
      //
      // `req.sessionToken` is passed so this session is spared on both sides:
      // `revokeAllExcept` keeps the row, and this keeps the socket.
      await notifyUserSessionsRevoked(user.id, req.sessionToken);

      res.status(204).end();
    }),
  );

  return router;
};
