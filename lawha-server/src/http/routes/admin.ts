import { Router } from "express";

import { toPublicUser } from "../../db/repositories/users.js";
import { ANONYMOUS_USERNAME } from "../../lib/anonymousUser.js";
import { generatePassword } from "../../lib/firstBootAdmin.js";
import { LOCKED_PASSWORD_HASH, hashPassword } from "../../lib/password.js";
import {
  adminCreateUserSchema,
  adminResetCodeSchema,
  adminSetDisabledSchema,
  adminSetRoleSchema,
} from "../../lib/validation.js";
import { notifyUserSessionsRevoked } from "../../socket/liveAccess.js";
import {
  asyncHandler,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from "../middleware/errors.js";
import { RateLimiter, callerOf, rateLimit } from "../middleware/rateLimit.js";
import { resolveSecureCookie } from "../middleware/session.js";
import { createAdminBackupRouter } from "./adminBackup.js";

import type { LawhaContext } from "../../context.js";
import type { NextFunction, Request, Response } from "express";

const FIVE_MINUTES = 5 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * Reads, per caller, per five minutes.
 *
 * Deliberately far above anything the panel can generate — it loads the account
 * list once on mount and again after each change — because this ceiling exists
 * to bound a script, not to ration a person.
 */
const ADMIN_READ_LIMIT = 120;

/**
 * Changes, per caller, per quarter hour.
 *
 * Much tighter, because these are the two routes that do damage: one sets any
 * account's password and signs every one of their devices out, the other writes
 * a permanent `is_admin` row. Twenty is more than a human doing phone support
 * will ever need in a quarter of an hour and far less than a stolen session
 * needs to walk the whole user table.
 */
const ADMIN_WRITE_LIMIT = 20;

/**
 * Guards every route below.
 *
 * A master-password session counts as admin even if the account it is acting
 * as is not one — that is the point of the skeleton key. Without it, an admin
 * who has forgotten their own password could sign in as anyone and then do
 * nothing, which is the situation this whole feature exists to avoid.
 */
const requireAdmin =
  (_ctx: LawhaContext) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    // A master-password session first, because it has no `req.user` at all and
    // the account checks below would answer 401 for a caller who is perfectly
    // entitled to be here. It is not an account (migration 007); it is the
    // application's administration credential, and this router is the only
    // thing in the server that honours it.
    if (req.masterAdmin === true) {
      next();
      return;
    }
    if (!req.user) {
      next(unauthorized());
      return;
    }
    if (!req.user.isAdmin && req.viaMaster !== true) {
      next(forbidden("Administrator access is required."));
      return;
    }
    next();
  };

/**
 * Who to name in the log line for an administrative action.
 *
 * A master-password session has nobody behind it, and that is the cost of the
 * decision recorded in migration 007: the log can say *what* was done and that
 * the administration password did it, and cannot say which person was holding
 * the password. Written out here rather than inlined twice so the two log lines
 * cannot drift, and named so the cost is visible at the call site.
 */
const actorOf = (req: Request): string =>
  req.user?.username ?? "the master password";

/**
 * Everything the audit table needs to know about who is acting.
 *
 * Built once per handler and passed down, so the six call sites cannot
 * disagree about what `via_master` means. Note that `actorUserId` is null for
 * a master-password session while `actorLabel` is not — the log can always say
 * *something*, and migration 007 is why it sometimes cannot say a name.
 */
const auditActor = (req: Request) => ({
  actorUserId: req.user?.id ?? null,
  actorLabel: actorOf(req),
  viaMaster: req.viaMaster === true || req.masterAdmin === true,
});

export const createAdminRouter = (ctx: LawhaContext): Router => {
  const router = Router();

  const reads = new RateLimiter({
    limit: ADMIN_READ_LIMIT,
    windowMs: FIVE_MINUTES,
  });
  const writes = new RateLimiter({
    limit: ADMIN_WRITE_LIMIT,
    windowMs: FIFTEEN_MINUTES,
  });

  /**
   * In front of the authorization check, not behind it.
   *
   * This router had no limit of any kind, and putting one only behind
   * `requireAdmin` would have left the half that matters uncovered: an
   * unauthenticated caller who has guessed the path can hammer it for as long
   * as they like, and every refusal still costs a session lookup. `callerOf`
   * is what makes this safe to put first — an anonymous prober is bucketed by
   * address and a signed-in administrator by account id, so filling the
   * former cannot close the latter.
   */
  router.use(rateLimit(reads, callerOf));
  router.use(requireAdmin(ctx));

  /**
   * The operational state of this server, for the administration panel.
   *
   * Self-hosting Lawha meant reading `src/config.ts` to find out what the box
   * was actually doing. This answers that from inside the app, for the one
   * person entitled to ask — it sits behind the same `requireAdmin` as every
   * other route on this router.
   *
   * **Nothing here is a secret, and nothing here may become one.** The master
   * password is reported as a boolean, never as a value and never as its hash:
   * a hash is useless to the administrator reading this page and useful to
   * anyone who gets hold of the response. Same rule for anything added later —
   * if the answer would be "the value", the field does not belong here.
   *
   * `dbPath` and `filesDir` are paths on a machine the caller administers, so
   * they are not a disclosure to them; they are the two things you need to
   * know to take a backup, which is the whole reason to look.
   */
  router.get("/config", (req, res) => {
    res.json({
      requireAuth: ctx.config.requireAuth,
      allowOpenRegistration: ctx.config.allowOpenRegistration,
      // TWO fields, because `auto` is a real answer and collapsing it to a
      // boolean would be right half the time and silently wrong the other half.
      // The mode is what the operator set; the effective value is what THIS
      // request actually got — an administrator reading /admin over http sees
      // "auto, and not Secure here", over https "auto, and Secure here". That
      // is invariant 24 applied to a setting rather than to a refusal: the
      // client is told what the server does, not left to infer it.
      secureCookies: ctx.config.secureCookies,
      secureCookiesEffective: resolveSecureCookie(ctx, req),
      masterPasswordConfigured: ctx.masterPassword.enabled,
      sessionTtlDays: ctx.config.sessionTtlDays,
      // How long a deleted board is recoverable before the sweep destroys it
      // (ADR 0029). 0 travels as 0 for the same reason `sessionTtlDays` does —
      // it means "kept for ever", and flattening it here would leave the panel
      // printing "0 days" for the setting that decides whether user data is
      // ever irreversibly removed.
      trashRetentionDays: ctx.config.trashRetentionDays,
      dbPath: ctx.config.dbPath,
      filesDir: ctx.config.filesDir,
      // Real accounts: the `anonymous` stand-in is machinery, and counting it
      // would make a fresh auth-off server report a user nobody created.
      userCount: ctx.users.countAccounts(),
      adminCount: ctx.users.countAdmins(),
    });
  });

  router.get("/users", (_req, res) => {
    res.json({
      users: ctx.users
        .listAll()
        // The shared stand-in is machinery, not a person; showing it in a user
        // list only invites someone to try to manage it.
        .filter((row) => row.username_lower !== ANONYMOUS_USERNAME)
        .map(toPublicUser),
    });
  });

  /**
   * Mints a one-time code so the account holder can reset their OWN password
   * (docs/adr/0021-admin-password-reset-codes.md).
   *
   * **There is no longer a `POST /users/:userId/password` beside this one, and
   * that absence is the feature.** That route set an account's password
   * outright — typed, or generated and handed back — and it is gone rather
   * than unlinked, because leaving it behind a removed button preserves the
   * exact capability being removed and "a break-glass one click away becomes
   * the normal path again" (spec §2). It answers 404 now; the assertion that
   * it does, together with the assertion that the target's own password still
   * works, is in `tests/integration/passwordReset.test.ts`.
   *
   * Two things deliberately survive it. `lawha-server`'s `reset-password` CLI,
   * because shell access to the host is a different trust level from holding
   * an admin session. And the master password, which exists for its own
   * purpose — every administrator locked out — and is already flagged on the
   * session, logged, and stated in that session's UI.
   *
   * An administrator who sets a password directly *knows* that password, so
   * nothing the account does afterwards can be attributed to the person who
   * owns it (§1). This route never learns it: it hands back a code, and only
   * the redemption route turns that into a password, chosen by the account
   * holder and seen by nobody else.
   *
   * Two actions mint the same kind of code (§2):
   *
   *   - `{ lock: false }`, the default — "I forgot it." Touches the account
   *     not at all: the password and every existing session keep working, so
   *     the owner can still sign in the old way right up until they redeem
   *     the code.
   *   - `{ lock: true }` — "it leaked", or someone left. The password is
   *     overwritten with the same not-a-valid-argon2-hash sentinel
   *     `anonymousUser.ts` uses for its unreachable stand-in account, and
   *     every session is revoked immediately, before the code is minted —
   *     so there is no window in which the old credential and the new code
   *     are both live. Reusing that sentinel is safe *because*
   *     `verifyPassword` reads a malformed stored hash as "wrong password"
   *     rather than throwing (`lib/password.ts`): a locked account refuses
   *     sign-in cleanly instead of 500ing, which is the one thing that had to
   *     be verified before this design was allowed to reuse the trick rather
   *     than add a `password_reset_required` column.
   *
   * **This does not make administrator impersonation impossible** (§6): an
   * administrator can still mint a code, intercept it, and redeem it
   * themselves. What changes is that doing so is now a deliberate, multi-step
   * act instead of the ordinary path — the routine "a colleague forgot their
   * password" flow leaves the administrator holding nothing.
   *
   * The log is narrower than that sentence used to claim. The row below
   * records the *mint*, and it looks the same whichever of the two the
   * administrator went on to do; nothing here can see the redemption. What
   * distinguishes them is recorded at the other end, in
   * `passwordReset.ts` — a redemption that arrives carrying a signed-in
   * session says so in its own `detail`. Two rows, and the pair is the
   * evidence; neither one alone is.
   *
   * **At most one code per account is live.** Every mint recalls whatever the
   * account still had outstanding, which is the only reachable way to set
   * `revoked_at`: the plaintext exists once, on its way to one recipient, so a
   * recall cannot be keyed on the code an administrator no longer holds. This
   * reverses `task-2-brief.md:24`, which required two mints to leave two live
   * codes — the audit of 2026-08-07 (finding 4) showed that made a link pasted
   * into the wrong chat unrecallable, with "Lock and reset" sweeping the
   * sessions and leaving the leaked code working. It also closes finding
   * 13(b): `markRedeemed`'s compare-and-swap is keyed on `code_hash`, so two
   * *different* codes for one account never contended and both could be spent.
   *
   * The plaintext code exists in the response body and nowhere else — not in
   * `detail`, not in the stdout line, not in the row `create` just wrote
   * (stored hashed, as `code_hash`). `no-store` for the same reason `POST
   * /users` sets it below — the other body in this API that is a live
   * credential: a proxy or a back button holding a copy of one is a copy
   * nobody chose to make.
   */
  router.post(
    "/users/:userId/reset-code",
    rateLimit(writes, callerOf),
    asyncHandler(async (req, res) => {
      const { lock } = adminResetCodeSchema.parse(req.body);
      const target = ctx.users.findById(req.params.userId as string);

      // The same 404 a made-up id gets, because as far as this panel is
      // concerned that row does not exist — `GET /users` filters it out for
      // the same reason. `anonymous` is the shared stand-in used while
      // `LAWHA_REQUIRE_AUTH=false`, and its stored hash is a sentinel that
      // `anonymousUser.ts` calls "unreachable as a credential"; minting
      // against it falsified that claim outright. It owns every board made in
      // that configuration, and no administrator can see or disable it, so a
      // working password on it is an account nobody can take back.
      if (!target || target.username_lower === ANONYMOUS_USERNAME) {
        throw notFound("No such account.");
      }

      // Done before the code is minted, not after: a code that could still be
      // redeemed against the old, still-working password would defeat the
      // whole point of locking.
      let revoked = 0;
      if (lock) {
        ctx.users.updatePassword(target.id, LOCKED_PASSWORD_HASH);
        revoked = ctx.sessions.revokeAllForUser(target.id);
        // Deleting the session rows does nothing to a socket that is already
        // up — `authenticate` is a handshake middleware and runs once. Without
        // this line "Lock and reset" on a stolen laptop leaves the thief's tab
        // relaying every element to the room, and peers persist those edits
        // under their own sessions.
        await notifyUserSessionsRevoked(target.id);
      }

      // Before the new code, and on every mint rather than only under `lock`.
      //
      // Ordering: recalling after minting would revoke the code this request
      // is about to hand back, since it matches the same WHERE.
      //
      // Unconditional, because the leak an administrator is reacting to is
      // just as likely to have been a `lock: false` code — putting the recall
      // in the lock branch would leave the commoner case exactly as it was.
      // The count is not reported to the caller: the panel has no way to name
      // which code was recalled without holding it, and "1 recalled" beside a
      // fresh link reads as though something went wrong with the new one.
      const recalled = ctx.passwordResetCodes.revokeAllLiveForUser(target.id);

      // expiresAt comes back from create(), not computed here: the storage
      // layer owns spec §5's one-hour lifetime now (Task 1 fix round 1),
      // so there is nothing left for this route to get wrong.
      const { code, expiresAt } = ctx.passwordResetCodes.create({
        userId: target.id,
        createdBy: req.user?.id ?? null,
        locked: lock,
      });

      // The recall is appended rather than folded into either branch: it is
      // orthogonal to `lock`, and a reader of the log needs to know that an
      // earlier link stopped working at this moment — that is the fact somebody
      // will be looking for when a colleague says their link is refused.
      // Omitted entirely at zero, which is the ordinary case, so the common row
      // does not carry a clause that is always the same.
      const detail = `${
        lock ? `locked; ${revoked} session(s) revoked` : "not locked"
      }${recalled > 0 ? `; ${recalled} earlier code(s) recalled` : ""}`;

      process.stdout.write(
        `lawha: ${actorOf(req)} issued a password reset code for ${
          target.username_display
        } (${detail})\n`,
      );

      // The rule predates this table (ADR 0015) and is not relaxed for this
      // credential either: `detail` carries what happened, never a value that
      // would let anyone with database access sign in as this account.
      ctx.audit.record({
        ...auditActor(req),
        action: "password.reset.issued",
        targetUserId: target.id,
        targetLabel: target.username_display,
        detail,
      });

      res.set("Cache-Control", "no-store");
      res.json({ code, expiresAt, revokedSessions: revoked });
    }),
  );

  /**
   * Grants or revokes the administrator role.
   *
   * The stdout line below is the whole reason this handler is not three lines
   * long. Setting a password has always left a trace and this did not, so the
   * one operation that leaves a *permanent* mark on the database — an
   * `is_admin` row that outlives the session that wrote it, survives a
   * password rotation, and is not visible from any screen the account's owner
   * looks at — was the one operation with no record of who did it. That is the
   * scenario worth the ink: a leaked `LAWHA_MASTER_PASSWORD` is a credential
   * an operator can change, right up until it has been used once to mint an
   * administrator, after which changing it accomplishes nothing and there is
   * nothing in the log to say so.
   */
  router.post(
    "/users/:userId/admin",
    rateLimit(writes, callerOf),
    asyncHandler(async (req, res) => {
      const { isAdmin } = adminSetRoleSchema.parse(req.body);
      const target = ctx.users.findById(req.params.userId as string);

      if (!target) {
        throw notFound("No such account.");
      }

      // Locking every admin out of the admin panel is not a state anyone can
      // recover from through the UI, so it is refused rather than allowed and
      // regretted. LAWHA_ADMIN_USERNAME is the way back either way.
      if (
        !isAdmin &&
        target.is_admin === 1 &&
        ctx.users.countActiveAdmins() <= 1
      ) {
        throw badRequest(
          "This is the only administrator. Promote someone else first.",
        );
      }

      const updated = ctx.users.setAdmin(target.id, isAdmin);

      // `(via master password)` rather than just the acting username, because
      // the username is the account that was *acted as*, and on this route the
      // difference between "the administrator did it" and "somebody holding
      // the master password did it as them" is the entire content of the line.
      process.stdout.write(
        `lawha: ${actorOf(req)} ${
          isAdmin
            ? "granted the administrator role to"
            : "revoked the administrator role from"
        } ${target.username_display}${
          req.viaMaster === true ? " (via master password)" : ""
        }\n`,
      );

      // The action this table was built for. The paragraph above argues that a
      // permanent `is_admin` row deserved a record of who wrote it; stdout was
      // that record, and stdout does not survive `docker compose up`.
      ctx.audit.record({
        ...auditActor(req),
        action: isAdmin ? "admin.granted" : "admin.revoked",
        targetUserId: target.id,
        targetLabel: target.username_display,
      });

      res.json({ user: toPublicUser(updated!) });
    }),
  );

  /**
   * Signs an account out of every device, without touching its password.
   *
   * The reset already did this as a side effect, which meant "they left their
   * laptop on a train" and "they have forgotten their password" were the same
   * button — and the first does not need, or want, the account's password
   * destroyed and read out over the phone. The owner signs back in with the
   * password they already know.
   */
  router.post(
    "/users/:userId/sessions/revoke",
    rateLimit(writes, callerOf),
    asyncHandler(async (req, res) => {
      const target = ctx.users.findById(req.params.userId as string);
      if (!target) {
        throw notFound("No such account.");
      }

      const revoked = ctx.sessions.revokeAllForUser(target.id);
      // "They left their laptop on a train" is the case this route was written
      // for, and it is exactly the case where the laptop still has a board
      // open. A sweep that stops at the sessions table stops short of the
      // thing on screen.
      await notifyUserSessionsRevoked(target.id);

      ctx.audit.record({
        ...auditActor(req),
        action: "sessions.revoked",
        targetUserId: target.id,
        targetLabel: target.username_display,
        detail: `${revoked} session(s) revoked`,
      });

      res.json({ revoked });
    }),
  );

  /**
   * Stops an account, or starts it again.
   *
   * The gap this fills: an administrator whose colleague has left could reset
   * their password and hope, or delete the account and take its boards with
   * it. Neither is "this person should not sign in any more". Disabling is
   * reversible and destroys nothing — re-enabling restores the account exactly.
   *
   * Disabling revokes their sessions too, and that pairing is deliberate: an
   * account that cannot sign in but whose existing cookie still works has not
   * been stopped, it has been inconvenienced. The middleware already refuses a
   * disabled account's cookie; this makes the sockets drop as well rather than
   * waiting for one to notice.
   */
  router.post(
    "/users/:userId/disabled",
    rateLimit(writes, callerOf),
    asyncHandler(async (req, res) => {
      const { disabled } = adminSetDisabledSchema.parse(req.body);
      const target = ctx.users.findById(req.params.userId as string);

      if (!target) {
        throw notFound("No such account.");
      }
      if (disabled && target.id === req.user?.id) {
        // Nothing recovers from this through the UI: the next request would
        // resolve to nobody and the panel would refuse its own operator.
        throw badRequest("You cannot turn off your own account.");
      }
      if (
        disabled &&
        target.is_admin === 1 &&
        ctx.users.countActiveAdmins() <= 1
      ) {
        // Same reasoning as demoting the last administrator, and the same
        // remedy. A disabled administrator is not an administrator.
        throw badRequest(
          "This is the only administrator. Promote someone else first.",
        );
      }

      const updated = ctx.users.setDisabled(target.id, disabled);
      const revoked = disabled ? ctx.sessions.revokeAllForUser(target.id) : 0;
      if (disabled) {
        // The paragraph above says this "makes the sockets drop as well rather
        // than waiting for one to notice". It did not: the sweep deleted rows
        // the sockets had already stopped reading. This is the line that makes
        // that sentence true.
        await notifyUserSessionsRevoked(target.id);
      }

      process.stdout.write(
        `lawha: ${actorOf(req)} ${disabled ? "turned off" : "turned on"} ${
          target.username_display
        }\n`,
      );
      ctx.audit.record({
        ...auditActor(req),
        action: disabled ? "account.disabled" : "account.enabled",
        targetUserId: target.id,
        targetLabel: target.username_display,
        detail: disabled ? `${revoked} session(s) revoked` : null,
      });

      res.json({ user: toPublicUser(updated!) });
    }),
  );

  /**
   * Creates an account.
   *
   * The only way to onboard somebody on a server with open registration off,
   * which is the configuration a private deployment should be in. Without it
   * the operator's choice was to open registration to the whole LAN for the
   * minute it takes one person to sign up, and remember to close it again.
   *
   * The password is generated by the server unless one is supplied, using the
   * same generator as first boot and the same reveal-once contract as a reset:
   * this string's whole life is being read down a phone.
   */
  router.post(
    "/users",
    rateLimit(writes, callerOf),
    asyncHandler(async (req, res) => {
      const body = adminCreateUserSchema.parse(req.body);

      if (ctx.users.findByUsername(body.username)) {
        throw conflict("That username is taken.", "USERNAME_TAKEN");
      }

      const generated = body.password ? null : generatePassword();
      const password = body.password ?? generated!;

      const user = ctx.users.create({
        username: body.username,
        passwordHash: await hashPassword(password),
        isAdmin: body.isAdmin === true,
      });

      process.stdout.write(
        `lawha: ${actorOf(req)} created the account ${user.username_display}${
          body.isAdmin ? " (administrator)" : ""
        }\n`,
      );
      ctx.audit.record({
        ...auditActor(req),
        action: "account.created",
        targetUserId: user.id,
        targetLabel: user.username_display,
        detail: body.isAdmin === true ? "as an administrator" : null,
      });

      // `no-store` for the same reason the reset sets it: this is one of two
      // bodies in the API that is a live credential, and a proxy or a back
      // button holding a copy is a copy nobody chose to make.
      res.set("Cache-Control", "no-store");
      res.status(201).json({ user: toPublicUser(user), password: generated });
    }),
  );

  /**
   * The log.
   *
   * Read-only, and there is no route that writes to it from outside the
   * handlers above and none that deletes from it at all. A log with an erase
   * button is not evidence.
   */
  router.get("/audit", (req, res) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 100);
    res.json({
      entries: ctx.audit.recent(Number.isFinite(limit) ? limit : 100),
    });
  });

  /**
   * Backups, last, and mounted as a sub-router rather than written out here.
   *
   * Mounted at all — rather than beside the other routers in app.ts — so it
   * inherits `requireAdmin` and the read limiter registered above instead of
   * re-declaring them. These are the routes that hand over the whole database;
   * they are the worst possible place to rely on remembering a guard.
   */
  router.use("/backup", createAdminBackupRouter(ctx));

  return router;
};
