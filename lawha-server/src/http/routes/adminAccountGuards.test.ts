import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../db/index.js";
import { AuditRepository } from "../../db/repositories/audit.js";
import { BoardsRepository } from "../../db/repositories/boards.js";
import { SessionsRepository } from "../../db/repositories/sessions.js";
import { UsersRepository } from "../../db/repositories/users.js";

import { createAdminRouter } from "./admin.js";

import type { LawhaContext } from "../../context.js";
import type { Router } from "express";

/**
 * The four refusals on `DELETE /api/admin/users/:userId` (ADR 0031).
 *
 * The handler is pulled off the router's layer stack and called directly with
 * a fake request, against a **real** in-memory database. There is no
 * request-level harness in this server, and the alternative — asserting these
 * rules by reading the source — is not a test.
 *
 * These four are the whole safety of the feature. Three of them refuse an
 * action that cannot be undone, and the fourth is the only thing standing
 * between an administrator and deleting the account next to the one they
 * meant.
 */

interface Layer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: Handler }[];
  };
}
type Handler = (
  req: unknown,
  res: unknown,
  next: (err?: unknown) => void,
) => unknown;

interface Harness {
  ctx: LawhaContext;
  router: Router;
  adminId: string;
}

let h: Harness;

const makeHarness = (): Harness => {
  const db = openDatabase({ path: ":memory:" });
  const users = new UsersRepository(db);
  const ctx = {
    users,
    boards: new BoardsRepository(db),
    sessions: new SessionsRepository(db, 0),
    audit: new AuditRepository(db),
    config: {
      dbPath: "/tmp/lawha-guards/lawha.db",
      filesDir: "/tmp/lawha-guards/files",
      trashRetentionMs: 30 * 24 * 60 * 60 * 1000,
      trashRetentionDays: 30,
      secureCookies: "auto",
    },
    masterPassword: { enabled: false },
  } as unknown as LawhaContext;

  const admin = users.create({
    username: "boss",
    passwordHash: "x",
    isAdmin: true,
  });

  return { ctx, router: createAdminRouter(ctx), adminId: admin.id };
};

/** The last handler on the route — past the rate limiter. */
const handlerFor = (router: Router, method: string, path: string): Handler => {
  const route = (router.stack as Layer[]).find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  )?.route;
  if (!route) {
    throw new Error(`no ${method} ${path}`);
  }
  return route.stack[route.stack.length - 1]!.handle;
};

/** Calls the route and resolves to the error it refused with, or null. */
const call = async (
  method: string,
  path: string,
  params: Record<string, string>,
  body: unknown,
  actorId: string | undefined = h.adminId,
): Promise<{
  error: { status?: number; message?: string } | null;
  body: unknown;
}> => {
  const handler = handlerFor(h.router, method, path);
  let sent: unknown = null;
  let failed: { status?: number; message?: string } | null = null;

  const req = {
    params,
    body,
    user: actorId
      ? { id: actorId, username: "boss", isAdmin: true }
      : undefined,
    headers: {},
  };
  const res = {
    json: (value: unknown) => {
      sent = value;
      return res;
    },
    status: () => res,
    end: () => res,
  };

  await new Promise<void>((resolve) => {
    void Promise.resolve(
      handler(req, res, (err?: unknown) => {
        failed = err as { status?: number; message?: string };
        resolve();
      }),
    ).then(() => resolve());
  });

  return { error: failed, body: sent };
};

beforeEach(() => {
  h = makeHarness();
});

describe("DELETE /admin/users/:userId refuses", () => {
  it("an account that does not exist", async () => {
    const { error } = await call(
      "delete",
      "/users/:userId",
      { userId: "nope" },
      {
        username: "nope",
      },
    );
    expect(error?.status).toBe(404);
  });

  it("the administrator's own account", async () => {
    const { error } = await call(
      "delete",
      "/users/:userId",
      { userId: h.adminId },
      { username: "boss" },
    );
    // Deleting yourself here would leave the next request resolving to nobody
    // and the panel refusing its own operator.
    expect(error?.status).toBe(400);
    expect(error?.message).toMatch(/your own account/i);
  });

  it("another administrator, without demoting them first", async () => {
    const other = h.ctx.users.create({
      username: "second",
      passwordHash: "x",
      isAdmin: true,
    });

    const { error } = await call(
      "delete",
      "/users/:userId",
      { userId: other.id },
      { username: "second" },
    );
    expect(error?.status).toBe(400);
    expect(error?.message).toMatch(/administrator/i);
    expect(h.ctx.users.findById(other.id)!.deleted_at).toBeNull();
  });

  it("a typed username that does not match the account selected", async () => {
    const target = h.ctx.users.create({
      username: "leaver",
      passwordHash: "x",
    });

    const { error } = await call(
      "delete",
      "/users/:userId",
      { userId: target.id },
      { username: "leaverr" },
    );

    // The half that counts. The panel disables its own button until the typed
    // name matches, and that enforces nothing — a client is not a place to put
    // a guarantee (invariant 21).
    expect(error?.status).toBe(400);
    expect(h.ctx.users.findById(target.id)!.deleted_at).toBeNull();
  });

  it("the shared anonymous stand-in", async () => {
    // Under LAWHA_REQUIRE_AUTH=false this row owns every board on the server,
    // and `GET /admin/users` filters it out — so deleting it would take the
    // deployment dark with no row left in the panel to press Restore on.
    // `anonymousUser.ts` makes refusing it an obligation on anything new that
    // can damage a row.
    const anon = h.ctx.users.create({
      username: "anonymous",
      passwordHash: "x",
    });

    const { error } = await call(
      "delete",
      "/users/:userId",
      { userId: anon.id },
      { username: "anonymous" },
    );

    expect(error?.status).toBe(404);
    expect(h.ctx.users.findById(anon.id)!.deleted_at).toBeNull();
  });

  it("an account that is already in the trash", async () => {
    const target = h.ctx.users.create({
      username: "leaver",
      passwordHash: "x",
    });
    h.ctx.users.setDeleted(target.id, true);

    const { error } = await call(
      "delete",
      "/users/:userId",
      { userId: target.id },
      { username: "leaver" },
    );
    expect(error?.status).toBe(404);
  });
});

describe("DELETE /admin/users/:userId accepts", () => {
  it("a non-admin account whose username was typed correctly", async () => {
    const target = h.ctx.users.create({
      username: "leaver",
      passwordHash: "x",
    });

    const { error } = await call(
      "delete",
      "/users/:userId",
      { userId: target.id },
      { username: "leaver" },
    );

    expect(error).toBeNull();
    expect(h.ctx.users.findById(target.id)!.deleted_at).not.toBeNull();
    // The row outlives its subject; thirty days from now it is the only record
    // that this account existed.
    expect(h.ctx.audit.recent(10)[0]).toMatchObject({
      action: "account.deleted",
      targetLabel: "leaver",
    });
  });

  it("a username typed in a different case", async () => {
    const target = h.ctx.users.create({
      username: "Leaver",
      passwordHash: "x",
    });

    const { error } = await call(
      "delete",
      "/users/:userId",
      { userId: target.id },
      { username: "LEAVER" },
    );

    // Normalised on both sides. Requiring the exact display casing would
    // reject a correct confirmation, which teaches people to distrust the box.
    expect(error).toBeNull();
    expect(h.ctx.users.findById(target.id)!.deleted_at).not.toBeNull();
  });
});

describe("a deleted account is not a usable target", () => {
  const deletedTarget = () => {
    const t = h.ctx.users.create({ username: "leaver", passwordHash: "x" });
    h.ctx.users.setDeleted(t.id, true);
    return t;
  };

  it.each([
    ["post", "/users/:userId/disabled", { disabled: true }],
    ["post", "/users/:userId/sessions/revoke", {}],
    ["post", "/users/:userId/reset-code", {}],
    ["post", "/users/:userId/admin", { isAdmin: true }],
  ])("refuses %s %s", async (method, path, body) => {
    const target = deletedTarget();
    const { error } = await call(method, path, { userId: target.id }, body);

    // The panel hides all four for a deleted row and its comment says the
    // server refuses them. That sentence was false when it was written — the
    // reset-code route in particular minted a live code for an account
    // `passwordReset.ts` then refuses at redemption, which is a control that
    // fails in somebody else's hands (invariant 24 inverted).
    expect(error?.status).toBe(400);
    expect(error?.message).toMatch(/deleted/i);
  });

  it("is not counted as an administrator who could take over", () => {
    const target = h.ctx.users.create({
      username: "second",
      passwordHash: "x",
      isAdmin: true,
    });
    expect(h.ctx.users.countActiveAdmins()).toBe(2);

    h.ctx.users.setDeleted(target.id, true);

    // The guard against demoting or disabling the last administrator counts
    // this. An account nobody can sign into satisfying it is the guard failing
    // silently — the same argument the codebase already makes for a disabled
    // administrator not being an administrator.
    expect(h.ctx.users.countActiveAdmins()).toBe(1);
  });
});

describe("POST /admin/users/:userId/restore", () => {
  it("refuses an account that is not in the trash", async () => {
    const target = h.ctx.users.create({
      username: "leaver",
      passwordHash: "x",
    });

    const { error } = await call(
      "post",
      "/users/:userId/restore",
      { userId: target.id },
      {},
    );
    expect(error?.status).toBe(404);
  });

  it("clears deleted_at and leaves disabled_at alone", async () => {
    const target = h.ctx.users.create({
      username: "leaver",
      passwordHash: "x",
    });
    h.ctx.users.setDisabled(target.id, true);
    h.ctx.users.setDeleted(target.id, true);

    const { error } = await call(
      "post",
      "/users/:userId/restore",
      { userId: target.id },
      {},
    );

    expect(error).toBeNull();
    const row = h.ctx.users.findById(target.id)!;
    expect(row.deleted_at).toBeNull();
    expect(row.disabled_at).not.toBeNull();
    expect(h.ctx.audit.recent(10)[0]).toMatchObject({
      action: "account.restored",
    });
  });
});
