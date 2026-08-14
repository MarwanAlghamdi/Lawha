import { STORAGE_KEYS } from "../app_constants";

/**
 * Which board the local scene cache belongs to.
 *
 * `LocalData` writes the scene to one fixed localStorage key. That was correct
 * while there was exactly one board; with a dashboard it means opening board B
 * shows board A's elements, because both read the same slot.
 *
 * Rather than thread a board id through `LocalData.save`, its debounce, the
 * unload handler, the cross-tab sync, and every call site, the id lives here
 * and the storage keys are derived from it. The board route sets it before the
 * editor mounts; nothing else may write it.
 *
 * Deliberately module state and not a React context: `LocalData.save` is called
 * from a debounced callback and from `beforeunload`, neither of which is inside
 * a render.
 */
let currentBoardId: string | null = null;

/**
 * The open board's room key, once the board route has resolved it.
 *
 * It lives here for one reason: `getBoardLinkData` is synchronous and the key
 * store is not. A board opened from the dashboard has a clean `/b/<id>` URL
 * with no `#key=` fragment — the key was already on this device — and without
 * somewhere sync to read it, that URL is indistinguishable from a board link
 * whose key is missing.
 */
let currentBoardKey: string | null = null;

export const setCurrentBoardId = (boardId: string | null): void => {
  if (boardId !== currentBoardId) {
    // Cleared with the id, never carried over. A key that outlived its board
    // would encrypt the next board's scene under the previous board's key,
    // which is unrecoverable rather than merely wrong.
    currentBoardKey = null;
  }
  currentBoardId = boardId;
};

export const getCurrentBoardId = (): string | null => currentBoardId;

export const setCurrentBoardKey = (
  boardId: string,
  key: string | null,
): void => {
  // Guarded by id because the key resolves asynchronously: a slow lookup for
  // the board the user just navigated away from must not land on the new one.
  if (boardId === currentBoardId) {
    currentBoardKey = key;
  }
};

export const getCurrentBoardKey = (boardId: string): string | null =>
  boardId === currentBoardId ? currentBoardKey : null;

/**
 * Namespaces a storage key by board.
 *
 * With no board set the unsuffixed key is used, which is what keeps a scene
 * drawn before this existed — and the `/excalidraw-plus-export` route, which
 * has no board — reading and writing where they always did.
 */
export const boardScopedKey = (key: string): string =>
  currentBoardId === null ? key : `${key}:${currentBoardId}`;

export const scopedElementsKey = (): string =>
  boardScopedKey(STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS);

export const scopedAppStateKey = (): string =>
  boardScopedKey(STORAGE_KEYS.LOCAL_STORAGE_APP_STATE);

/**
 * Removes a board's local cache. Called when a board is deleted, so its
 * elements do not sit in localStorage indefinitely after the row is gone.
 */
export const clearBoardCache = (boardId: string): void => {
  try {
    localStorage.removeItem(
      `${STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS}:${boardId}`,
    );
    localStorage.removeItem(
      `${STORAGE_KEYS.LOCAL_STORAGE_APP_STATE}:${boardId}`,
    );
  } catch (error) {
    console.warn("lawha: could not clear a board's local cache", error);
  }
};
