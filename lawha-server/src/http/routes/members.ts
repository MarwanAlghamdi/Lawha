import { Router } from "express";

import { memberSearchSchema, setMemberSchema } from "../../lib/validation.js";
import { notifyBoardAccessChanged } from "../../socket/liveAccess.js";
import {
  asyncHandler,
  badRequest,
  forbidden,
  notFound,
} from "../middleware/errors.js";
import { principalOf, requireAuth } from "../middleware/requireAuth.js";

import type { LawhaContext } from "../../context.js";
import type { BoardRow } from "../../db/repositories/boards.js";
import type { Request } from "express";

/**
 * Named sharing: a board's people and their permissions.
 *
 * Mounted inside the boards router rather than at its own prefix, so the paths
 * read `/api/boards/:boardId/members/...` and the board is always part of the
 * question. There is no route here that is not scoped to one board.
 */
export const createMembersRouter = (ctx: LawhaContext): Router => {
  const router = Router({ mergeParams: true });
  const auth = requireAuth(ctx);

  /** The board, or a 404 — never a bare row that might be deleted. */
  const liveBoard = (boardId: string): BoardRow => {
    const board = ctx.boards.findById(boardId);
    if (!board || board.deleted_at !== null) {
      throw notFound("Board not found.");
    }
    return board;
  };

  /**
   * Only an owner may change who is on a board.
   *
   * Editors can change the *drawing*; sharing is a different power, and an
   * editor who could add owners could take the board.
   */
  const assertOwner = (req: Request, board: BoardRow): string => {
    const principal = principalOf(req);
    const permission = ctx.resolveBoardPermission(principal, board.id);

    if (!permission.isOwner) {
      throw forbidden(
        "Only an owner can change who this board is shared with.",
      );
    }
    return principal.id;
  };

  router.get(
    "/:boardId/members",
    auth,
    asyncHandler(async (req, res) => {
      const board = liveBoard(req.params.boardId!);
      const permission = ctx.resolveBoardPermission(principalOf(req), board.id);

      // Membership is visible to the board's people, not to everyone holding
      // the link: who else you work with is not part of what a link shares.
      if (permission.role === null) {
        throw forbidden("You do not have access to this board.");
      }

      res.json({
        members: ctx.members.list(board.id),
        role: permission.role,
        linkAccess: permission.linkAccess,
      });
    }),
  );

  /**
   * Candidates for the picker.
   *
   * On a private LAN, usernames are not a secret worth protecting from the
   * people already on it — but they are not public either, so this requires a
   * signed-in account *and* ownership of the board being shared. A guest, an
   * anonymous visitor, or a member who is merely an editor gets nothing: the
   * only way to enumerate accounts is to already own a board, which everyone
   * with an account does, which is the point at which the list is useful.
   */
  router.get(
    "/:boardId/members/candidates",
    auth,
    asyncHandler(async (req, res) => {
      const board = liveBoard(req.params.boardId!);
      assertOwner(req, board);

      const { q, limit } = memberSearchSchema.parse(req.query ?? {});

      res.json({
        users: ctx.members.candidates({ boardId: board.id, query: q, limit }),
      });
    }),
  );

  router.put(
    "/:boardId/members/:userId",
    auth,
    asyncHandler(async (req, res) => {
      const board = liveBoard(req.params.boardId!);
      const actorId = assertOwner(req, board);
      const userId = req.params.userId!;

      const { role } = setMemberSchema.parse(req.body ?? {});
      const user = ctx.users.findById(userId);

      if (!user) {
        throw notFound("No such account.");
      }
      if (userId === board.owner_id && role !== "owner") {
        // `boards.owner_id` is the row that cascades on delete and the one
        // `resolveBoardPermission` falls back to. Demoting it here would leave
        // a board whose owner is a viewer of it.
        throw badRequest("The board's owner cannot be demoted.");
      }

      ctx.members.upsert({ boardId: board.id, userId, role, addedBy: actorId });

      // Applies to the session in progress, not just the next one.
      await notifyBoardAccessChanged(board.id);

      res.json({ members: ctx.members.list(board.id) });
    }),
  );

  router.delete(
    "/:boardId/members/:userId",
    auth,
    asyncHandler(async (req, res) => {
      const board = liveBoard(req.params.boardId!);
      assertOwner(req, board);
      const userId = req.params.userId!;

      if (userId === board.owner_id) {
        throw badRequest("The board's owner cannot be removed.");
      }

      ctx.members.remove(board.id, userId);
      await notifyBoardAccessChanged(board.id);

      res.json({ members: ctx.members.list(board.id) });
    }),
  );

  return router;
};
