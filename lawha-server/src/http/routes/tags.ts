import { Router } from "express";
import { z } from "zod";

import { toPublicTag } from "../../db/repositories/tags.js";
import { asyncHandler, conflict, notFound } from "../middleware/errors.js";
import { requireAuth } from "../middleware/requireAuth.js";

import type { LawhaContext } from "../../context.js";

/** Any CSS colour the dashboard's palette offers, or none. */
/**
 * A palette index, not a colour.
 *
 * Copied from `folders.ts` including the 0-255 bound, which is deliberately
 * wider than `COLLABORATOR_PALETTE.length`: a thirteenth colour can then ship
 * without a migration, so an index this build has never heard of is an
 * expected input rather than a bug. `folderColor` and `tagColor` both fall
 * back rather than assert. Invariant 16 — colours cross the wire as palette
 * indices, never hex.
 */
const colorIndexSchema = z.number().int().min(0).max(255).nullable();

const createTagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  colorIndex: colorIndexSchema.optional(),
});

const updateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    colorIndex: colorIndexSchema.optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.colorIndex !== undefined,
    "Nothing to update.",
  );

/**
 * Tags are per-person, so every route here is scoped to the caller and there
 * is no board authorization to do: you cannot reach someone else's tag by id,
 * because the lookup filters on ownership first.
 */
export const createTagsRouter = (ctx: LawhaContext): Router => {
  const router = Router();
  const auth = requireAuth(ctx);

  const ownTag = (userId: string, tagId: string) => {
    const tag = ctx.tags.findById(tagId);
    if (!tag || tag.owner_id !== userId) {
      // 404 rather than 403: whether a tag id exists at all is not something
      // a stranger needs to learn.
      throw notFound("No such tag.");
    }
    return tag;
  };

  router.get(
    "/",
    auth,
    asyncHandler(async (req, res) => {
      res.json({
        tags: ctx.tags.listForUser(req.user!.id).map(toPublicTag),
      });
    }),
  );

  router.post(
    "/",
    auth,
    asyncHandler(async (req, res) => {
      const { name, colorIndex } = createTagSchema.parse(req.body ?? {});
      // Idempotent by name: the dashboard creates tags by typing one, and
      // typing an existing name should attach it, not fail.
      const tag = ctx.tags.create(req.user!.id, name, colorIndex ?? null);

      res.status(201).json({ tag: toPublicTag({ ...tag, boardCount: 0 }) });
    }),
  );

  router.patch(
    "/:tagId",
    auth,
    asyncHandler(async (req, res) => {
      const tag = ownTag(req.user!.id, req.params.tagId!);
      const params = updateTagSchema.parse(req.body ?? {});

      if (params.name !== undefined) {
        const clash = ctx.tags.findByName(req.user!.id, params.name);
        if (clash && clash.id !== tag.id) {
          throw conflict("You already have a tag with that name.", "TAG_TAKEN");
        }
      }

      const updated = ctx.tags.update(tag.id, params);
      res.json({
        tag: updated ? toPublicTag({ ...updated, boardCount: 0 }) : null,
      });
    }),
  );

  router.delete(
    "/:tagId",
    auth,
    asyncHandler(async (req, res) => {
      const tag = ownTag(req.user!.id, req.params.tagId!);
      // board_tags cascades: this unlabels boards, it never deletes one.
      ctx.tags.delete(tag.id);

      res.status(204).end();
    }),
  );

  return router;
};
