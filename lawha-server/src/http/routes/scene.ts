import { Router, raw } from "express";

import { SCENE_HEADERS, isValidRoomId } from "../../protocol.js";
import {
  asyncHandler,
  badRequest,
  forbidden,
  gone,
  notFound,
} from "../middleware/errors.js";
import { principalOf, requireAuth } from "../middleware/requireAuth.js";

import type { LawhaContext } from "../../context.js";
import type { SceneRow } from "../../db/repositories/scenes.js";
import type { BoardPermission } from "../../socket/authz.js";
import type { Request, Response } from "express";

/** Scenes are typically well under a megabyte, but a busy board can grow. */
const MAX_SCENE_BYTES = 20 * 1024 * 1024;

const RE_HEX = /^[0-9a-f]+$/i;

/**
 * The IV, or the empty buffer that means "this body is not encrypted".
 *
 * **A zero-length `iv` is the marker for a plaintext scene**, and the whole
 * migration off encryption rests on it. `board_scenes.iv` is `NOT NULL` and
 * SQLite cannot alter a column, so the alternative was the twelve-step table
 * rebuild — and a nullable column would have said "unknown" where this says
 * "none", which is a different fact. An empty blob lets an encrypted row and a
 * plaintext row sit in the same table while the estate converts, which is what
 * makes the conversion lazy rather than a single irreversible sweep.
 *
 * A *present but malformed* header is still a 400. Absent means plaintext;
 * "aXZ!" means a client is broken, and collapsing the two would let a bug that
 * mangles the header silently store a scene nobody can decrypt.
 */
const parseIv = (value: unknown): Buffer => {
  if (value === undefined || value === "") {
    return Buffer.alloc(0);
  }
  if (typeof value !== "string" || !RE_HEX.test(value)) {
    throw badRequest("Malformed initialisation vector.");
  }
  return Buffer.from(value, "hex");
};

const parseExpectedRev = (value: unknown): number | null => {
  if (value === undefined || value === "") {
    // "I have never seen a stored scene" — create if absent.
    return null;
  }
  const rev = Number(value);
  if (!Number.isInteger(rev) || rev < 0) {
    throw badRequest("Malformed expected revision.");
  }
  return rev;
};

/**
 * Responds with a raw ciphertext body plus metadata headers.
 *
 * Deliberately not base64-in-JSON: that inflates a multi-megabyte scene by a
 * third on every conflict retry.
 */
const sendScene = (res: Response, scene: SceneRow, status = 200): void => {
  res
    .status(status)
    .set({
      "Content-Type": "application/octet-stream",
      [SCENE_HEADERS.REV]: String(scene.rev),
      [SCENE_HEADERS.SCENE_VERSION]: String(scene.scene_version),
      [SCENE_HEADERS.IV]: Buffer.from(scene.iv).toString("hex"),
      "Cache-Control": "no-store",
    })
    .send(Buffer.from(scene.ciphertext));
};

export const createSceneRouter = (ctx: LawhaContext): Router => {
  const router = Router({ mergeParams: true });
  const authOrGuest = requireAuth(ctx, { allowGuest: true });

  /**
   * A board id can legitimately be unknown: the client generates it locally
   * and the row is only created on first write. So "no such board" and "not
   * yours" are different answers, and conflating them either leaks board
   * existence or makes new boards unwritable.
   *
   * Returns the resolved permission so the caller can gate writing on it —
   * `canEdit` had no call sites at all, which is how `link_access = "view"`
   * came to grant full write.
   */
  const assertAccess = (
    req: Request,
    boardId: string,
    { allowMissing }: { allowMissing: boolean },
  ): BoardPermission | null => {
    if (!isValidRoomId(boardId)) {
      throw badRequest("Malformed board id.");
    }

    if (!ctx.boards.findById(boardId)) {
      // A destroyed board is not an unclaimed id (ADR 0029, migration 020).
      // Checked BEFORE `allowMissing`, because `allowMissing` is what lets the
      // caller of a missing id become the owner of a new board at that id —
      // which, for an id whose board was just purged, means the owner's own
      // still-open editor tab, or anyone who kept the link, recreating the
      // board they thought they had destroyed. `gone` rather than `notFound`:
      // the client asked about something that existed and does not any more,
      // and a 404 would read as "not yet" to code whose next move is to write.
      if (ctx.boards.isPurged(boardId)) {
        throw gone("This board was deleted permanently.");
      }
      if (allowMissing) {
        return null;
      }
      throw notFound("This board has no saved scene yet.");
    }

    const permission = ctx.resolveBoardPermission(principalOf(req), boardId);
    if (!permission.canAccess) {
      throw forbidden();
    }
    return permission;
  };

  router.get(
    "/:boardId/scene",
    authOrGuest,
    asyncHandler(async (req, res) => {
      const boardId = req.params.boardId!;
      assertAccess(req, boardId, { allowMissing: false });

      const scene = ctx.scenes.find(boardId);
      if (!scene) {
        throw notFound("This board has no saved scene yet.");
      }

      sendScene(res, scene);
    }),
  );

  router.put(
    "/:boardId/scene",
    // Guests are let *in* and then refused by the checks below, rather than
    // bounced with a 401. "Sign in to continue" is the wrong answer for
    // someone who is already here: they are recognised, they simply have view
    // access, and the client needs to be able to tell those apart.
    authOrGuest,
    raw({ type: "application/octet-stream", limit: MAX_SCENE_BYTES }),
    asyncHandler(async (req, res) => {
      const boardId = req.params.boardId!;
      // Writing to an unclaimed id is how a board comes into existence; the
      // writer becomes its owner.
      const permission = assertAccess(req, boardId, { allowMissing: true });

      // The check this route never had. A viewer — by role, by a `view` link,
      // or by being a guest — reads the scene and cannot replace it.
      if (permission && !permission.canEdit) {
        throw forbidden("You have view-only access to this board.");
      }

      // Separately from the above, and narrower than it used to be. This guard
      // exists for the *unclaimed* id case: `permission` is null when no board
      // row exists yet, the writer becomes its owner, and an owner has to be a
      // real user — an account-less visitor must not be able to conjure a board.
      //
      // It used to be unconditional, which meant a guest was refused here even
      // when `canEdit` above had just allowed them, and no setting the owner
      // could pick would have changed that (ADR 0024).
      if (!permission && !req.user) {
        throw forbidden("You have view-only access to this board.");
      }

      // Named `payload` rather than `ciphertext` since a zero-length iv makes
      // this plaintext JSON. The column it lands in is still called
      // `ciphertext`, because renaming a column in SQLite is a table rebuild
      // and the name is wrong in one place rather than in every query.
      const payload = req.body as Buffer;
      if (!Buffer.isBuffer(payload) || payload.byteLength === 0) {
        throw badRequest("Empty scene payload.");
      }

      const iv = parseIv(req.headers[SCENE_HEADERS.IV]);
      const expectedRev = parseExpectedRev(
        req.headers[SCENE_HEADERS.EXPECTED_REV],
      );
      const sceneVersion = Number(
        req.headers[SCENE_HEADERS.SCENE_VERSION] ?? 0,
      );

      if (!Number.isFinite(sceneVersion)) {
        throw badRequest("Malformed scene version.");
      }

      // The board row may not exist yet when auth is disabled and the client
      // invented a board id locally.
      if (!ctx.boards.findById(boardId)) {
        // Guarded above: reaching here with no board row means `permission` was
        // null, which the guard only lets past for a signed-in user.
        ctx.boards.create({ id: boardId, ownerId: req.user!.id });
      }

      const result = ctx.scenes.write({
        boardId,
        expectedRev,
        sceneVersion,
        iv,
        ciphertext: payload,
        // Null for a guest editor. `board_scenes.updated_by` is a nullable FK
        // (`001_init.sql:95`), so an unattributed write needs no migration —
        // and "we do not know who" is the honest value, given a guest has no
        // account to name.
        updatedBy: req.user?.id ?? null,
      });

      if (!result.ok) {
        ctx.metrics.sceneCasConflict();
        const current = result.current ?? ctx.scenes.find(boardId);
        if (!current) {
          // Raced with a delete; the client should retry as a create.
          throw notFound("This board has no saved scene yet.");
        }
        // The client reconciles, not the server — and the reason for that
        // outlived the encryption. It used to be "the client holds the key";
        // it is now that merging is per-element and never-deleting
        // (invariant 3's sibling), which is `reconcileElements` in the editor.
        // The server's job is the compare-and-swap on `rev` and nothing more
        // (invariant 2: never last-write-wins on `sceneVersion`).
        sendScene(res, current, 409);
        return;
      }

      ctx.metrics.sceneCasWrite();
      res
        .status(200)
        .set({ [SCENE_HEADERS.REV]: String(result.rev) })
        .json({ rev: result.rev });
    }),
  );

  return router;
};
