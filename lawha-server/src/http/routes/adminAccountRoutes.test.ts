import { describe, expect, it } from "vitest";

import { createAdminRouter } from "./admin.js";

import type { LawhaContext } from "../../context.js";
import type { Router } from "express";

/**
 * The shape of the account-deletion routes (ADR 0031).
 *
 * Read off the router's own layer stack rather than driven over HTTP, matching
 * `boardsRouteOrder.test.ts`: there is no request-level harness in this
 * server, and building one to establish facts about *registration* would test
 * them through four things that can each fail for their own reasons.
 *
 * What this pins is that the routes exist on the paths the client calls, and —
 * more importantly — that they sit behind the router-level `requireAdmin` and
 * carry their own write rate limiter. A delete route that shipped on the read
 * limiter would allow 120 irreversible actions per five minutes instead of 20.
 */

/**
 * Only the fields `createAdminRouter` reads while it is *building* — no
 * handler runs here. `dbPath` is needed because the backup sub-router derives
 * a snapshot directory from it at construction time.
 */
const ctx = {
  config: {
    dbPath: "/tmp/lawha-route-shape/lawha.db",
    filesDir: "/tmp/lawha-route-shape/files",
    trashRetentionMs: 0,
    trashRetentionDays: 0,
    secureCookies: "auto",
  },
  masterPassword: { enabled: false },
} as unknown as LawhaContext;

interface Layer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { name: string }[];
  };
}

const routeFor = (router: Router, method: string, path: string) =>
  (router.stack as Layer[]).find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  )?.route;

describe("the admin account routes", () => {
  const router = createAdminRouter(ctx);

  it("registers delete and restore where the client calls them", () => {
    expect(routeFor(router, "delete", "/users/:userId")).toBeDefined();
    expect(routeFor(router, "post", "/users/:userId/restore")).toBeDefined();
  });

  it("does not shadow the existing user routes", () => {
    // `/users/:userId/restore` is a longer path than `/users/:userId`, and
    // express matches on the full path rather than a prefix, so neither can
    // swallow the other. Pinned because "add the delete beside the others"
    // is the kind of change that gets made without checking.
    expect(routeFor(router, "post", "/users/:userId/admin")).toBeDefined();
    expect(routeFor(router, "post", "/users/:userId/disabled")).toBeDefined();
    expect(routeFor(router, "post", "/users")).toBeDefined();
    expect(routeFor(router, "get", "/users")).toBeDefined();
  });

  it("puts both new routes behind a write rate limiter, not the read one", () => {
    // Two handlers on the layer: the limiter, then the async handler. A route
    // registered without its own limiter has one, and inherits the router's
    // read budget of 120 per five minutes — six times the write budget, for
    // the one action in the panel that cannot be undone.
    expect(routeFor(router, "delete", "/users/:userId")!.stack).toHaveLength(2);
    expect(
      routeFor(router, "post", "/users/:userId/restore")!.stack,
    ).toHaveLength(2);

    // The same shape the existing destructive routes have.
    expect(
      routeFor(router, "post", "/users/:userId/disabled")!.stack,
    ).toHaveLength(2);
  });

  it("guards the whole router, so neither route can be reached unauthenticated", () => {
    // `requireAdmin` and the read limiter are mounted with `router.use` before
    // any route, so they appear as routeless layers at the head of the stack.
    const leading = (router.stack as Layer[]).findIndex(
      (layer) => layer.route !== undefined,
    );
    expect(leading).toBeGreaterThanOrEqual(2);
  });
});
