import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { Router, raw } from "express";

import {
  HttpError,
  asyncHandler,
  badRequest,
  notFound,
} from "../middleware/errors.js";
import { requireAuth } from "../middleware/requireAuth.js";

import type { LawhaContext } from "../../context.js";
import type { NextFunction, Request, Response } from "express";

/**
 * Deliberately not FILE_UPLOAD_MAX_BYTES (4 MiB).
 *
 * That budget is for a pasted screenshot on a canvas, which is looked at
 * full-size. An avatar is rendered at 32 pixels in a member list; half a
 * megabyte is already an order of magnitude more than that needs, and the
 * bytes here are neither encrypted nor garbage-collected with a board, so the
 * cost of being generous is permanent.
 */
export const AVATAR_MAX_BYTES = 512 * 1024;

/** A year, matching FILE_CACHE_MAX_AGE_SEC. */
const AVATAR_CACHE_MAX_AGE_SEC = 31536000;

/** Ids we mint (32 hex chars) plus enough slack for anything already stored. */
const RE_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

const AVATAR_ID_BYTES = 16;

/**
 * The image types an avatar may be, decided by looking at the bytes.
 *
 * SVG is absent and must stay absent. It is not an image but a document: it
 * can carry <script>, and an <img> is not the only way a browser will be asked
 * to render one. Served from this origin — the same origin that holds the
 * session cookie — an uploaded SVG is stored XSS against every page that shows
 * a member list. A Content-Type header is not a defence either, which is why
 * the request's own header is ignored entirely and the response carries
 * X-Content-Type-Options: nosniff.
 */
const sniffImageMime = (body: Buffer): string | null => {
  // PNG: the 8-byte signature, whose \r\n\x1a\n tail also detects mangling by
  // a transport that thought it was carrying text.
  if (
    body.length >= 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47 &&
    body[4] === 0x0d &&
    body[5] === 0x0a &&
    body[6] === 0x1a &&
    body[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: SOI followed by the first marker.
  if (
    body.length >= 3 &&
    body[0] === 0xff &&
    body[1] === 0xd8 &&
    body[2] === 0xff
  ) {
    return "image/jpeg";
  }

  // WebP: a RIFF container whose form type is WEBP. Both halves are required —
  // "RIFF" alone is also WAV and AVI.
  if (
    body.length >= 12 &&
    body.toString("latin1", 0, 4) === "RIFF" &&
    body.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
};

/**
 * Resolves an avatar's path, rejecting anything that escapes the avatars root.
 *
 * The same shape as resolveFilePath in routes/files.ts: an allowlist on every
 * component first, then a prefix assertion as the belt to those braces. Both
 * matter — the allowlist is what stops `..` and the assertion is what catches
 * the day someone widens it.
 */
const resolveAvatarPath = (
  filesDir: string,
  userId: string,
  avatarId: string,
): string => {
  if (!RE_PATH_SEGMENT.test(userId) || !RE_PATH_SEGMENT.test(avatarId)) {
    throw badRequest("Malformed avatar identifier.");
  }

  const avatarsRoot = path.resolve(filesDir, "avatars");
  const resolved = path.resolve(avatarsRoot, userId, avatarId);

  if (
    resolved !== avatarsRoot &&
    !resolved.startsWith(`${avatarsRoot}${path.sep}`)
  ) {
    throw badRequest("Malformed avatar identifier.");
  }

  return resolved;
};

/** The directory holding one user's avatars, for cleanup on account deletion. */
export const resolveAvatarDir = (
  filesDir: string,
  userId: string,
): string | null => {
  if (!RE_PATH_SEGMENT.test(userId)) {
    return null;
  }

  const avatarsRoot = path.resolve(filesDir, "avatars");
  const resolved = path.resolve(avatarsRoot, userId);

  return resolved.startsWith(`${avatarsRoot}${path.sep}`) ? resolved : null;
};

export const createUsersRouter = (ctx: LawhaContext): Router => {
  const router = Router();
  const auth = requireAuth(ctx);

  /** Best effort: a leftover file is waste, not a failure worth a 500. */
  const unlinkAvatar = async (userId: string, avatarId: string | null) => {
    if (!avatarId) {
      return;
    }
    await fs
      .rm(resolveAvatarPath(ctx.config.filesDir, userId, avatarId), {
        force: true,
      })
      .catch(() => undefined);
  };

  router.put(
    "/me/avatar",
    auth,
    // `type` accepts anything so a browser sending image/png works as well as
    // the contracted application/octet-stream. The declared type is never
    // believed; sniffImageMime below is the only thing that decides.
    raw({ type: () => true, limit: AVATAR_MAX_BYTES }),
    asyncHandler(async (req, res) => {
      const userId = req.user!.id;
      const body = req.body as Buffer;

      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw badRequest("Empty avatar payload.");
      }

      const mime = sniffImageMime(body);
      if (!mime) {
        throw badRequest(
          "An avatar must be a PNG, JPEG or WebP image.",
          "UNSUPPORTED_IMAGE",
        );
      }

      // A fresh id every time, so the bytes at a given URL never change and
      // `?v=<avatarId>` is a sound cache buster.
      const avatarId = crypto.randomBytes(AVATAR_ID_BYTES).toString("hex");
      const target = resolveAvatarPath(ctx.config.filesDir, userId, avatarId);

      await fs.mkdir(path.dirname(target), { recursive: true });
      // Write-then-rename, so a torn write never surfaces as a valid avatar.
      const tmp = `${target}.tmp-${crypto.randomBytes(6).toString("hex")}`;
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, target);

      // The row is pointed at the new file only once the new file exists; the
      // other order would leave a 404 for the window in between.
      const { previousAvatarId } = ctx.users.setAvatar(userId, {
        id: avatarId,
        mime,
      });
      await unlinkAvatar(userId, previousAvatarId);

      res.status(204).end();
    }),
  );

  router.delete(
    "/me/avatar",
    auth,
    asyncHandler(async (req, res) => {
      const userId = req.user!.id;
      const { previousAvatarId } = ctx.users.setAvatar(userId, null);
      await unlinkAvatar(userId, previousAvatarId);

      // Idempotent: deleting a picture that was never there is a success, not
      // a 404, or a double-click on the account page would show an error.
      res.status(204).end();
    }),
  );

  /**
   * Reading an avatar is not session-gated, but somebody else's is gated on
   * their own consent.
   *
   * This used to rest entirely on the address: a user id is 16 random bytes, so
   * the endpoint cannot be walked, and an id was only ever handed out alongside
   * a PublicUser to someone already seeing that person's name. That argument
   * died the moment the relay began announcing `lawha-identities`, which puts
   * every co-present peer's account id into the hands of every other peer —
   * including a link guest with no account. Withholding `avatarId` from the
   * identity payload for people who had not opted in then bought nothing: the
   * bytes were still one hand-written request away, keyed on an id the same
   * payload had just supplied.
   *
   * That is invariant 21 in its usual costume — a permission enforced in one
   * layer is not enforced — and the promise being broken was asserted in four
   * places in the code and the ADR. So `avatar_on_cursor` is checked here, at
   * the only door to the bytes, and not merely upstream of it.
   *
   * Still no board ACL: this URL carries no board id, and an ACL over "users
   * who share a board with you" cannot be evaluated without one. The consent
   * flag is the stronger check anyway — it is the person's own decision rather
   * than an inference about who is entitled to see them.
   */
  router.get(
    "/:id/avatar",
    asyncHandler(async (req, res) => {
      const requested = req.params.id as string;
      // `me` is not a valid user id and is a reserved username, so it can be
      // spent as an alias for the caller's own row.
      const userId = requested === "me" ? req.user?.id : requested;

      const user = userId ? ctx.users.findById(userId) : null;

      if (!user?.avatar_id) {
        throw notFound("No avatar.");
      }

      // Your own picture is always yours to fetch, and the account page asks
      // for it by literal id rather than through the `me` alias — so this
      // compares rows, not URLs.
      const isSelf = req.user?.id === user.id;

      // 404 rather than 403: whether a given account has a picture it has
      // chosen not to share is itself not the caller's business, and the two
      // answers should be indistinguishable.
      if (!isSelf && !user.avatar_on_cursor) {
        throw notFound("No avatar.");
      }

      const target = resolveAvatarPath(
        ctx.config.filesDir,
        user.id,
        user.avatar_id,
      );
      const body = await fs.readFile(target).catch(() => null);

      if (!body) {
        throw notFound("No avatar.");
      }

      const etag = `"${user.avatar_id}"`;

      // The URL is keyed on the user, not on the bytes, so `immutable` is only
      // honest once the caller has versioned it — which is what avatarId on
      // PublicUser is for. Unversioned requests get the same body and the same
      // ETag but no freshness lifetime, so a changed avatar shows up on the
      // next load instead of a year later.
      const versioned = req.query.v === user.avatar_id;

      res.set({
        "Content-Type": user.avatar_mime ?? "application/octet-stream",
        // The bytes were sniffed on the way in, but a browser must not be left
        // to re-guess: nosniff is what keeps a crafted file from being treated
        // as anything but the image type declared above.
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": versioned
          ? `public, max-age=${AVATAR_CACHE_MAX_AGE_SEC}, immutable`
          : "public, max-age=0, immutable",
        ETag: etag,
      });

      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }

      res.status(200).send(body);
    }),
  );

  /**
   * Router-scoped, so an oversized upload is the 413 it is rather than the 500
   * the app-wide handler would make of it — that one only understands HttpError
   * and ZodError, and body-parser's PayloadTooLargeError is neither.
   */
  router.use(
    (
      error: unknown,
      _req: Request,
      _res: Response,
      next: NextFunction,
    ): void => {
      if (
        error !== null &&
        typeof error === "object" &&
        (error as { type?: unknown }).type === "entity.too.large"
      ) {
        next(
          new HttpError(
            413,
            `An avatar must be smaller than ${Math.floor(
              AVATAR_MAX_BYTES / 1024,
            )} KB.`,
            "AVATAR_TOO_LARGE",
          ),
        );
        return;
      }
      next(error);
    },
  );

  return router;
};
