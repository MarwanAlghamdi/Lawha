import { toPublicUser } from "../../db/repositories/users.js";
import { resolveAnonymousUser } from "../../lib/anonymousUser.js";
import { GUEST_COOKIE_NAME, guestPrincipal } from "../../lib/guests.js";

import { unauthorized } from "./errors.js";
import { parseCookies } from "./session.js";

import type { LawhaContext } from "../../context.js";
import type { GuestRecord } from "../../lib/guests.js";
import type { Principal } from "../../socket/authz.js";
import type { NextFunction, Request, Response } from "express";

declare module "express-serve-static-core" {
  interface Request {
    /** Set only on routes that opted into `allowGuest`. Never an account. */
    guest?: GuestRecord;
  }
}

export interface RequireAuthOptions {
  /**
   * Lets a server-minted, board-scoped guest through.
   *
   * Off by default, and deliberately opt-in per route: a guest must never
   * reach a mutating endpoint, and "refused unless named" is the only version
   * of that rule which survives someone adding a route later.
   */
  allowGuest?: boolean;
}

/**
 * Guards authenticated routes.
 *
 * When `LAWHA_REQUIRE_AUTH=false` an anonymous user is materialised on first
 * use so the canvas and collaboration are usable before anyone has signed up.
 * `true` is the default; this is an opt-in affordance and is logged as such.
 */
export const requireAuth =
  (ctx: LawhaContext, options: RequireAuthOptions = {}) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (req.user) {
      next();
      return;
    }

    if (options.allowGuest) {
      const token = parseCookies(req.headers.cookie).get(GUEST_COOKIE_NAME);
      const guest = ctx.guests.resolve(token);
      if (guest) {
        // Note what is *not* set: `req.user`. A guest is not an account, so
        // anything reading `req.user!.id` should fail loudly rather than
        // quietly treat a visitor as one.
        req.guest = guest;
        next();
        return;
      }
    }

    if (ctx.config.requireAuth) {
      next(unauthorized());
      return;
    }

    // Built through toPublicUser rather than by hand, so a new column added to
    // PublicUser cannot silently go missing on the anonymous path.
    req.user = toPublicUser(resolveAnonymousUser(ctx));
    next();
  };

/**
 * The identity to authorize with, account or guest.
 *
 * Board checks go through this rather than `req.user!.id`, because the guest
 * branch above leaves `req.user` undefined on purpose.
 */
export const principalOf = (req: Request): Principal => {
  if (req.user) {
    return { id: req.user.id };
  }
  if (req.guest) {
    return guestPrincipal(req.guest);
  }
  // Unreachable behind `requireAuth`; an id nothing can match, so a bypass
  // fails closed rather than open.
  return { id: "", isGuest: true, guestBoardId: null };
};
