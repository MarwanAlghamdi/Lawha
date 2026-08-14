import { createStore, del, get, set } from "idb-keyval";

/**
 * The keys for boards stored before ADR 0012, and nothing else.
 *
 * **This file is a remnant on purpose, and it is the last copy of something.**
 * Scenes are plaintext now, so a board created since needs no key and never
 * touches this. What is left here exists for one reason: four boards on this
 * deployment are still stored as ciphertext, the server cannot open any of them
 * — that is *why* they are stuck — and their keys exist nowhere except the
 * IndexedDB of the browser that made them. Migration 013 dropped every
 * server-side copy precisely because the server had nothing useful to lose;
 * dropping this store as well would have destroyed those four for good.
 *
 * So it stays until the last stored ciphertext is gone, and then it goes.
 * `lawha-server/scripts/convert-plaintext.mjs` prints the count.
 *
 * What used to be here and is not:
 *
 *  - the escrow (`keyEscrow.ts`) — a second copy on the server wrapped under a
 *    key derived from the account password, plus the sync that reconciled the
 *    two. That is what made a board unopenable until somebody typed a password,
 *    and it is deleted along with the tables behind it.
 *  - `fetchBoardKeyFromServer` — the handout that made every board openable
 *    while the estate converted. `GET /api/keys/boards/:id` no longer exists.
 *  - `getOpenableBoardIds` / `syncEscrowedKeys` — the dashboard drew a padlock
 *    over the difference between the board list and this store. A board it can
 *    list is a board it can open.
 *
 * IndexedDB rather than localStorage: localStorage is the first thing a "clear
 * site data" sweep takes, and it keeps keys out of a store that synchronous
 * code all over the app reads and writes. **Scoped per ORIGIN**, which is the
 * property that makes those four boards awkward — the same person on the same
 * laptop has disjoint stores at `https://lawha.local` and at an IP, so a board
 * only converts at the address it was created on.
 */
const keyStore = createStore("lawha-board-keys", "keys");

/** Guards against a malformed value round-tripping into the crypto layer. */
const RE_ROOM_KEY = /^[a-zA-Z0-9_-]{22}$/;

export const isValidBoardKey = (value: unknown): value is string =>
  typeof value === "string" && RE_ROOM_KEY.test(value);

export const getBoardKey = async (boardId: string): Promise<string | null> => {
  try {
    const stored = await get<string>(boardId, keyStore);
    return isValidBoardKey(stored) ? stored : null;
  } catch (error) {
    // A browser with IndexedDB disabled (private windows in some engines) is
    // still usable — a board created since ADR 0012 needs nothing from here.
    console.warn("lawha: could not read the board key store", error);
    return null;
  }
};

export const rememberBoardKey = async (
  boardId: string,
  boardKey: string,
): Promise<void> => {
  if (!isValidBoardKey(boardKey)) {
    throw new Error("lawha: refusing to store a malformed board key");
  }
  try {
    await set(boardId, boardKey, keyStore);
  } catch (error) {
    console.warn("lawha: could not write the board key store", error);
  }
};

export const forgetBoardKey = async (boardId: string): Promise<void> => {
  try {
    await del(boardId, keyStore);
  } catch (error) {
    console.warn("lawha: could not remove a board key", error);
  }
};

/**
 * Resolves the key for a board: the link, then this device. Local only.
 *
 * A link still wins over the store, and it is now the only way a key can reach
 * a browser that does not already hold one — an old `#key=` link keeps working,
 * and seeing the key means being entitled to it, so it is remembered on the way
 * through and the fragment can then be dropped.
 *
 * Null is the ordinary answer and not a failure. Every board created since ADR
 * 0012 resolves to null and opens perfectly well; the key is consulted only if
 * the stored scene turns out to still be ciphertext.
 */
export const resolveBoardKey = async (
  boardId: string,
  keyFromLink: string | null,
): Promise<string | null> => {
  if (isValidBoardKey(keyFromLink)) {
    await rememberBoardKey(boardId, keyFromLink);
    return keyFromLink;
  }
  return getBoardKey(boardId);
};
