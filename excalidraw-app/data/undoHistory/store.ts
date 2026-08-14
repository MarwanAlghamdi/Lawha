import { createStore, del, get, keys, set } from "idb-keyval";

import { capHistory } from "./cap";

import type { SerialisedDelta } from "./serialise";

const historyStore = createStore("lawha-undo-history", "history");

/**
 * Bump when the stored shape or the element schema changes.
 *
 * A delta written by an older build may reference properties a newer element
 * schema no longer has. Applying one best-effort is corruption, so a mismatch
 * discards rather than migrates — the cost is losing undo history across an
 * upgrade, which is a great deal cheaper than a silently mangled board.
 */
export const UNDO_HISTORY_SCHEMA = 2;

/**
 * How long a stored stack outlives the moment it was written.
 *
 * Sign-out clears history, and that was the whole of the privacy story — but
 * sign-out is the one thing a shared machine never does. Without a bound, a
 * browser nobody signs out of accumulates recoverable deleted content from
 * every board for ever, and the 2 MB cap is per board rather than per account,
 * so "bounded" was never bounded in aggregate.
 *
 * 30 days because that is `LAWHA_SESSION_TTL_DAYS` on this deployment: the
 * thing to avoid is history outliving the session that produced it. If the
 * session lifetime changes, this should follow it.
 *
 * Enforced on READ rather than by a sweep. A sweep needs something to run it;
 * a read is the only moment we are certain this code is running at all.
 */
export const UNDO_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type StoredHistory = {
  schema: number;
  /** `Date.now()` at write. Absent means unknown age, which reads as expired. */
  writtenAt: number;
  entries: SerialisedDelta[];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Own shape check, deliberately not borrowed from `ElementsDelta.create`'s
 * invariant checks — those run only under `isTestEnv() || isDevEnv()`
 * (`packages/element/src/delta.ts`), so a vitest run can pass on a payload
 * production would wave through untouched. `boardKeys.ts` does the same
 * thing for board keys with `isValidBoardKey`, for the same reason: nothing
 * downstream of `get<T>` can be trusted just because the generic said so.
 *
 * This stays shallow on purpose — an id and the two delta groups present —
 * rather than replicating `deserialiseDelta`'s deeper `hasRestorableShape`
 * check. That function already owns "does this actually restore into a
 * working `HistoryDelta`" for whoever applies an entry; duplicating it here
 * would just be two places that can disagree about what counts as valid.
 * What this function alone stands between is something far cruder reaching
 * a caller expecting `SerialisedDelta[]`: a stray string, `null`, or a
 * number sitting in the `entries` array.
 */
const isSerialisedDeltaShape = (value: unknown): value is SerialisedDelta =>
  isPlainObject(value) &&
  typeof value.id === "string" &&
  "elements" in value &&
  "appState" in value;

/**
 * The only place `readHistory` decides what it is willing to hand back.
 * Nothing downstream re-validates this, so both checks live here: the
 * schema stamp on the envelope, and the per-entry shape inside it.
 *
 * A schema mismatch discards the WHOLE record — see `UNDO_HISTORY_SCHEMA`.
 * There is nothing to salvage entry-by-entry from a different schema
 * version, because the entries were never promised to look like this one's
 * shape in the first place.
 *
 * Within a record that DOES match, one malformed entry (a truncated write,
 * a browser bug, someone editing IndexedDB by hand) is dropped on its own
 * rather than costing the rest of the stack — the same "drop the entry, not
 * the history" rule `deserialiseDelta` already applies one level down.
 */
const readStoredEntries = (raw: unknown, now: number): SerialisedDelta[] => {
  if (!isPlainObject(raw) || raw.schema !== UNDO_HISTORY_SCHEMA) {
    return [];
  }
  if (!Array.isArray(raw.entries)) {
    return [];
  }
  // A record with no usable timestamp is of unknown age, and unknown age reads
  // as expired: the alternative is content of unbounded age surviving on the
  // strength of a missing field.
  if (typeof raw.writtenAt !== "number" || !Number.isFinite(raw.writtenAt)) {
    return [];
  }
  // A clock that moved backwards lands in the second half of this, and
  // discarding is the same right answer as for something simply too old.
  if (now - raw.writtenAt > UNDO_HISTORY_MAX_AGE_MS || raw.writtenAt > now) {
    return [];
  }
  return raw.entries.filter(isSerialisedDeltaShape);
};

/**
 * Per user AND per board — see the test on leaking between accounts.
 *
 * The ':' is a safe delimiter only because no id minted in this codebase can
 * contain one: `generateUserId` (`lawha-server/src/lib/tokens.ts`) is 32 hex
 * characters, and a guest id (`lawha-server/src/lib/guests.ts`) is `guest_`
 * plus 24 hex characters. Neither alphabet has room for ':', so one user's
 * id can never masquerade as a prefix of another's key — a real id being a
 * literal prefix of another (e.g. "ab" of "abcd1234...") still fails the
 * `startsWith(userId + ":")` check below, because the character right after
 * the shorter id in the longer key is another hex digit, never ':'.
 */
const keyFor = (userId: string, boardId: string): string =>
  `${userId}:${boardId}`;

/**
 * Called on sign-out. Without it, deleted content stays readable on a shared
 * machine by whoever signs in next — the history outliving the session that
 * made it is the whole privacy cost of this feature.
 */
const clearMatchingKeys = async (
  matches: (key: string) => boolean,
  failureMessage: string,
): Promise<void> => {
  try {
    const all = await keys<string>(historyStore);
    await Promise.all(
      all
        .filter((key) => typeof key === "string" && matches(key))
        .map((key) => del(key, historyStore)),
    );
  } catch (error) {
    console.warn(`lawha: ${failureMessage}`, error);
  }
};

export const clearHistoryForUser = async (userId: string): Promise<void> =>
  clearMatchingKeys(
    (key) => key.startsWith(`${userId}:`),
    "could not clear the undo history store",
  );

/**
 * Called when a board is deleted — see `forgetLocally` in `HomeRoute.tsx`,
 * which already drops the board key, the local scene cache and the thumbnail
 * on the reasoning that "leaving them is a copy of the board sitting in the
 * browser for ever". An undo stack is the most literal copy of the four, and
 * uniquely it also holds content the user *deleted* before deleting the
 * board.
 *
 * Every account's copy in this browser goes, not only the signed-in one. The
 * board no longer exists server-side for anybody, so no key here is ever
 * reachable again, and leaving another account's behind would recreate on the
 * delete path exactly the shared-machine leak `clearHistoryForUser` closes on
 * the sign-out one.
 *
 * The ':' delimiter is load-bearing on this side too — `endsWith(boardId)`
 * alone would take "ab1" down with "b1". See `keyFor` for why ':' can never
 * appear inside an id.
 */
export const clearHistoryForBoard = async (boardId: string): Promise<void> =>
  clearMatchingKeys(
    (key) => key.endsWith(`:${boardId}`),
    "could not clear the deleted board's undo history",
  );

export const readHistory = async (
  userId: string,
  boardId: string,
): Promise<SerialisedDelta[]> => {
  try {
    const stored = await get<unknown>(keyFor(userId, boardId), historyStore);
    // Capped on the way out as well as on the way in. With the cap only in
    // `writeHistory`, the bound belongs to whichever build performed the last
    // write rather than to the data: lowering `MAX_UNDO_ENTRIES` or
    // `MAX_UNDO_BYTES` is an ordinary tuning change that `UNDO_HISTORY_SCHEMA`
    // deliberately does not cover — the stored shape is unchanged — so every
    // existing store would keep handing the old, larger stack straight into
    // memory until something happened to rewrite it.
    return capHistory(readStoredEntries(stored, Date.now()));
  } catch (error) {
    // IndexedDB is absent in some private windows. No history is a degraded
    // session, not a broken one — the board itself needs nothing from here.
    console.warn("lawha: could not read the undo history store", error);
    return [];
  }
};

export const writeHistory = async (
  userId: string,
  boardId: string,
  entries: readonly SerialisedDelta[],
): Promise<void> => {
  try {
    const toStore: StoredHistory = {
      schema: UNDO_HISTORY_SCHEMA,
      writtenAt: Date.now(),
      entries: capHistory(entries),
    };
    await set(keyFor(userId, boardId), toStore, historyStore);
  } catch (error) {
    console.warn("lawha: could not write the undo history store", error);
  }
};
