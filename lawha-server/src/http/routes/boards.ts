import { Router } from "express";
import { z } from "zod";

import { toPublicBoard, toTrashedBoard } from "../../db/repositories/boards.js";
import { buildGuestCookie } from "../../lib/guests.js";
import { isValidRoomId } from "../../protocol.js";
import { purgeBoard } from "../../lib/trashSweep.js";
import {
  notifyBoardAccessChanged,
  notifyBoardRenamed,
} from "../../socket/liveAccess.js";
import {
  asyncHandler,
  badRequest,
  forbidden,
  gone,
  notFound,
} from "../middleware/errors.js";
import { RateLimiter, clientIpOf, rateLimit } from "../middleware/rateLimit.js";
import { principalOf, requireAuth } from "../middleware/requireAuth.js";
import { resolveSecureCookie } from "../middleware/session.js";

import { createBoardInvitesRouter } from "./invites.js";
import { createMembersRouter } from "./members.js";

import type { LawhaContext } from "../../context.js";

const createBoardSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  id: z.string().optional(),
});

const updateBoardSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  linkAccess: z.enum(["none", "view", "edit"]).optional(),
  /**
   * Whether `linkAccess: "edit"` also reaches visitors with no account.
   *
   * The owner sees one radio group with four options; the fourth is
   * `linkAccess: "edit"` with this set. Two fields rather than a fourth enum
   * value because widening `link_access`'s CHECK constraint would mean
   * rebuilding `boards` — see migration 018 and ADR 0024.
   */
  guestEdit: z.boolean().optional(),
  /** Replaces the board's tags wholesale; [] clears them. */
  tagIds: z.array(z.string()).max(20).optional(),
  /**
   * Files this board into one of the *caller's* folders, or unfiles it.
   *
   * `null` and absent are different: `null` clears the caller's filing, absent
   * leaves it alone. Nullable-and-optional rather than nullish, so a client
   * that means "take it out of the folder" cannot express that by omission and
   * then wonder why nothing happened.
   */
  folderId: z.string().nullable().optional(),
});

const duplicateBoardSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
});

export const createBoardsRouter = (ctx: LawhaContext): Router => {
  const router = Router();
  const auth = requireAuth(ctx);
  const authOrGuest = requireAuth(ctx, { allowGuest: true });

  /**
   * The budget for probing board ids.
   *
   * `POST /:boardId/access` is the only unauthenticated route in the app,
   * which makes it the only oracle: it answers "does this board exist and may
   * I have it" to anybody, and mints a guest cookie when the answer is yes. A
   * board id is 10 random bytes, so guessing one is not a realistic attack —
   * but an unmetered oracle is still the wrong thing to leave on a LAN, and
   * this route had no limiter at all while every route around it did.
   *
   * The window is generous because legitimate traffic is bursty: a dashboard
   * asks about nothing, but somebody following a link asks once per board, and
   * a reconnecting board asks again.
   */
  const accessByIp = new RateLimiter({
    limit: 120,
    windowMs: 5 * 60_000,
    message: "Too many board requests.",
  });

  /**
   * What this visitor may do with this board — and, for someone with no
   * account at all, the point at which they are given an identity to do it
   * with.
   *
   * Deliberately the *only* unauthenticated route in the app. It answers the
   * one question a share link poses ("may I open this?") and mints a pass
   * scoped to that single board when the answer is yes. Everything else stays
   * behind `requireAuth`.
   *
   * The client needs this before it opens the socket: it is what tells the
   * editor to come up in view mode rather than letting someone draw for a
   * minute and then discover the relay has been dropping their work.
   */
  router.post(
    "/:boardId/access",
    rateLimit(accessByIp, clientIpOf),
    asyncHandler(async (req, res) => {
      const boardId = req.params.boardId!;
      if (!isValidRoomId(boardId)) {
        throw badRequest("Malformed board id.");
      }

      const board = ctx.boards.findById(boardId);

      if (!board || board.deleted_at !== null) {
        // A permanently deleted id is not an available one (ADR 0029). The
        // branch below exists to say "go ahead and create it", and saying that
        // about a board somebody destroyed is how the destroyed board comes
        // back — owned by whoever happened to still hold the link. Checked
        // first, and answered the same way for a signed-in caller as for an
        // anonymous one, because the signed-in caller is the one whose write
        // would be accepted.
        if (!board && ctx.boards.isPurged(boardId)) {
          throw gone("This board was deleted permanently.");
        }
        // A signed-in client legitimately asks about a board id it has only
        // just invented: the row is created by the first scene write, and this
        // must not tell them they cannot use their own new board.
        if (req.user) {
          res.json({
            exists: false,
            canAccess: true,
            canEdit: true,
            role: null,
            linkAccess: "none",
            isGuest: false,
          });
          return;
        }
        throw notFound("Board not found.");
      }

      const existing = principalOf(req);
      const permission = ctx.resolveBoardPermission(existing, boardId);

      if (permission.canAccess) {
        res.json({
          exists: true,
          canAccess: true,
          canEdit: permission.canEdit,
          role: permission.role,
          linkAccess: permission.linkAccess,
          guestEdit: permission.guestEdit,
          isGuest: !req.user,
        });
        return;
      }

      // Signed in and refused, or a guest pass for some other board: there is
      // nothing to mint. Minting here would let anyone trade a link for one
      // board into a pass for a board that was never shared.
      if (req.user || board.link_access === "none") {
        throw forbidden();
      }

      const { token, guest } = ctx.guests.mint(boardId);
      res.append(
        "Set-Cookie",
        buildGuestCookie(token, guest.expiresAt, resolveSecureCookie(ctx, req)),
      );

      const minted = ctx.resolveBoardPermission(
        { id: guest.id, isGuest: true, guestBoardId: guest.boardId },
        boardId,
      );

      res.json({
        exists: true,
        canAccess: minted.canAccess,
        // True only when the owner chose "can edit, including visitors" for
        // this board — the resolver in socket/authz.ts owns that decision, and
        // this route reports it rather than re-deciding it (ADR 0024).
        canEdit: minted.canEdit,
        role: minted.role,
        linkAccess: minted.linkAccess,
        guestEdit: minted.guestEdit,
        isGuest: true,
      });
    }),
  );

  /**
   * The dashboard's one call.
   *
   * Tags and live editor counts come back with the boards rather than as
   * follow-up requests: a hundred-board list would otherwise be a hundred
   * round trips, over a link where round trips are the expensive part.
   */
  router.get(
    "/",
    auth,
    asyncHandler(async (req, res) => {
      const rows = ctx.boards.listForUser(req.user!.id);
      const ids = rows.map((row) => row.id);
      const tagsByBoard = ctx.tags.listForBoards(ids, req.user!.id);
      // One query for the whole list, keyed on this requester. Resolving the
      // folder per card would be the same N+1 the tag map exists to avoid, and
      // it has to be per requester because filing is per person: the map is
      // *this viewer's* answer, not the board's.
      const folderByBoard = ctx.folders.folderIdsForBoards(req.user!.id, ids);

      res.json({
        boards: rows.map((row) => ({
          ...toPublicBoard(row, folderByBoard[row.id] ?? null),
          tags: (tagsByBoard[row.id] ?? []).map((tag) => ({
            id: tag.id,
            name: tag.name,
            // An index, never a hex (invariant 16). The legacy `color` column
            // is not emitted; migration 014 has the reasoning.
            colorIndex: tag.color_index,
          })),
        })),
        // Only rooms with someone in them; a missing key means zero.
        editing: ctx.presence.countsFor(ids),
      });
    }),
  );

  router.post(
    "/",
    auth,
    asyncHandler(async (req, res) => {
      const params = createBoardSchema.parse(req.body ?? {});

      if (params.id !== undefined && !isValidRoomId(params.id)) {
        throw badRequest("Malformed board id.");
      }
      if (params.id && ctx.boards.findById(params.id)) {
        throw badRequest("A board with that id already exists.");
      }
      // The row is gone, so the check above passes — which is exactly the case
      // this one exists for (ADR 0029, migration 020).
      if (params.id && ctx.boards.isPurged(params.id)) {
        throw gone("This board was deleted permanently.");
      }

      const board = ctx.boards.create({
        ownerId: req.user!.id,
        name: params.name,
        id: params.id,
      });

      // A brand new board is in nobody's folder yet.
      res.status(201).json({ board: toPublicBoard(board, null) });
    }),
  );

  /**
   * The caller's trash (ADR 0029).
   *
   * **Registered before `GET /:boardId`, and that is load-bearing.** Express
   * matches routes in registration order, so with these two the other way
   * round every request for the trash is answered by the board handler with
   * `boardId = "trash"` — an id nobody owns, which `resolveBoardPermission`
   * refuses, so the trash reports itself as forbidden. No type error, no other
   * symptom, and nothing catches it by accident, which is why
   * `boardsRouteOrder.test.ts` reads the ordering off the router's own layer
   * stack and asserts it directly.
   */
  router.get(
    "/trash",
    auth,
    asyncHandler(async (req, res) => {
      const rows = ctx.boards.listTrashedForUser(req.user!.id);
      res.json({
        boards: rows.map((row) =>
          toTrashedBoard(row, ctx.config.trashRetentionMs),
        ),
        /**
         * Sent alongside, so the dashboard can say "kept for 30 days" on an
         * *empty* trash — where there is no board to carry a `purgeAt` and
         * therefore nothing to infer the policy from. A screen that explains
         * the rule only once there is something to lose explains it too late.
         */
        retentionDays: ctx.config.trashRetentionDays,
      });
    }),
  );

  router.get(
    "/:boardId",
    authOrGuest,
    asyncHandler(async (req, res) => {
      const boardId = req.params.boardId!;
      const permission = ctx.resolveBoardPermission(principalOf(req), boardId);

      if (!permission.canAccess) {
        throw forbidden();
      }

      const board = ctx.boards.findById(boardId);
      if (!board || board.deleted_at !== null) {
        throw notFound("Board not found.");
      }

      res.json({
        board: toPublicBoard(
          board,
          // A guest has no account and therefore no folders — `req.user` is
          // undefined on that branch by design, so this must not reach for
          // `req.user!.id`.
          req.user ? ctx.folders.folderIdFor(req.user.id, boardId) : null,
        ),
        // Who else is on a board is for its people. Someone here on the link
        // alone gets the board and an empty list rather than a roster.
        members: permission.role === null ? [] : ctx.members.list(boardId),
        role: permission.role,
        canEdit: permission.canEdit,
      });
    }),
  );

  router.patch(
    "/:boardId",
    auth,
    asyncHandler(async (req, res) => {
      const boardId = req.params.boardId!;
      const board = ctx.boards.findById(boardId);

      if (!board || board.deleted_at !== null) {
        throw notFound("Board not found.");
      }

      const permission = ctx.resolveBoardPermission(
        { id: req.user!.id },
        boardId,
      );
      if (!permission.canAccess) {
        throw forbidden();
      }

      const params = updateBoardSchema.parse(req.body ?? {});

      // Every field is optional, so an empty body parses cleanly and would
      // otherwise answer 200 with an unchanged board — including for a viewer,
      // who cannot change anything. Saying so matches what `PATCH /api/auth/me`
      // already does with the same shape of request.
      if (Object.keys(params).length === 0) {
        throw badRequest("Nothing to update.");
      }

      /**
       * Two kinds of field arrive on this route and they are not the same
       * permission question.
       *
       * `name`, `linkAccess` and `tagIds` write the board, which everyone who
       * can reach it sees — so they need `canEdit`. `folderId` writes a row in
       * `board_folders` keyed on the caller, which nobody else can see, so a
       * *viewer* on a shared board gets to file it on their own dashboard.
       * Refusing that would mean a board shared read-only could never be
       * organised by the person it was shared with, which is most of what a
       * dashboard is for.
       *
       * (`tagIds` is also per-person and is on the wrong side of this line for
       * historical reasons; moving it is a behaviour change for an existing
       * endpoint and is not made here.)
       */
      const changesTheBoard =
        params.name !== undefined ||
        params.linkAccess !== undefined ||
        params.tagIds !== undefined;

      if (changesTheBoard && !permission.canEdit) {
        throw forbidden("You cannot change this board.");
      }

      // Whether each socket-facing notification is owed, decided from the
      // snapshot read above rather than from inside the transaction below —
      // nothing yields to the event loop between that read and the write, so
      // no other request can have touched this row in between, and comparing
      // against a stale value here would be no different from comparing
      // against a fresh one.
      const nameChanged =
        params.name !== undefined && params.name !== board.name;
      // Either half of the owner's one choice counts as a change: promoting a
      // board from "can edit" to "can edit, including visitors" moves no
      // `link_access` value at all, and a connected guest has to be told.
      const linkAccessChanged =
        (params.linkAccess !== undefined &&
          params.linkAccess !== board.link_access) ||
        (params.guestEdit !== undefined &&
          params.guestEdit !== (board.guest_edit === 1));

      /**
       * Up to four writes across three repositories, and until now they were
       * four independent statements with nothing tying them together — a
       * failure partway (a constraint error on the tags write, say, after the
       * rename had already landed) left the board partly updated while the
       * client read a generic 500 implying nothing had been saved. Every
       * other multi-write path in this codebase (`InvitesRepository.redeem`,
       * `PasswordResetCodesRepository.redeem`, `ScenesRepository.write`'s
       * CAS, `FoldersRepository.delete`) is "both writes or neither"; this
       * is that same discipline, opened from the route instead of from
       * inside one repository, because `boards`/`tags`/`folders` do not
       * share an owner that could hold the transaction boundary itself.
       *
       * Nesting is safe: `ctx.tags.setForBoard` already opens its own
       * `this.db.transaction(...)`, and better-sqlite3 turns a transaction
       * begun while one is already open into a SAVEPOINT rather than a
       * second `BEGIN`, so the inner one composes with this one instead of
       * conflicting with it.
       *
       * MUST stay synchronous, start to finish — see
       * `PasswordResetCodesRepository.redeem`'s comment for the mechanism:
       * better-sqlite3's guard against an async transaction function
       * inspects only this callback's OWN return value, not anything it
       * awaits, so a stray `await` in here would let `COMMIT` run at the
       * first one and the rest of the callback would execute outside the
       * transaction it appears to be inside — silently. That is why the two
       * notifications below are OUTSIDE this call rather than inline where
       * the old per-field code had them: telling a room about a rename that
       * this same request's tags write then rolled back would be a smaller
       * copy of the exact bug this fixes.
       */
      ctx.db.transaction(() => {
        if (params.name !== undefined) {
          ctx.boards.rename(boardId, params.name);
        }
        if (params.linkAccess !== undefined || params.guestEdit !== undefined) {
          // Only an owner may change who can reach the board by link.
          if (!permission.isOwner) {
            throw forbidden("Only the owner can change sharing.");
          }
          // Written as a pair, always. The two columns encode one radio group,
          // so sending only half of it — "can view" without clearing
          // `guest_edit` — would leave a board whose stored state answers a
          // question the owner did not ask.
          ctx.boards.setLinkAccess(
            boardId,
            params.linkAccess ?? board.link_access,
            params.guestEdit ?? board.guest_edit === 1,
          );
        }
        if (params.tagIds !== undefined) {
          // Tags belong to the person doing the labelling, so someone else's
          // id is dropped rather than honoured — a shared board must not let
          // one member attach a label from another member's vocabulary.
          const mine = new Set(
            ctx.tags.listForUser(req.user!.id).map((tag) => tag.id),
          );
          ctx.tags.setForBoard(
            boardId,
            params.tagIds.filter((tagId) => mine.has(tagId)),
            req.user!.id,
          );
        }
        if (params.folderId !== undefined) {
          if (params.folderId === null) {
            ctx.folders.unfile(boardId, req.user!.id);
          } else {
            const folder = ctx.folders.findById(params.folderId);
            // 403 and not a silent drop, which is what the tag branch above
            // does with a stranger's id. The difference is what the request
            // means: `tagIds` replaces a whole set, so ignoring one entry
            // still leaves a coherent result, whereas naming a single folder
            // is the entire operation — succeeding while filing it nowhere
            // would be a lie the dashboard then renders as "this board went
            // missing".
            if (!folder || folder.owner_id !== req.user!.id) {
              throw forbidden("That folder is not yours.");
            }
            ctx.folders.file({
              boardId,
              ownerId: req.user!.id,
              folderId: folder.id,
            });
          }
        }
      })();

      // Everyone in the room is looking at the old title until this lands.
      // Guarded on an actual change so a PATCH that resends the same name —
      // which the board title does on every blur — is not a broadcast.
      if (nameChanged) {
        notifyBoardRenamed(boardId, params.name!);
      }
      // Closing a link mid-session has to reach the sockets that joined
      // while it was open, or the people it just excluded keep relaying
      // edits to everyone else until they happen to reload.
      if (linkAccessChanged) {
        await notifyBoardAccessChanged(boardId);
      }

      res.json({
        board: toPublicBoard(
          ctx.boards.findById(boardId)!,
          ctx.folders.folderIdFor(req.user!.id, boardId),
        ),
      });
    }),
  );

  router.post(
    "/:boardId/duplicate",
    auth,
    asyncHandler(async (req, res) => {
      const boardId = req.params.boardId!;
      if (!(await ctx.canAccessBoard(req.user!.id, boardId))) {
        throw forbidden();
      }

      const source = ctx.boards.findById(boardId);
      if (!source || source.deleted_at !== null) {
        throw notFound("Board not found.");
      }

      const { name } = duplicateBoardSchema.parse(req.body ?? {});
      const board = ctx.boards.duplicate({
        sourceId: boardId,
        ownerId: req.user!.id,
        name: name ?? `${source.name} copy`,
      });

      // Unfiled, like a fresh board: filing is per person and the copy is a
      // different board, so inheriting the source's row would be a guess.
      res.status(201).json({ board: toPublicBoard(board, null) });
    }),
  );

  router.delete(
    "/:boardId",
    auth,
    asyncHandler(async (req, res) => {
      const boardId = req.params.boardId!;
      const board = ctx.boards.findById(boardId);

      if (!board || board.deleted_at !== null) {
        throw notFound("Board not found.");
      }
      if (board.owner_id !== req.user!.id) {
        throw forbidden("Only the owner can delete this board.");
      }

      ctx.boards.softDelete(boardId);
      // A deleted board is not accessible to anyone, including whoever is in
      // its room at this instant.
      await notifyBoardAccessChanged(boardId);
      res.status(204).end();
    }),
  );

  /**
   * Takes a board back out of the trash (ADR 0029).
   *
   * Owner only, matching DELETE exactly. That symmetry is the rule: only the
   * owner can put a board in the trash, so only the owner can take it out, and
   * an editor never sees the trash at all — `listTrashedForUser` does not join
   * `board_members` for the same reason.
   *
   * **A 404 for a board that is not in the trash, not a 200.** "Restore a live
   * board" has no meaning, and answering it with success would let a client
   * that lost track of its own state believe it had undone something it never
   * did. The repository's guard makes the same distinction at the SQL level, so
   * a restore that races another restore reports the truth to the loser rather
   * than both reporting success.
   */
  router.post(
    "/:boardId/restore",
    auth,
    asyncHandler(async (req, res) => {
      const boardId = req.params.boardId!;
      const board = ctx.boards.findById(boardId);

      if (!board || board.deleted_at === null) {
        throw notFound("Board not found in the trash.");
      }
      if (board.owner_id !== req.user!.id) {
        throw forbidden("Only the owner can restore this board.");
      }

      if (!ctx.boards.restore(boardId)) {
        throw notFound("Board not found in the trash.");
      }

      // The mirror of the eviction on delete. Nobody should be in the room —
      // deleting emptied it — but the relay is the authority on who is
      // actually connected, not this route's assumption about it, and
      // re-evaluating an empty room costs nothing.
      await notifyBoardAccessChanged(boardId);

      const folderId = ctx.folders.folderIdsForBoards(req.user!.id, [boardId])[
        boardId
      ];
      res.json({
        board: toPublicBoard(ctx.boards.findById(boardId)!, folderId ?? null),
      });
    }),
  );

  /**
   * Deletes a trashed board for good, now, instead of in thirty days.
   *
   * **Only reachable for a board already in the trash.** Two steps rather than
   * one, and not as a nicety: this is the single operation in the app with no
   * undo, and requiring the board to have been soft-deleted first means the
   * irreversible button cannot be the first button anyone presses. The
   * repository guards it a second time in SQL, so even a caller that bypassed
   * this route could not reach a live board with it.
   *
   * `purgeBoard` rather than a `DELETE` written here, because a board is a row
   * *and* a directory of uploaded images, and only the row is reachable by a
   * foreign key. See `lib/trashSweep.ts`.
   */
  router.delete(
    "/:boardId/permanent",
    auth,
    asyncHandler(async (req, res) => {
      const boardId = req.params.boardId!;
      const board = ctx.boards.findById(boardId);

      if (!board || board.deleted_at === null) {
        throw notFound("Board not found in the trash.");
      }
      if (board.owner_id !== req.user!.id) {
        throw forbidden("Only the owner can delete this board.");
      }

      // The boolean is the point. `purge` is guarded on `deleted_at IS NOT
      // NULL` in SQL, so a restore that lands between the check above and this
      // line makes it a no-op — and answering 204 there would take the board
      // out of the caller's trash view while leaving it alive on the
      // dashboard, which is the one outcome neither button asked for.
      if (!(await purgeBoard(ctx, boardId))) {
        throw notFound("Board not found in the trash.");
      }

      // Mirrors the soft delete. It should be a no-op — the room was emptied
      // when the board went into the trash — but "should be empty" is an
      // assumption about the relay, and the relay is the thing that actually
      // knows. On a deployment with `allowUnknownBoards` a socket left behind
      // would otherwise be re-resolved as being in an *unknown* board, which
      // is permissive.
      await notifyBoardAccessChanged(boardId);
      res.status(204).end();
    }),
  );

  // Named sharing lives under the board it shares: /api/boards/:id/members.
  router.use("/", createMembersRouter(ctx));
  router.use("/", createBoardInvitesRouter(ctx));

  return router;
};
