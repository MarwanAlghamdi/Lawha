import { Router } from "express";
import { z } from "zod";

import { inviteStatus } from "../../db/repositories/invites.js";
import {
  generateInviteCode,
  normalizeInviteCode,
} from "../../lib/inviteCode.js";
import { notifyBoardAccessChanged } from "../../socket/liveAccess.js";
import {
  asyncHandler,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../middleware/errors.js";
import { RateLimiter, clientIpOf, rateLimit } from "../middleware/rateLimit.js";
import { principalOf, requireAuth } from "../middleware/requireAuth.js";

import type { LawhaContext } from "../../context.js";
import type { BoardRow } from "../../db/repositories/boards.js";
import type { InviteRow, InviteStatus } from "../../db/repositories/invites.js";
import type { Request } from "express";

/**
 * Invite codes: minting them, and spending them. See ADR 0014.
 *
 * Two routers, because the two halves have nothing in common but the table.
 * Minting is a board operation and only an owner may do it, so it hangs off
 * `/api/boards/:boardId` beside members. Spending is done by somebody who has
 * a code and, by definition, no access to the board yet — so it cannot be
 * behind a board-scoped gate, and lives at `/api/invites/:code`.
 */

const HOUR_MS = 60 * 60_000;

const createInviteSchema = z.object({
  // Never `owner`: see `InviteRole`.
  role: z.enum(["viewer", "editor"]).default("editor"),
  /** `null` means it never expires — allowed, but never what the UI sends. */
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .nullable()
    .default(24 * 7),
  /** `null` means unlimited. `1` is "invite exactly this one person". */
  maxUses: z.number().int().min(1).max(500).nullable().default(null),
});

/**
 * How many codes one board may have outstanding.
 *
 * Two reasons, and the second is the real one. Rows are cheap, but every live
 * code is another target in a keyspace that is already smaller than a board
 * id's (see `lib/inviteCode.ts`), so an unbounded pile of them is the one way
 * a caller could meaningfully widen the search. It also stops the owner's own
 * list from becoming unreadable, which is what makes revocation not happen.
 */
const MAX_LIVE_INVITES_PER_BOARD = 20;

/**
 * A collision means two codes drew the same three words. At 16.7 million
 * combinations against at most twenty live rows this effectively never
 * happens, so the retry is here for the one time it does rather than as a
 * hot path — and a failure after ten draws is a bug worth surfacing, not a
 * loop worth widening.
 */
const MINT_ATTEMPTS = 10;

export const createBoardInvitesRouter = (ctx: LawhaContext): Router => {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(ctx);

  const liveBoard = (boardId: string): BoardRow => {
    const board = ctx.boards.findById(boardId);
    if (!board || board.deleted_at !== null) {
      throw notFound("Board not found.");
    }
    return board;
  };

  /** Same rule as membership: sharing is an owner's power, not an editor's. */
  const assertOwner = (req: Request, board: BoardRow): string => {
    const principal = principalOf(req);
    const permission = ctx.resolveBoardPermission(principal, board.id);
    if (!permission.isOwner) {
      throw forbidden("Only an owner can invite people to this board.");
    }
    return principal.id;
  };

  router.get(
    "/:boardId/invites",
    auth,
    asyncHandler(async (req, res) => {
      const board = liveBoard(req.params.boardId!);
      assertOwner(req, board);

      res.json({ invites: ctx.invites.listForBoard(board.id) });
    }),
  );

  router.post(
    "/:boardId/invites",
    auth,
    asyncHandler(async (req, res) => {
      const board = liveBoard(req.params.boardId!);
      const actorId = assertOwner(req, board);

      const { role, expiresInHours, maxUses } = createInviteSchema.parse(
        req.body ?? {},
      );

      const live = ctx.invites
        .listForBoard(board.id)
        .filter((invite) => invite.status === "live");
      if (live.length >= MAX_LIVE_INVITES_PER_BOARD) {
        throw conflict(
          `This board already has ${MAX_LIVE_INVITES_PER_BOARD} live codes. Revoke one before making another.`,
          "TOO_MANY_INVITES",
        );
      }

      const code = mintCode(ctx);
      ctx.invites.create({
        code,
        boardId: board.id,
        role,
        createdBy: actorId,
        expiresAt:
          expiresInHours === null
            ? null
            : Date.now() + expiresInHours * HOUR_MS,
        maxUses,
      });

      res
        .status(201)
        .json({ invites: ctx.invites.listForBoard(board.id), code });
    }),
  );

  router.delete(
    "/:boardId/invites/:code",
    auth,
    asyncHandler(async (req, res) => {
      const board = liveBoard(req.params.boardId!);
      assertOwner(req, board);

      const invite = ctx.invites.findByCode(req.params.code!);
      // Scoped to the board in the path, not just looked up by code: without
      // this, an owner of any board could revoke any other board's codes by
      // guessing one, and the path would have been a decoration.
      if (!invite || invite.board_id !== board.id) {
        throw notFound("No such code.");
      }

      ctx.invites.revoke(invite.code);

      res.json({ invites: ctx.invites.listForBoard(board.id) });
    }),
  );

  return router;
};

const mintCode = (ctx: LawhaContext): string => {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const code = generateInviteCode();
    if (!ctx.invites.findByCode(code)) {
      return code;
    }
  }
  throw conflict("Could not mint a code. Try again.", "INVITE_MINT_FAILED");
};

export const createInvitesRouter = (ctx: LawhaContext): Router => {
  const router = Router();
  // A real account, never a guest: redemption writes a `board_members` row and
  // a guest has no user to put in it. This is also the answer to the problem
  // the whole feature exists for — a link visitor has nowhere durable to keep
  // the board, and an account is what "durable" needs.
  const auth = requireAuth(ctx);

  /**
   * The rate limits that make a three-word credential defensible, so they are
   * tighter than anywhere else in the app bar the login route. Both keys are
   * needed: the address bounds an anonymous prober, and the account bounds
   * somebody signed in working through the space from a dozen devices.
   *
   * Built here rather than at module scope, like every other router's — a
   * limiter's buckets should not outlive the server they belong to.
   */
  const redeemByIp = new RateLimiter({
    limit: 10,
    windowMs: 15 * 60_000,
    message: "Too many invite codes tried. Wait a little and try again.",
  });
  const redeemByUser = new RateLimiter({
    limit: 20,
    windowMs: 60 * 60_000,
    message: "Too many invite codes tried. Wait a little and try again.",
  });

  const limits = [
    rateLimit(redeemByIp, clientIpOf),
    rateLimit(redeemByUser, (req) => `u:${req.user?.id ?? "anon"}`),
  ];

  /**
   * The code and the board it names — whether or not it can still be spent.
   *
   * Existence and spendability are separate steps because somebody who has
   * *already* redeemed a code needs the first without the second: their code
   * may since have expired, and refreshing the page they redeemed it on must
   * not tell them so.
   */
  const find = (raw: string) => {
    const code = normalizeInviteCode(raw);
    if (!code) {
      throw badRequest("That does not look like an invite code.", "BAD_CODE");
    }

    const invite = ctx.invites.findByCode(code);
    if (!invite) {
      throw notFound("That code is not valid.", "NO_SUCH_CODE");
    }

    const board = ctx.boards.findById(invite.board_id);
    if (!board || board.deleted_at !== null) {
      throw notFound("That board is gone.", "BOARD_GONE");
    }

    return { invite, board };
  };

  /**
   * Refuses a code that cannot be spent, saying which kind of dead it is.
   *
   * "No such code" and "that code has expired" are deliberately different
   * answers. Telling them apart leaks that a code exists, but only to somebody
   * who already holds a well-formed one, and the alternative is a person
   * staring at a code they were just handed being told it is wrong when it is
   * merely late. The rate limits above are what make that trade affordable.
   */
  const assertSpendable = (invite: InviteRow) => {
    const uses = ctx.invites.countRedemptions(invite.code);
    const status = inviteStatusOf(ctx, invite, uses);
    if (status !== "live") {
      throw forbidden(REFUSALS[status], status.toUpperCase());
    }
  };

  router.get(
    "/:code",
    auth,
    ...limits,
    asyncHandler(async (req, res) => {
      const { invite, board } = find(req.params.code!);
      assertSpendable(invite);

      // Enough to decide whether to accept, and nothing else. The board's
      // name is not a secret from somebody who is one click from opening it,
      // but its scene, its members and its other codes are.
      res.json({
        code: invite.code,
        boardId: board.id,
        boardName: board.name,
        role: invite.role,
        expiresAt: invite.expires_at,
      });
    }),
  );

  router.post(
    "/:code/redeem",
    auth,
    ...limits,
    asyncHandler(async (req, res) => {
      const { invite, board } = find(req.params.code!);
      const userId = req.user!.id;

      const existing = ctx.members.find(board.id, userId);

      // Already in, and already spent this code. Refreshing the join page is
      // not a second use and must not look like a failure — not even once the
      // code has expired, been revoked, or been used up by other people.
      //
      // **Both halves of that condition are load-bearing.** Without the
      // membership check, somebody an owner had removed from the board could
      // let themselves straight back in with a code that is now dead, because
      // their old redemption row would still be there vouching for them.
      if (existing && ctx.invites.hasRedeemed(invite.code, userId)) {
        res.json({ boardId: board.id, role: existing.role, joined: false });
        return;
      }

      assertSpendable(invite);

      // On the board by some other route — added by name, or the owner. This
      // must never *lower* a role: an owner who follows their own viewer code
      // would otherwise demote themselves out of their own board.
      if (existing && !isUpgrade(existing.role, invite.role)) {
        res.json({ boardId: board.id, role: existing.role, joined: false });
        return;
      }

      ctx.invites.redeem({ code: invite.code, userId }, () => {
        ctx.members.upsert({
          boardId: board.id,
          userId,
          role: invite.role,
          // Attributed to whoever minted the code, not to the redeemer, so
          // `added_by` still answers "on whose authority" — which is the only
          // question that column is ever asked.
          addedBy: invite.created_by,
        });
      });

      // Applies to a session already in progress: somebody watching as a link
      // guest who redeems a code becomes an editor without reloading.
      await notifyBoardAccessChanged(board.id);

      res.json({ boardId: board.id, role: invite.role, joined: true });
    }),
  );

  return router;
};

const RANK = { viewer: 0, editor: 1, owner: 2 } as const;

const isUpgrade = (
  current: keyof typeof RANK,
  offered: keyof typeof RANK,
): boolean => RANK[offered] > RANK[current];

const REFUSALS = {
  revoked: "That code has been turned off.",
  expired: "That code has expired.",
  exhausted: "That code has already been used as many times as it allows.",
} as const;

/**
 * The stored status, plus the one condition that is not stored: whether the
 * person who minted the code still owns the board.
 *
 * An owner who is removed from a board must not keep a way back into it. The
 * codes they left behind are not revoked by removing them — nothing walks the
 * table — so the check has to happen when the code is spent. Treated as
 * revoked rather than as its own state: from the holder's side it is the same
 * fact, that somebody withdrew it.
 */
const inviteStatusOf = (
  ctx: LawhaContext,
  invite: InviteRow,
  uses: number,
): InviteStatus => {
  const stored = inviteStatus(invite, uses);
  if (stored !== "live") {
    return stored;
  }
  const minter = ctx.resolveBoardPermission(
    { id: invite.created_by },
    invite.board_id,
  );
  return minter.isOwner ? "live" : "revoked";
};
