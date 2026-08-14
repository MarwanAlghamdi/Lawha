import { Router } from "express";
import { z } from "zod";

import { asyncHandler, conflict, notFound } from "../middleware/errors.js";
import { requireAuth } from "../middleware/requireAuth.js";

import type { LawhaContext } from "../../context.js";
import type { FolderRow, PublicFolder } from "../../db/repositories/folders.js";

/**
 * Longer than a tag's 40 because a folder name is a heading rather than a chip
 * — "Client work — Q3 2026" is a plausible one — and still bounded, because it
 * is rendered in a fixed-width sidebar rail.
 */
const folderNameSchema = z.string().trim().min(1).max(60);

/**
 * An index into the dashboard's folder palette, or none.
 *
 * Bounded loosely rather than pinned to the palette's current length: the
 * client falls back when it does not recognise an index, and a server that
 * refused index 12 the day a thirteenth colour shipped would break every client
 * that had already updated. Negative and fractional are refused because those
 * are bugs, not future colours.
 */
const colorIndexSchema = z.number().int().min(0).max(255).nullable();

const createFolderSchema = z.object({
  name: folderNameSchema,
  parentId: z.string().min(1).nullable().optional(),
  colorIndex: colorIndexSchema.optional(),
});

/**
 * Every field optional, and `parentId: null` is a real instruction.
 *
 * A PATCH carrying `parentId` **is** the move; there is no second endpoint. The
 * `.nullable().optional()` pair is doing real work: absent means "leave the
 * parent alone", explicit null means "make this a root folder", and collapsing
 * them would make dragging a folder back out to the top level impossible.
 */
const updateFolderSchema = z
  .object({
    name: folderNameSchema.optional(),
    parentId: z.string().min(1).nullable().optional(),
    colorIndex: colorIndexSchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.parentId !== undefined ||
      value.colorIndex !== undefined,
    "Nothing to update.",
  );

export const toPublicFolder = (row: FolderRow): PublicFolder => ({
  id: row.id,
  name: row.name,
  parentId: row.parent_id,
  colorIndex: row.color_index,
  // Freshly created, so nothing is filed in it yet by definition. The list
  // endpoint is the one that resolves real counts.
  boardCount: 0,
  createdAt: row.created_at,
});

/**
 * Folders are per-person, so every route here is scoped to the caller and
 * there is no board authorization to do: you cannot reach someone else's
 * folder by id, because the lookup filters on ownership first.
 *
 * Filing a *board* into a folder is not here — it is `folderId` on
 * `PATCH /api/boards/:id`, because that is the one place that already knows
 * whether the caller may see the board at all.
 */
export const createFoldersRouter = (ctx: LawhaContext): Router => {
  const router = Router();
  const auth = requireAuth(ctx);

  const ownFolder = (userId: string, folderId: string): FolderRow => {
    const folder = ctx.folders.findById(folderId);
    if (!folder || folder.owner_id !== userId) {
      // 404 rather than 403, matching the tags router: whether a folder id
      // exists at all is not something a stranger needs to learn. The board
      // PATCH route answers 403 instead, and deliberately — there the caller
      // has *named* a folder as part of an operation on a board they can
      // reach, so silence would look like the filing simply did not take.
      throw notFound("No such folder.");
    }
    return folder;
  };

  /**
   * The parent a request named, validated as one of *this caller's* folders.
   *
   * Undefined means the request did not mention a parent; null means the root.
   * Answering 404 for someone else's folder id keeps the same rule as
   * `ownFolder` — a stranger learns nothing about which ids exist.
   */
  const ownParent = (
    userId: string,
    parentId: string | null,
  ): string | null => {
    if (parentId === null) {
      return null;
    }
    return ownFolder(userId, parentId).id;
  };

  /** Re-reads the real count, so a fresh write never renders as an empty folder. */
  const counted = (userId: string, row: FolderRow): PublicFolder =>
    ctx.folders.listForUser(userId).find((entry) => entry.id === row.id) ??
    toPublicFolder(row);

  router.get(
    "/",
    auth,
    asyncHandler(async (req, res) => {
      res.json({ folders: ctx.folders.listForUser(req.user!.id) });
    }),
  );

  router.post(
    "/",
    auth,
    asyncHandler(async (req, res) => {
      const params = createFolderSchema.parse(req.body ?? {});
      const parentId = ownParent(req.user!.id, params.parentId ?? null);

      if (ctx.folders.findSibling(req.user!.id, parentId, params.name)) {
        // Not idempotent-by-name like a tag: "New folder" is an explicit
        // action, and handing back the existing one would look like the new
        // folder failed to appear. Scoped to the parent, because two projects
        // are each allowed a "Drafts".
        throw conflict(
          "You already have a folder with that name here.",
          "FOLDER_TAKEN",
        );
      }

      res.status(201).json({
        folder: toPublicFolder(
          ctx.folders.create(req.user!.id, {
            name: params.name,
            parentId,
            colorIndex: params.colorIndex ?? null,
          }),
        ),
      });
    }),
  );

  router.patch(
    "/:folderId",
    auth,
    asyncHandler(async (req, res) => {
      const folder = ownFolder(req.user!.id, req.params.folderId!);
      const params = updateFolderSchema.parse(req.body ?? {});

      // Where this folder will live once the patch lands — the folder's own
      // parent when the request said nothing about it. Both the cycle check and
      // the name check are asked about the *destination*, not the origin;
      // asking about the origin is how a rename-and-move in one PATCH slips a
      // duplicate past the unique index.
      const nextParent =
        params.parentId === undefined
          ? folder.parent_id
          : ownParent(req.user!.id, params.parentId);

      if (
        params.parentId !== undefined &&
        nextParent !== null &&
        ctx.folders.isDescendant(folder.id, nextParent)
      ) {
        // Includes moving a folder into itself. Both make a cycle, and a cycle
        // is not a rendering problem to work around later: the sidebar's
        // recursive walk would never terminate.
        throw conflict(
          "A folder cannot be moved inside itself.",
          "FOLDER_CYCLE",
        );
      }

      const nextName = params.name ?? folder.name;
      const clash = ctx.folders.findSibling(req.user!.id, nextParent, nextName);
      if (clash && clash.id !== folder.id) {
        throw conflict(
          "You already have a folder with that name here.",
          "FOLDER_TAKEN",
        );
      }

      const updated = ctx.folders.update(folder.id, params)!;
      // Re-read the count rather than reporting 0: the client renders the
      // folder straight back into the sidebar, and an edit that appeared to
      // empty it would read as data loss.
      res.json({ folder: counted(req.user!.id, updated) });
    }),
  );

  router.delete(
    "/:folderId",
    auth,
    asyncHandler(async (req, res) => {
      const folder = ownFolder(req.user!.id, req.params.folderId!);
      // Promotes rather than destroys: child folders and filed boards move up
      // to this folder's own parent, or become unfiled when it was a root
      // folder — which is exactly what deleting a folder did before nesting
      // existed. It could not undo the alternative if it got it wrong; the
      // server has never held a key, so a deleted scene is gone.
      ctx.folders.delete(folder.id);

      res.status(204).end();
    }),
  );

  return router;
};
