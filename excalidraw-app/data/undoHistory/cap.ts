import type { SerialisedDelta } from "./serialise";

/** Spec §4. Both apply; whichever is reached first wins. */
export const MAX_UNDO_ENTRIES = 50;
export const MAX_UNDO_BYTES = 2_000_000;

/**
 * `JSON.stringify(...).length` counts UTF-16 code units, not bytes, and this
 * is a UTF-8 budget: what actually lands in IndexedDB. For ASCII the two
 * measures coincide, which is exactly what makes the mistake easy to ship —
 * it passes any test built from `"x".repeat(n)`. Lawha is an Arabic-named
 * product with Arabic board content, and most non-Latin BMP characters are
 * one UTF-16 code unit but two or more UTF-8 bytes, so a stack measured this
 * way at `.length === 2_000_000` could occupy close to double that on disk —
 * `MAX_UNDO_BYTES` would bound nothing close to what its name promises.
 * `TextEncoder` is the same tool `FileManager.ts` uses for `FILE_UPLOAD_MAX_BYTES`,
 * for the same reason.
 */
const byteLength = (entry: SerialisedDelta): number =>
  new TextEncoder().encode(JSON.stringify(entry)).byteLength;

/**
 * Trim to the newest entries that fit.
 *
 * Oldest first, because undo walks backwards from the end — dropping the tail
 * would throw away the steps a person is about to press undo for and keep the
 * ones they will never reach.
 *
 * The newest entry is kept unconditionally, even when it alone blows the byte
 * budget. Returning an empty history for one large paste would mean the last
 * thing you did is the one thing you cannot undo, which is the opposite of
 * what the budget is for.
 */
export const capHistory = (
  entries: readonly SerialisedDelta[],
): SerialisedDelta[] => {
  const kept: SerialisedDelta[] = [];
  let bytes = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const size = byteLength(entry);

    if (kept.length >= MAX_UNDO_ENTRIES) {
      break;
    }
    if (kept.length > 0 && bytes + size > MAX_UNDO_BYTES) {
      break;
    }

    kept.unshift(entry);
    bytes += size;
  }

  return kept;
};
