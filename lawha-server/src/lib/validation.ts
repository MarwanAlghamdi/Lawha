import { z } from "zod";

/**
 * Names that would collide with routes or read as official.
 * `b` is reserved because board URLs live at /b/<id>.
 *
 * `anonymous` is here for a stronger reason than either: the server gives that
 * exact name meaning. `resolveAnonymousUser` looks its row up **by username**,
 * so a stranger who registered it owned the account every unauthenticated
 * visitor is handed the moment `LAWHA_REQUIRE_AUTH` is turned off — and one
 * `GET /admin/users` filters out, so no administrator could see or disable it.
 * Registering it returned 201 until the audit of 2026-08-07 (finding 13(c)).
 */
const RESERVED_USERNAMES = new Set([
  "admin",
  "anonymous",
  "api",
  "b",
  "lawha",
  "me",
  "new",
  "root",
  "signin",
  "signup",
  "system",
]);

/**
 * 3-32 chars, alphanumeric with inner dots/dashes/underscores. Anchored so a
 * username can never start or end with punctuation.
 */
const RE_USERNAME = /^[a-z0-9](?:[a-z0-9_.-]{1,30})[a-z0-9]$/;

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters.")
  .max(32, "Username must be at most 32 characters.")
  .refine(
    (value) => RE_USERNAME.test(value.toLowerCase()),
    "Use letters, numbers, dots, dashes or underscores; start and end with a letter or number.",
  )
  .refine(
    (value) => !RESERVED_USERNAMES.has(value.toLowerCase()),
    "That username is reserved.",
  );

/**
 * Length only.
 *
 * There was a blocklist of common passwords here; it was removed on request.
 * The argument for keeping it is weak in this deployment anyway: a private
 * network with a named administrator, rate limiting that is per-username rather
 * than per-IP, and argon2id at ~50ms a guess. 128 bounds argon2's input.
 */
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(128, "Password must be at most 128 characters.");

export const credentialsSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

/**
 * Minting a password reset code from `/admin` (design spec §2).
 *
 * `lock` is the only field, because it is the only difference between the
 * two actions the panel offers: "send a reset code" (`false`, the default —
 * nothing about the account changes) versus "lock and reset" (`true` — the
 * password is invalidated and every session revoked immediately). Both mint
 * the same kind of code either way.
 */
export const adminResetCodeSchema = z.object({
  lock: z.boolean().optional().default(false),
});

export const adminSetDisabledSchema = z.object({
  disabled: z.boolean(),
});

/**
 * Creating an account from the administration panel.
 *
 * `password` optional rather than required: omitting it asks the server to
 * generate one, which is what an administrator setting somebody up over the
 * phone wants.
 *
 * An absent key rather than a `generate: true` flag, and now the only schema
 * in this file that mints a credential at all. The removed
 * `adminSetPasswordSchema` spelled the same idea as an explicit flag because
 * it had a second shape to distinguish it from; there is nothing to
 * *re*generate on a brand-new account, so a flag reading "regenerate" would
 * have been the wrong word even before that schema went.
 */
export const adminCreateUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema.optional(),
  isAdmin: z.boolean().optional(),
});

export const adminSetRoleSchema = z.object({
  isAdmin: z.boolean(),
});

/**
 * Re-entering a password to release a backup download.
 *
 * Deliberately NOT `passwordSchema`: that one enforces the rules for choosing
 * a password, and this is checking one that already exists. Running the
 * strength rules here would refuse a correct password set before those rules
 * were tightened, and would leak which passwords are too short by answering
 * 400 instead of 401.
 *
 * The upper bound is a denial-of-service guard, not a policy: argon2 hashes
 * whatever it is handed, and this router will not spend that on a megabyte.
 */
export const adminBackupStepUpSchema = z.object({
  password: z.string().min(1).max(200),
});

/** Login must not apply registration rules to an existing account's password. */
export const loginSchema = z.object({
  username: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

/**
 * Redeeming a one-time code at `POST /api/auth/reset/:code` (design spec §5).
 *
 * One field, and no `currentPassword`, because the whole premise of the route
 * is somebody who cannot supply one — the code is the entire credential there,
 * and it arrives in the path rather than the body, so it is not part of this
 * schema at all.
 *
 * `passwordSchema` rather than `changePasswordSchema`'s loose pair: this IS a
 * password being chosen, so the same length rules the sign-up form applies
 * have to apply here too. That is also what makes "Password must be at least 8
 * characters." reach the reset page as a 400 with a real sentence rather than
 * a generic refusal — invariant 24, the client must know what the server will
 * refuse.
 */
export const resetPasswordSchema = z.object({
  newPassword: passwordSchema,
});

/**
 * The size of COLLABORATOR_PALETTE in packages/common/src/colors.ts. Duplicated
 * rather than imported: the server must never depend on the editor packages,
 * and a twelve-value enum is not worth a shared package.
 *
 * It was `5` for as long as the palette had five entries, and stayed `5` after
 * ADR 0003 grew it to twelve — so indices 5-11 were refused with a 400 and
 * more than half the wheel was unreachable through the API. Nothing caught it:
 * `clients.test.ts` asserts the *client* number and says this copy is checked
 * "from here", which it never was. The laser picker paints all twelve swatches,
 * so seven of them simply failed to save. The pinning test now lives on this
 * side of the wire as well, where the bound actually is.
 */
export const COLLABORATOR_PALETTE_SIZE = 12;

/**
 * Profile edits. Both fields are optional, and `colorIndex: null` is
 * meaningfully different from omitting it — it clears the choice and returns
 * the user to the hashed default.
 */
const paletteIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(COLLABORATOR_PALETTE_SIZE - 1)
  .nullable()
  .optional();

export const updateProfileSchema = z
  .object({
    username: usernameSchema.optional(),
    colorIndex: paletteIndexSchema,
    /** null means "follow my cursor colour". */
    laserColorIndex: paletteIndexSchema,
    /**
     * Show my profile picture as my canvas cursor.
     *
     * A plain optional boolean with no default: omitting it must leave the
     * stored choice alone, and a default here would turn every patch that
     * touches only the username into a silent opt-out.
     */
    avatarOnCursor: z.boolean().optional(),
  })
  // Every field is optional, so this is the only thing standing between an
  // empty body and an UPDATE that writes nothing and reports success. Note
  // that it counts *any* present field: a request carrying only
  // `avatarOnCursor` is a legitimate patch, and the bug ADR 0003 records is
  // exactly what happens when one setting is left out of this count — the
  // laser colour was dirty, the body was built from the other two fields, and
  // the server answered 400 "Nothing to update" to a save the user had asked
  // for. Anything added above must be reachable on its own.
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "Nothing to update.",
  );

/**
 * Named sharing.
 *
 * `owner` is offered because handing a board over is a real need on a shared
 * server, and the alternative — deleting and recreating it — costs the scene.
 * The route refuses to strip the board row's own `owner_id`, so there is
 * always at least one.
 */
export const boardRoleSchema = z.enum(["owner", "editor", "viewer"]);

export const setMemberSchema = z.object({
  role: boardRoleSchema,
});

/** The people picker's typeahead. Empty means "the first page of everyone". */
export const memberSearchSchema = z.object({
  q: z.string().trim().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/**
 * Deleting an account is irreversible and takes every board with it, so it is
 * re-authenticated rather than merely session-authenticated.
 */
/**
 * The typed-back username that confirms an administrator's delete (ADR 0031).
 *
 * Deliberately NOT `usernameSchema`. That one validates the shape of a name
 * somebody is about to *create* — length, character set, reserved words — and
 * none of that is the question here. This field confirms a name that already
 * exists, and the only check that matters is made in the route, against the
 * target row. Reusing the stricter schema would reject a legitimate
 * confirmation of a legacy username that no longer passes today's rules, which
 * is precisely the account most likely to be getting deleted.
 */
export const adminDeleteAccountSchema = z.object({
  username: z.string().min(1).max(64),
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128),
});

export const normalizeUsername = (username: string): string =>
  username.trim().toLowerCase();
