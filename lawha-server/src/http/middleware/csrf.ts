import { forbidden } from "./errors.js";

import type { LawhaContext } from "../../context.js";
import type { NextFunction, Request, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * With a SameSite=Lax session cookie on a single origin, the residual CSRF
 * surface is small. Two cheap checks close it without the ceremony of a
 * double-submit token:
 *
 *  1. Sec-Fetch-Site must not be cross-site (absent on older clients).
 *  2. If Origin is present, it must match an allowed origin or the Host.
 */
export const csrfMiddleware =
  (ctx: LawhaContext) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const fetchSite = req.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite === "cross-site") {
      next(forbidden("Cross-site request blocked."));
      return;
    }

    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "null") {
      const allowed = ctx.config.allowedOrigins;
      const matchesConfigured = allowed?.includes(origin) ?? false;
      const matchesHost = (() => {
        try {
          return new URL(origin).host === req.headers.host;
        } catch {
          return false;
        }
      })();

      if (!matchesConfigured && !matchesHost) {
        next(forbidden("Request origin not allowed."));
        return;
      }
    }

    next();
  };
