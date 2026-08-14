import { SESSION_COOKIE_NAME } from "../../config.js";
import { isAccountActive, toPublicUser } from "../../db/repositories/users.js";

import type { LawhaContext } from "../../context.js";
import type { PublicUser } from "../../db/repositories/users.js";
import type { NextFunction, Request, Response } from "express";

declare module "express-serve-static-core" {
  interface Request {
    user?: PublicUser;
    sessionToken?: string;
    /** True when this session was opened with the master password. */
    viaMaster?: boolean;
    /**
     * A master-password administration session, which is NOT an account.
     *
     * `req.user` stays undefined when this is true, and that is the whole
     * safety property: every board, folder, tag, scene and file route already
     * refuses a caller with no user, so an administration session cannot reach
     * one without somebody deliberately adding a check for this flag. Only
     * `requireAdmin` looks at it.
     */
    masterAdmin?: boolean;
    /** The raw admin-session token, so logout can revoke it. */
    adminSessionToken?: string;
  }
}

/**
 * A cookie of its own, beside the account one.
 *
 * Two cookies rather than one overloaded value, because the two sessions have
 * genuinely different lifetimes and different revocation rules — an account
 * session outlives the browser, an administration session expires in twelve
 * hours and cannot be rolled forward — and because somebody signed into their
 * own account may also be holding the master password. Folding them together
 * would mean the second sign-in silently ended the first.
 */
export const ADMIN_SESSION_COOKIE_NAME = "lawha_admin";

/** Minimal cookie parsing — the only cookie we care about is our own. */
export const parseCookies = (
  header: string | undefined,
): Map<string, string> => {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) {
      cookies.set(name, decodeURIComponent(value));
    }
  }
  return cookies;
};

export const readSessionToken = (
  cookieHeader: string | undefined,
): string | null => parseCookies(cookieHeader).get(SESSION_COOKIE_NAME) ?? null;

export const readAdminSessionToken = (
  cookieHeader: string | undefined,
): string | null =>
  parseCookies(cookieHeader).get(ADMIN_SESSION_COOKIE_NAME) ?? null;

/**
 * Whether THIS response's cookies carry `Secure`.
 *
 * The single place the three-valued `LAWHA_SECURE_COOKIES` becomes a boolean,
 * because a second place would be a second thing to remember: `Secure` on a
 * plain-http origin does not error, it makes the browser accept the cookie,
 * discard it, and sign the person out for ever with nothing in any log. Every
 * cookie this server sets goes through here.
 *
 * `req.secure` is Express's answer, derived from `trust proxy`
 * (`LAWHA_TRUST_PROXY_HOPS`) and the `X-Forwarded-Proto` that
 * `docker/nginx.conf` forwards on all three proxy blocks. It is therefore
 * wrong in exactly one case — a proxy that does not set that header — which is
 * why `always` and `never` remain available as explicit overrides.
 */
export const resolveSecureCookie = (
  ctx: LawhaContext,
  req: Request,
): boolean => {
  switch (ctx.config.secureCookies) {
    case "always":
      return true;
    case "never":
      return false;
    default:
      return req.secure;
  }
};

export const buildSessionCookie = (
  ctx: LawhaContext,
  req: Request,
  token: string,
  expiresAt: number,
): string => {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    // Lax, not Strict: clicking a shared /b/<id> link from chat is a cross-site
    // top-level GET, and Strict would drop the cookie and show a signed-out page.
    "SameSite=Lax",
    `Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`,
  ];
  if (resolveSecureCookie(ctx, req)) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
};

/**
 * `SameSite=Strict`, unlike the account cookie.
 *
 * The account cookie is `Lax` because clicking a shared `/b/<id>` link from a
 * chat window is a cross-site top-level GET and `Strict` would drop it and show
 * a signed-out page. Nothing ever links to `/admin` from anywhere, so that
 * argument does not apply, and `Strict` is the stronger choice for the one
 * cookie that opens the administration panel.
 */
export const buildAdminSessionCookie = (
  ctx: LawhaContext,
  req: Request,
  token: string,
  expiresAt: number,
): string => {
  const attributes = [
    `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`,
  ];
  if (resolveSecureCookie(ctx, req)) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
};

/**
 * The cleared cookies carry the same attributes as the ones they replace,
 * `Secure` included. That is not symmetry for its own sake: a browser matches a
 * Set-Cookie against an existing cookie on name, Path and Domain, and a
 * mismatch on Secure is one of the ways a deletion silently does not delete.
 * Sharing `resolveSecureCookie` is what keeps them from drifting apart.
 */
export const buildClearedAdminSessionCookie = (
  ctx: LawhaContext,
  req: Request,
): string => {
  const attributes = [
    `${ADMIN_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (resolveSecureCookie(ctx, req)) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
};

export const buildClearedSessionCookie = (
  ctx: LawhaContext,
  req: Request,
): string => {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (resolveSecureCookie(ctx, req)) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
};

/**
 * Mints a session for `userId` and puts its cookie on the response.
 *
 * Extracted from the closure that used to live inside `createAuthRouter`
 * (`routes/auth.ts`), because `POST /api/auth/reset/:code` needs exactly this
 * and lives in a different router — somebody redeeming a reset code holds no
 * session, and the entire point of that route is that they leave holding one.
 * Copied rather than extracted, the four lines would have been two places to
 * remember the day `via_master` or the cookie shape changes, which is the same
 * drift `buildSessionCookie` above was itself extracted to prevent.
 *
 * It lives here rather than in a route file because everything it touches is
 * here: the repository's `CreatedSession` on one side and `buildSessionCookie`
 * on the other. `res.append` rather than `res.setHeader`, deliberately —
 * `sessionMiddleware` below may already have queued a refreshed cookie, and
 * `/logout` queues two.
 *
 * **Ordering hazard for every caller.** If the caller also revokes that
 * account's sessions, the revocation must run BEFORE this, or it deletes the
 * row this just wrote and the person is signed straight back out. Nothing
 * about that failure is visible from the server; it presents as "signing in
 * did not sign me in". `routes/passwordReset.ts` states the same warning at
 * the one call site where the two operations meet.
 */
export const startSession = (
  ctx: LawhaContext,
  req: Request,
  res: Response,
  userId: string,
  userAgent?: string,
  viaMaster = false,
): void => {
  const { token, expiresAt } = ctx.sessions.create(
    userId,
    userAgent,
    viaMaster,
  );
  res.append("Set-Cookie", buildSessionCookie(ctx, req, token, expiresAt));
};

/** Resolves the session cookie onto req.user. Never rejects. */
export const sessionMiddleware =
  (ctx: LawhaContext) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const token = readSessionToken(req.headers.cookie);

    if (token) {
      const resolved = ctx.sessions.resolve(token);
      if (resolved) {
        const user = ctx.users.findById(resolved.session.user_id);
        // A disabled account resolves to nobody, so a live cookie stops
        // working the moment the account is stopped rather than when it
        // expires. One of three places this is checked — see `isAccountActive`
        // and invariant 21; the other two are the login route and the socket
        // authenticator below.
        if (user && isAccountActive(user)) {
          req.user = toPublicUser(user);
          req.sessionToken = token;
          req.viaMaster = resolved.session.via_master === 1;
          if (resolved.refreshed) {
            res.append(
              "Set-Cookie",
              buildSessionCookie(ctx, req, token, resolved.session.expires_at),
            );
          }
        }
      }
    }

    // Read independently of the account session above, and deliberately not in
    // an `else`: somebody signed into their own account may also be holding the
    // master password, and the two answers are about different things.
    const adminToken = readAdminSessionToken(req.headers.cookie);
    if (adminToken && ctx.adminSessions.resolve(adminToken)) {
      req.masterAdmin = true;
      req.adminSessionToken = adminToken;
    }

    next();
  };

/** Resolves a cookie header to a socket user, for the socket.io handshake. */
export const createSocketAuthenticator =
  (ctx: LawhaContext) =>
  async (
    cookieHeader: string | undefined,
  ): Promise<{ id: string; username: string } | null> => {
    const token = readSessionToken(cookieHeader);
    if (!token) {
      return null;
    }
    const resolved = ctx.sessions.resolve(token);
    if (!resolved) {
      return null;
    }
    const user = ctx.users.findById(resolved.session.user_id);
    // Same rule as the HTTP path: a stopped account is nobody. Without this, a
    // person already sitting in a board would keep drawing on it until their
    // socket happened to drop.
    return user && isAccountActive(user)
      ? { id: user.id, username: user.username_display }
      : null;
  };
