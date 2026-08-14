import type { BoardThumbnail } from "./boardThumbnail";

/**
 * The two strings a board card and a Details row both need, in one place so the
 * grid and the list cannot describe the same board differently.
 */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

/** "3 days ago", falling back to "just now" under a minute. */
export const describeAge = (timestamp: number): string => {
  const elapsed = Date.now() - timestamp;

  for (const [unit, ms] of UNITS) {
    if (elapsed >= ms) {
      return RELATIVE.format(-Math.floor(elapsed / ms), unit);
    }
  }
  return "just now";
};

/**
 * How much is on a board — or why this device cannot say.
 *
 * Four outcomes, and keeping them apart is the whole job. The server holds
 * ciphertext and has never been able to count anything, so this number only
 * exists once *this* device has decrypted the scene:
 *
 *   still decrypting     → nothing, and the age beside it carries the row
 *   decrypted, N shapes  → "68 shapes"
 *   decrypted, unusable  → "empty" — there is a key, and nothing drawn
 *   no key on this device → says so, and `sortBoards` puts it last rather than
 *                           treating an unknown count as zero
 *
 * Collapsing the last two into "0 shapes" would assert something false about a
 * board that may well be full.
 */
export const describeShapes = (
  thumbnail: BoardThumbnail | null | undefined,
): string => {
  if (thumbnail) {
    return `${thumbnail.count} ${thumbnail.count === 1 ? "shape" : "shapes"}`;
  }
  // The "not opened yet" case went with `isOpenable`. It meant "this browser
  // holds no key for this board", which stopped being a thing a board can be
  // (ADR 0012). `undefined` here is a thumbnail still being computed and
  // `null` is a board with nothing on it — the two states a caller can still
  // distinguish.
  return thumbnail === null ? "empty" : "";
};
