import path from "node:path";

import express from "express";

import { csrfMiddleware } from "./middleware/csrf.js";
import { errorMiddleware, notFound } from "./middleware/errors.js";
import { sessionMiddleware } from "./middleware/session.js";
import { createAdminRouter } from "./routes/admin.js";
import { createAuthRouter } from "./routes/auth.js";
import { createBoardsRouter } from "./routes/boards.js";
import { createFilesRouter } from "./routes/files.js";
import { createFoldersRouter } from "./routes/folders.js";
import { createInvitesRouter } from "./routes/invites.js";
import { createPasswordResetRouter } from "./routes/passwordReset.js";
import { createSceneRouter } from "./routes/scene.js";
import { createTagsRouter } from "./routes/tags.js";
import { createUsersRouter } from "./routes/users.js";

import type { LawhaContext } from "../context.js";
import type { Express } from "express";

export const createApp = (ctx: LawhaContext): Express => {
  const app = express();

  // A COUNT of trusted hops, never `true`.
  //
  // `true` trusts the whole X-Forwarded-For chain, and Express then takes the
  // LEFT-MOST entry as `req.ip`. The left-most entry is whatever the client
  // wrote: `curl -H 'X-Forwarded-For: <anything>'`. So the per-IP limits —
  // 40 sign-ups an hour, 60 sign-in attempts a quarter hour — became a bucket
  // the attacker chooses, a fresh one per request. Decorative, not enforced.
  //
  // A count fixes that because nginx APPENDS: `$proxy_add_x_forwarded_for` is
  // the incoming header plus `$remote_addr`, so the LAST entry is an address
  // nginx observed rather than one the client asserted. Trusting one hop makes
  // that last entry `req.ip`, and no header a client sends can move it.
  //
  // 1 is right for the supplied stack, where nginx is the only thing that can
  // reach this process (`expose: 3002`, never published). Add a hop for every
  // additional proxy that appends its own entry — a LAN gateway in front of
  // nginx that forwards XFF is 2. Get it too LOW and everyone behind that
  // gateway shares one bucket, so one person fumbling a password locks the
  // whole LAN out for fifteen minutes; too HIGH and you are back to trusting
  // a client-written entry. There is no safe "just use true".
  app.set("trust proxy", ctx.config.trustProxyHops);
  app.disable("x-powered-by");

  app.use(sessionMiddleware(ctx));
  app.use(csrfMiddleware(ctx));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/metrics", (_req, res) => {
    res.type("text/plain; version=0.0.4").send(ctx.metrics.render());
  });

  // JSON parsing is scoped to the routes that take JSON; the scene and file
  // routes read raw octet-stream bodies and must not be pre-consumed.
  app.use("/api/auth", express.json({ limit: "64kb" }), createAuthRouter(ctx));
  // A second router on the same path, the shape `/api/boards` already uses
  // below. Redemption is unauthenticated and has its own rate limit, and
  // `routes/auth.ts` is 700 lines in which every branch of `/login` exists to
  // keep that route blind to which usernames exist — an unrelated handler in
  // there is one somebody has to reason about against that constraint for
  // ever. The json parser is repeated rather than relied on from the mount
  // above: body-parser skips a request it has already parsed, so it costs
  // nothing today, and it means this router does not silently depend on the
  // other one's middleware surviving a reorder.
  app.use(
    "/api/auth",
    express.json({ limit: "64kb" }),
    createPasswordResetRouter(ctx),
  );
  app.use(
    "/api/admin",
    express.json({ limit: "64kb" }),
    createAdminRouter(ctx),
  );
  app.use(
    "/api/boards",
    express.json({ limit: "256kb" }),
    createBoardsRouter(ctx),
  );
  app.use("/api/boards", createSceneRouter(ctx));
  app.use("/api/tags", express.json({ limit: "64kb" }), createTagsRouter(ctx));
  app.use(
    "/api/folders",
    express.json({ limit: "64kb" }),
    createFoldersRouter(ctx),
  );
  // Spending a code, as opposed to minting one. Deliberately NOT under
  // `/api/boards`: whoever is redeeming has no access to the board yet, so
  // there is no board-scoped gate they could pass (ADR 0014).
  app.use(
    "/api/invites",
    express.json({ limit: "16kb" }),
    createInvitesRouter(ctx),
  );
  // Raw image bytes, so no JSON parser here.
  app.use("/api/files", createFilesRouter(ctx));
  // Avatars are raw image bytes, so no JSON parser here either.
  app.use("/api/users", createUsersRouter(ctx));

  /**
   * Anything under `/api` that no router above claimed. MUST stay below every
   * one of them and above `errorMiddleware`.
   *
   * Without it the request reaches no handler at all: `errorMiddleware` takes
   * four arguments, so Express treats it as an error handler and skips it on
   * the normal path, and the SPA fallback deliberately excludes `/api/`. What
   * answers instead is Express's built-in finalhandler, in `text/html`. Every
   * client call here does `response.json()`, so the operator sees
   *
   *     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
   *
   * which names neither the endpoint nor the status, and reads as a bug in
   * whatever screen was open. Reported live on this deployment.
   *
   * Two of the ways to reach it are ours: a tab holding a cached bundle that
   * still calls a route since removed (`POST /api/admin/users/:userId/password`
   * went in the reset-code release), and a path typo in a client call.
   *
   * `next(...)` rather than `res.json(...)` so the shape comes from the one
   * place that owns it — a second hand-rolled error body is how the two drift.
   */
  app.use("/api", (_req, _res, next) => {
    next(notFound("No such endpoint.", "NO_SUCH_ENDPOINT"));
  });

  app.use(errorMiddleware);

  if (ctx.config.staticDir) {
    serveApp(app, ctx.config.staticDir);
  }

  return app;
};

/**
 * Serves the built SPA alongside the API.
 *
 * The alternative — Vite's dev server — hands the browser ~885 separate module
 * requests. On localhost that is 2 seconds; across a WireGuard link each one
 * pays the round trip and the canvas takes the best part of a minute to appear.
 * The built bundle is a handful of files.
 *
 * Mounted after the API routes and after the error middleware, so nothing here
 * can shadow `/api`, and an API error still renders as JSON rather than falling
 * through to index.html.
 */
const serveApp = (app: express.Express, staticDir: string): void => {
  app.use(
    express.static(staticDir, {
      // Asset filenames carry a content hash, so they can never go stale.
      // index.html must not be cached or a deploy would never be picked up.
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else if (/[.-][a-zA-Z0-9_-]{8,}\.\w+$/.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  // SPA fallback. /signin, /account and /b/<id> are client routes with nothing
  // on disk behind them, so anything that is not an API call and not a real
  // file gets the shell. Scoped to GET so a stray POST 404s honestly.
  app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
};
