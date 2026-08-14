import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Router, raw } from "express";

import {
  FILE_CACHE_MAX_AGE_SEC,
  FILE_SCOPES,
  FILE_UPLOAD_MAX_BYTES,
  RE_FILE_ID,
  isValidRoomId,
} from "../../protocol.js";
import {
  HttpError,
  asyncHandler,
  badRequest,
  forbidden,
  notFound,
  unauthorized,
} from "../middleware/errors.js";
import { principalOf, requireAuth } from "../middleware/requireAuth.js";

import type { LawhaContext } from "../../context.js";
import type { FileScope } from "../../protocol.js";
import type { BoardPermission, Principal } from "../../socket/authz.js";
import type { RequestHandler } from "express";

/**
 * `raw()`'s own PayloadTooLargeError carries `status: 413`, but the shared
 * error middleware only understands HttpError and ZodError — so unwrapped it
 * came back as a 500. The client reads 5xx as transient and retries forever a
 * file that can never fit, while 413 is fatal and shown to the user. Translated
 * here rather than in errors.ts, which this route does not own.
 */
const uploadBodyParser: RequestHandler = (() => {
  const parse = raw({
    type: "application/octet-stream",
    limit: FILE_UPLOAD_MAX_BYTES,
  });

  return (req, res, next) => {
    parse(req, res, (error?: unknown) => {
      const status = (error as { status?: number; statusCode?: number } | null)
        ?.status;
      if (error && status === 413) {
        next(
          new HttpError(
            413,
            "That image is too large to upload.",
            "FILE_TOO_LARGE",
          ),
        );
        return;
      }
      next(error);
    });
  };
})();

const isFileScope = (value: unknown): value is FileScope =>
  typeof value === "string" &&
  (FILE_SCOPES as readonly string[]).includes(value);

/**
 * Resolves an on-disk path, rejecting anything that escapes the scope root.
 *
 * Every component is validated against an allowlist first; the realpath-style
 * prefix assertion is the belt to that pair of braces.
 */
const resolveFilePath = (
  filesDir: string,
  scope: FileScope,
  containerId: string,
  fileId: string,
): string => {
  if (!isFileScope(scope)) {
    throw badRequest("Unknown file scope.");
  }
  if (!RE_FILE_ID.test(containerId) || !RE_FILE_ID.test(fileId)) {
    throw badRequest("Malformed file identifier.");
  }

  const scopeRoot = path.resolve(filesDir, scope);
  const resolved = path.resolve(scopeRoot, containerId, fileId);

  if (
    resolved !== scopeRoot &&
    !resolved.startsWith(`${scopeRoot}${path.sep}`)
  ) {
    throw badRequest("Malformed file identifier.");
  }

  return resolved;
};

export const createFilesRouter = (ctx: LawhaContext): Router => {
  const router = Router();

  // Two guards, one per verb, and they are not interchangeable.
  //
  // This router used to share a single `requireAuth(ctx)` between POST and
  // GET. The guest principal was invented for share links and wired into
  // scene.ts and boards.ts, and nothing told this file — so a visitor holding
  // a valid board-scoped pass could fetch the board, fetch its scene, join its
  // room, and then get a 401 for every image byte in it. The board rendered
  // with holes where the pictures were. It stayed invisible because you never
  // fetch your own images (they are already in your file map) and signed-in
  // peers were fine; only accountless guests broke.
  //
  // The asymmetry is the point: reading is widened to guests, writing is not.
  const auth = requireAuth(ctx);
  const authOrGuest = requireAuth(ctx, { allowGuest: true });

  /**
   * May this principal touch this container, and on what terms.
   *
   * Takes a `Principal` rather than a user id on purpose. The obvious reuse —
   * `ctx.canAccessBoard(userId, boardId)` — hardcodes `{ id: userId }` and so
   * drops `isGuest` and `guestBoardId`, and those two fields *are* the
   * board-scoping that stops a pass minted for one board from unlocking
   * another board's files. A guest resolved through the wrong door looks like
   * an ordinary account whose id happens to match nothing.
   *
   * Returns the resolved permission so the caller can gate *writing* on
   * `canEdit` separately: this file answered both questions with `canAccess`,
   * which let a viewer — by role or by a `view` link — write arbitrary blobs
   * into a board's file directory that they are refused the scene write for.
   * Invariant 21: a permission enforced in one layer is not enforced.
   *
   * `null` means the container is not board-scoped, which only `shareLinks` is.
   */
  const assertContainerAccess = (
    principal: Principal,
    scope: FileScope,
    containerId: string,
  ): BoardPermission | null => {
    if (scope !== "rooms") {
      // Share-link files are addressed by an unguessable id and are not
      // board-scoped, so there is no ACL to consult — which is exactly why a
      // guest must not reach this early return. Its pass is scoped to one
      // board; there is no board here to scope it to, so honouring it would
      // trade a link for one board into a key to every share-link container on
      // the server. And the ids are content hashes of the PLAINTEXT, so anyone
      // holding the same image can compute one and probe for it. Avatars could
      // drop auth entirely because `avatar_on_cursor` is a consent flag; there
      // is no equivalent here, so this stays behind a full session.
      if (principal.isGuest) {
        throw unauthorized();
      }
      return null;
    }
    if (!isValidRoomId(containerId)) {
      throw badRequest("Malformed board id.");
    }

    const permission = ctx.resolveBoardPermission(principal, containerId);
    if (!permission.canAccess) {
      throw forbidden();
    }
    return permission;
  };

  router.post(
    "/:scope/:containerId/:fileId",
    auth,
    uploadBodyParser,
    asyncHandler(async (req, res) => {
      const { scope, containerId, fileId } = req.params as {
        scope: string;
        containerId: string;
        fileId: string;
      };

      if (!isFileScope(scope)) {
        throw badRequest("Unknown file scope.");
      }

      const permission = assertContainerAccess(
        principalOf(req),
        scope,
        containerId,
      );

      // The check this route never had. `scene.ts` refuses a viewer's write and
      // this one accepted it, so the same person who could not save the board
      // could still write up to 4 MiB into its file directory and get a `files`
      // row credited to them. Two layers disagreeing about one permission is
      // the hole invariant 21 exists to describe.
      if (permission && !permission.canEdit) {
        throw forbidden("You have view-only access to this board.");
      }

      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw badRequest("Empty file payload.");
      }

      const target = resolveFilePath(
        ctx.config.filesDir,
        scope,
        containerId,
        fileId,
      );

      // File ids are content hashes, so an existing file is already correct.
      const existing = await fs.stat(target).catch(() => null);
      if (existing) {
        ctx.files.record({
          scope,
          containerId,
          fileId,
          byteSize: existing.size,
          createdBy: req.user!.id,
        });
        res.status(200).json({ existed: true });
        return;
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      // Write-then-rename so a torn write never surfaces as a valid file.
      const tmp = `${target}.tmp-${crypto.randomBytes(6).toString("hex")}`;
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, target);

      ctx.files.record({
        scope,
        containerId,
        fileId,
        byteSize: body.byteLength,
        createdBy: req.user!.id,
      });

      res.status(201).json({ existed: false });
    }),
  );

  router.get(
    "/:scope/:containerId/:fileId",
    // The read side, and the only place in this file a guest is admitted.
    // Note what is deliberately not done here: `principalOf(req)` is used
    // instead of `req.user!.id`, because `requireAuth` leaves `req.user`
    // undefined for a guest on purpose. Flipping the flag on its own would
    // have turned the 401 into a TypeError 500 — a different failure, not a
    // fix.
    authOrGuest,
    asyncHandler(async (req, res) => {
      const { scope, containerId, fileId } = req.params as {
        scope: string;
        containerId: string;
        fileId: string;
      };

      if (!isFileScope(scope)) {
        throw badRequest("Unknown file scope.");
      }
      assertContainerAccess(principalOf(req), scope, containerId);

      const target = resolveFilePath(
        ctx.config.filesDir,
        scope,
        containerId,
        fileId,
      );
      const body = await fs.readFile(target).catch(() => null);

      if (!body) {
        throw notFound("File not found.");
      }

      res
        .status(200)
        .set({
          "Content-Type": "application/octet-stream",
          // Safe to cache forever: the id is a content hash.
          "Cache-Control": `public, max-age=${FILE_CACHE_MAX_AGE_SEC}, immutable`,
          ETag: `"${fileId}"`,
        })
        .send(body);
    }),
  );

  return router;
};

export { resolveFilePath };
