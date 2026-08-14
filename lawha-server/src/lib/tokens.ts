import crypto from "node:crypto";

/** Mirrors ROOM_ID_BYTES in excalidraw-app/app_constants.ts. */
const BOARD_ID_BYTES = 10;
const USER_ID_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;
/**
 * Same length as SESSION_TOKEN_BYTES, not a coincidence: a password reset
 * code is the entire credential on its redemption route (design spec §5), no
 * session or username alongside it, so it needs a session token's entropy
 * budget rather than the shorter, spoken shape `lib/inviteCode.ts` uses for a
 * code that always travels with a board id.
 */
const RESET_CODE_BYTES = 32;

const hex = (bytes: number): string =>
  crypto.randomBytes(bytes).toString("hex");

export const generateUserId = (): string => hex(USER_ID_BYTES);

/** 20 hex chars, matching the client's room id shape. */
export const generateBoardId = (): string => hex(BOARD_ID_BYTES);

export const generateTagId = (): string => hex(USER_ID_BYTES);

/**
 * 32 hex chars, like a tag id.
 *
 * Deliberately not `generateBoardId`: a folder id is never a socket.io room id
 * and never appears in a URL fragment, so it has no reason to inherit the
 * client's 20-char room shape or to be validated by `isValidRoomId`.
 */
export const generateFolderId = (): string => hex(USER_ID_BYTES);

export const generateSessionToken = (): string =>
  crypto.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");

/**
 * Sessions are stored hashed. The token already carries 256 bits of entropy,
 * so a fast hash is the right choice here — argon2 would buy nothing.
 */
export const hashSessionToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

export const randomSuffix = (): string => hex(8);

/**
 * A one-time password reset code (design spec §5). base64url rather than hex
 * so the same entropy fits in a shorter string; it has no `/` or `+`, so it
 * is safe unescaped as a URL path segment (`/reset/:code`).
 */
export const generatePasswordResetCode = (): string =>
  crypto.randomBytes(RESET_CODE_BYTES).toString("base64url");

/**
 * Reset codes are stored hashed, the same way `hashSessionToken` protects
 * `sessions.token_hash` (001_init.sql) — and for the same reason: the code
 * already carries 256 bits of entropy, so a fast hash is enough, and design
 * spec §5 calls it "the entire credential" on its redemption route, which is
 * the same property that makes hashing the right call for a session token.
 * A leaked `password_reset_codes` table in the clear would have handed over
 * every live, unexpired reset link outright, no cracking required; hashed,
 * it gives up nothing a leaked `sessions` table does not already have to
 * withstand.
 */
export const hashResetCode = (code: string): string =>
  crypto.createHash("sha256").update(code).digest("hex");
