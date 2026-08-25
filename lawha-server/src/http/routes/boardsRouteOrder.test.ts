import { describe, expect, it } from "vitest";

import { createBoardsRouter } from "./boards.js";

import type { LawhaContext } from "../../context.js";
import type { Router } from "express";

/**
 * Route ordering, pinned (ADR 0029).
 *
 * One thing is asserted here and it is not covered anywhere else: `GET /trash`
 * is registered **before** `GET /:boardId`. Express matches layers in
 * registration order, so with those two the other way round every request for
 * the trash is answered by the board handler with `boardId = "trash"`, which
 * resolves no permission for an id nobody owns and refuses — a fully working
 * feature that reports itself as missing, from a one-line move with no type
 * error and no other symptom.
 *
 * Read off the router's own layer stack rather than driven over HTTP. There is
 * no request-level harness in this server, and building one to establish a fact
 * about *registration order* would test it through four things that could each
 * fail for their own reasons. The stack is where the ordering literally lives.
 */

/**
 * Only the fields `createBoardsRouter` touches while it is *building* — none of
 * the handlers run here. Cast rather than mocked for that reason: a stub with
 * real methods would suggest this file exercises them.
 */
const ctx = {
  config: { trashRetentionMs: 0, trashRetentionDays: 0 },
} as unknown as LawhaContext;

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

const pathsFor = (router: Router, method: string): string[] =>
  (router.stack as Layer[])
    .filter((layer) => layer.route?.methods[method])
    .map((layer) => layer.route!.path);

describe("the boards router", () => {
  it("registers GET /trash before GET /:boardId", () => {
    const gets = pathsFor(createBoardsRouter(ctx), "get");

    const trash = gets.indexOf("/trash");
    const byId = gets.indexOf("/:boardId");

    expect(trash).toBeGreaterThanOrEqual(0);
    expect(byId).toBeGreaterThanOrEqual(0);
    expect(trash).toBeLessThan(byId);
  });

  it("keeps the trash routes on the paths the client calls", () => {
    const router = createBoardsRouter(ctx);

    expect(pathsFor(router, "get")).toContain("/trash");
    expect(pathsFor(router, "post")).toContain("/:boardId/restore");
    expect(pathsFor(router, "delete")).toContain("/:boardId/permanent");
    // The soft delete keeps its path. A client that has not been rebuilt still
    // deletes boards; it simply cannot reach the trash.
    expect(pathsFor(router, "delete")).toContain("/:boardId");
  });
});
