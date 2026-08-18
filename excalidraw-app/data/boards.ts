/**
 * Board metadata (name, sharing, membership), as distinct from the encrypted
 * scene blob in `data/storage`.
 */
import { API_BASE, NGROK_SKIP_HEADER, parseJsonBody } from "./api";

export type LinkAccess = "none" | "view" | "edit";
export type BoardRole = "owner" | "editor" | "viewer";

export interface BoardSummary {
  id: string;
  name: string;
  ownerId: string;
  linkAccess: LinkAccess;
  /** Whether an "edit" link also reaches visitors with no account (ADR 0024). */
  guestEdit: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BoardMember {
  userId: string;
  username: string;
  role: BoardRole;
  addedAt: number;
}

export interface UserCandidate {
  id: string;
  username: string;
}

/**
 * What this visitor may do with this board.
 *
 * `canEdit` is the client half of the check the server now enforces in three
 * places. It drives `viewModeEnabled`, so a viewer is told before they draw
 * rather than after the relay has quietly dropped a minute of their work.
 */
export interface BoardAccess {
  /** False for a board id the client invented and has not yet written. */
  exists: boolean;
  canAccess: boolean;
  canEdit: boolean;
  role: BoardRole | null;
  linkAccess: LinkAccess;
  /** Whether an "edit" link reaches visitors with no account (ADR 0024). */
  guestEdit: boolean;
  /** True when the server minted an account-less, board-scoped pass for us. */
  isGuest: boolean;
}

/** What a client assumes when the access call could not be made at all. */
export const FULL_BOARD_ACCESS: BoardAccess = {
  exists: false,
  canAccess: true,
  canEdit: true,
  role: null,
  linkAccess: "none",
  guestEdit: false,
  isGuest: false,
};

/**
 * What a client knows when the server *refused* the access call.
 *
 * The distinction between this and `FULL_BOARD_ACCESS` above is a bug fix, and
 * the bug was loud. `resolveBoardAccess` used to map every non-2xx to
 * "assume full access and let the server refuse", which is the right answer for
 * a network blip — that reasoning stands, and it is why the optimistic
 * fallback is still there — and the wrong answer for a 401, which is not a
 * blip. It is the server saying, definitively, that this visitor may not.
 *
 * Believing `canEdit: true` after a 401 meant the guard in
 * `Collab.saveCollabRoomToBackend` waved every save through, so an accountless
 * visitor on a board they could not open produced an endless stream of
 * `PUT /api/boards/<id>/scene 401` in the console and a "Could not save the
 * board" dialog every few seconds, on a board they had never been allowed to
 * write. Invariant 24: the client must know what the server will refuse.
 */
export const NO_BOARD_ACCESS: BoardAccess = {
  exists: false,
  canAccess: false,
  canEdit: false,
  role: null,
  linkAccess: "none",
  guestEdit: false,
  isGuest: false,
};

/**
 * Best-effort: never throws.
 *
 * Board metadata is secondary to the session itself. If this endpoint is
 * unreachable, collaboration should still start — the socket may well be fine,
 * and the first scene write creates the board anyway. Letting a rejection
 * escape would abort `startCollaboration` partway through, which is far worse
 * than missing metadata.
 */
const request = async <T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> => {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      credentials: "same-origin",
      ...init,
      headers: { ...NGROK_SKIP_HEADER, ...init?.headers },
    });

    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    console.warn(`lawha: board request failed (${path})`, error);
    return null;
  }
};

/**
 * Creates the board row and opens it to anyone holding the link.
 *
 * Called when a collaboration session starts. Without it the board would be
 * created implicitly by the first scene write with `link_access: "none"`, and
 * every peer following the link would be refused at `join-room` — a session
 * that looks live to its host and is unreachable for everyone else.
 *
 * Idempotent: an existing board is patched rather than recreated, so restarting
 * a session on the same board is safe.
 */
export const openBoardToLink = async (
  boardId: string,
  linkAccess: LinkAccess = "edit",
): Promise<BoardSummary | null> => {
  const created = await request<{ board: BoardSummary }>("/boards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: boardId }),
  });

  const patched = await request<{ board: BoardSummary }>(`/boards/${boardId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ linkAccess }),
  });

  return patched?.board ?? created?.board ?? null;
};

export const closeBoardLink = async (
  boardId: string,
): Promise<BoardSummary | null> => {
  const result = await request<{ board: BoardSummary }>(`/boards/${boardId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ linkAccess: "none" }),
  });
  return result?.board ?? null;
};

export const getBoard = async (
  boardId: string,
): Promise<BoardSummary | null> => {
  const result = await request<{ board: BoardSummary }>(`/boards/${boardId}`);
  return result?.board ?? null;
};

/**
 * Resolves this visitor's rights on a board, and — for someone with no account
 * — is where the server hands out a pass scoped to that one board.
 *
 * Called before the socket opens, on both paths into a board. It has to run
 * first for two reasons: a guest cannot connect at all until the pass exists,
 * and an editor cannot be told they are a viewer after the fact without the
 * editor having already accepted edits it will never be able to save.
 *
 * Best-effort like the rest of this file: a failure means the client assumes
 * it may edit and lets the server refuse. The server is the authority; a
 * network blip must not lock someone out of their own board.
 */
export const resolveBoardAccess = async (
  boardId: string,
): Promise<BoardAccess> => {
  // The one call in this file that does NOT go through `request`, because
  // `request` folds every failure into `null` and the two failures mean
  // opposite things here.
  //
  // A 401 or 403 is an answer: this visitor may not have this board, and
  // pretending otherwise produces the save loop described on
  // `NO_BOARD_ACCESS`. Anything else — the fetch rejecting, a 500, a proxy
  // eating the request — is the absence of an answer, and there the original
  // reasoning holds: the server is the authority, and a blip must not lock
  // somebody out of their own board.
  try {
    const response = await fetch(`${API_BASE}/boards/${boardId}/access`, {
      method: "POST",
      credentials: "same-origin",
      headers: { ...NGROK_SKIP_HEADER },
    });

    if (response.status === 401 || response.status === 403) {
      return NO_BOARD_ACCESS;
    }

    if (!response.ok) {
      return FULL_BOARD_ACCESS;
    }

    return (await response.json()) as BoardAccess;
  } catch (error) {
    console.warn(`lawha: board access request failed (${boardId})`, error);
    return FULL_BOARD_ACCESS;
  }
};

/**
 * Set what the link does.
 *
 * Two fields rather than one because the owner's four options are stored as a
 * pair — see ADR 0024 and migration 018. `guestEdit` is always sent, never left
 * out, so moving back to a narrower option cannot leave the wider flag set on a
 * board whose link no longer justifies it.
 */
export const setBoardLinkAccess = async (
  boardId: string,
  linkAccess: LinkAccess,
  guestEdit = false,
): Promise<BoardSummary | null> => {
  const result = await request<{ board: BoardSummary }>(`/boards/${boardId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ linkAccess, guestEdit }),
  });
  return result?.board ?? null;
};

// --- named sharing ---------------------------------------------------------
//
// These throw. The share panel has UI to put an error in, and silently doing
// nothing when someone presses "Add" is how a permission ends up believed but
// not granted.

export interface BoardMembership {
  members: BoardMember[];
  role: BoardRole;
  linkAccess: LinkAccess;
  guestEdit: boolean;
}

export const listBoardMembers = (boardId: string): Promise<BoardMembership> =>
  json<BoardMembership>(`/boards/${boardId}/members`);

export const searchMemberCandidates = async (
  boardId: string,
  query: string,
): Promise<UserCandidate[]> =>
  (
    await json<{ users: UserCandidate[] }>(
      `/boards/${boardId}/members/candidates?q=${encodeURIComponent(query)}`,
    )
  ).users;

export const setBoardMember = async (
  boardId: string,
  userId: string,
  role: BoardRole,
): Promise<BoardMember[]> =>
  (
    await json<{ members: BoardMember[] }>(
      `/boards/${boardId}/members/${userId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      },
    )
  ).members;

export const removeBoardMember = async (
  boardId: string,
  userId: string,
): Promise<BoardMember[]> =>
  (
    await json<{ members: BoardMember[] }>(
      `/boards/${boardId}/members/${userId}`,
      { method: "DELETE" },
    )
  ).members;

// --- dashboard -------------------------------------------------------------
//
// These throw, unlike the best-effort helpers above: the dashboard has nothing
// to show if the list fails, so swallowing the error would leave an empty grid
// that looks like "you have no boards".

export interface BoardTag {
  id: string;
  name: string;
  /**
   * Index into `COLLABORATOR_PALETTE`; null means no colour chosen.
   *
   * An index and never a hex (invariant 16). It was a free-form CSS string
   * until migration 014 — the last hex on the wire anywhere on the deployment.
   */
  colorIndex: number | null;
}

export interface BoardListEntry extends BoardSummary {
  tags: BoardTag[];
  /**
   * Which of *this account's* folders the board is filed in, or null for
   * unfiled. It is not a property of the board: a board shared with three
   * people is filed independently by each of them, exactly as tags are.
   */
  folderId: string | null;
}

export interface BoardList {
  boards: BoardListEntry[];
  /** boardId -> people editing right now. Absent means nobody. */
  editing: Record<string, number>;
}

export interface TagSummary extends BoardTag {
  boardCount: number;
}

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { ...NGROK_SKIP_HEADER, ...init?.headers },
  });

  if (!response.ok) {
    const body = await parseJsonBody<{ error?: string }>(response);
    throw new Error(body?.error ?? "Something went wrong.");
  }

  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
};

/**
 * The board list, with filing normalised at the boundary.
 *
 * `folderId` is defaulted to null here rather than left as `undefined`, because
 * the dashboard asks two different questions of it — "is this board in folder
 * X" and "is this board in no folder at all" — and `undefined` answers neither.
 * A board from a server build that predates folders would then be invisible
 * under every chip in the rail, including "Unfiled", which reads as the board
 * having been lost.
 */
export const listBoards = async (): Promise<BoardList> => {
  const list = await json<BoardList>("/boards");

  return {
    ...list,
    boards: list.boards.map((board) => ({
      ...board,
      folderId: board.folderId ?? null,
    })),
  };
};

export const createBoard = async (params: {
  id: string;
  name?: string;
}): Promise<BoardSummary> =>
  (
    await json<{ board: BoardSummary }>("/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
  ).board;

export const renameBoard = async (
  boardId: string,
  name: string,
): Promise<BoardSummary> =>
  (
    await json<{ board: BoardSummary }>(`/boards/${boardId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
  ).board;

export const setBoardTags = async (
  boardId: string,
  tagIds: string[],
): Promise<void> => {
  await json(`/boards/${boardId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tagIds }),
  });
};

export const duplicateBoard = async (
  boardId: string,
  name?: string,
): Promise<BoardSummary> =>
  (
    await json<{ board: BoardSummary }>(`/boards/${boardId}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(name === undefined ? {} : { name }),
    })
  ).board;

export const deleteBoard = async (boardId: string): Promise<void> => {
  await json(`/boards/${boardId}`, { method: "DELETE" });
};

export const listTags = async (): Promise<TagSummary[]> =>
  (await json<{ tags: TagSummary[] }>("/tags")).tags;

export const createTag = async (
  name: string,
  colorIndex?: number | null,
): Promise<BoardTag> =>
  (
    await json<{ tag: BoardTag }>("/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, colorIndex }),
    })
  ).tag;

/**
 * Renames a tag everywhere it is used.
 *
 * A tag is one row referenced by `board_tags`, so this relabels every board
 * carrying it rather than forking a second tag — which is the behaviour the
 * name implies and the reason renaming beats delete-and-recreate, since the
 * latter would silently unlabel every board on the way past.
 *
 * The server refuses a name another tag already has (409 `TAG_TAKEN`), because
 * two tags reading the same is indistinguishable from one tag to the person
 * filtering by it.
 */
/**
 * Changes a tag's name, its colour, or both.
 *
 * One function rather than a `renameTag` and a `recolourTag`, following
 * `updateFolder`: two endpoints for one rule is one enforcement point plus a
 * hole, and the server already takes both fields in a single PATCH.
 *
 * `undefined` and `null` differ for `colorIndex` — absent leaves the colour
 * alone, null clears it — so a caller that means "no colour" has to say so.
 */
export const updateTag = async (
  tagId: string,
  params: { name?: string; colorIndex?: number | null },
): Promise<BoardTag> =>
  (
    await json<{ tag: BoardTag }>(`/tags/${tagId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
  ).tag;

/** Kept so the rename call sites read unchanged. */
export const renameTag = (tagId: string, name: string): Promise<BoardTag> =>
  updateTag(tagId, { name });

export const deleteTag = async (tagId: string): Promise<void> => {
  await json(`/tags/${tagId}`, { method: "DELETE" });
};

// --- folders ---------------------------------------------------------------
//
// Filing is per person, for the same reason tags are: a board shared with three
// people sits in a different folder for each of them, and a shared hierarchy
// would mean one person dragging a board silently refiles it for everyone else.
//
// That is also why deleting a folder can never delete a board. The folder is
// one person's view of something several people own — the server empties it and
// the boards become unfiled. The UI has to say so plainly, because "delete
// folder" reads as "delete what is in it" to almost everybody.

export interface FolderSummary {
  id: string;
  name: string;
  /** null for a root folder. Folders nest as of migration 006. */
  parentId: string | null;
  /**
   * Index into `FOLDER_COLORS`, or null for a folder nobody has coloured.
   *
   * An index and never a hex, for the reason ADR 0002 gives about laser colour:
   * the dashboard draws a folder in both themes, and a colour picked against
   * one of them is wrong in the other. A client that does not recognise the
   * index falls back rather than painting something illegible.
   */
  colorIndex: number | null;
  /**
   * This account's boards filed **directly** here, counted by the server.
   *
   * Not the subtree. The sidebar wants subtree counts, and derives them from
   * the board list it already holds (`folderTree.ts`) rather than asking for
   * them — a count computed from the same array the grid renders cannot
   * disagree with the grid.
   */
  boardCount: number;
  createdAt: number;
}

/**
 * What a create or an update may carry.
 *
 * `parentId: null` is a real instruction — "put this at the top level" — and is
 * deliberately distinguishable from the key being absent, which means "leave
 * the parent alone". Collapsing the two would make dragging a folder back out
 * of a parent impossible, which is the one move a tree cannot express any other
 * way.
 */
export interface FolderPatch {
  name?: string;
  parentId?: string | null;
  colorIndex?: number | null;
}

/**
 * The folder list, with nesting and colour normalised at the boundary.
 *
 * Same reasoning as `listBoards` defaulting `folderId`: the dashboard asks two
 * different questions of `parentId` — "is this folder inside X" and "is this a
 * root folder" — and `undefined` answers neither. A folder from a server build
 * that predates migration 006 would then be neither a root nor anybody's child,
 * which is a folder that renders nowhere at all.
 */
export const listFolders = async (): Promise<FolderSummary[]> => {
  const { folders } = await json<{ folders: FolderSummary[] }>("/folders");

  return folders.map((folder) => ({
    ...folder,
    parentId: folder.parentId ?? null,
    colorIndex: folder.colorIndex ?? null,
  }));
};

export const createFolder = async (
  name: string,
  options: Omit<FolderPatch, "name"> = {},
): Promise<FolderSummary> =>
  (
    await json<{ folder: FolderSummary }>("/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...options }),
    })
  ).folder;

/**
 * Rename, recolour, or move — a PATCH carrying `parentId` *is* the move.
 *
 * One endpoint rather than a separate `/folders/:id/move`, because the two
 * would have to agree about cycles and about sibling names, and two enforcement
 * points for one rule is one enforcement point plus a hole (invariant 21).
 */
export const updateFolder = async (
  folderId: string,
  patch: FolderPatch,
): Promise<FolderSummary> =>
  (
    await json<{ folder: FolderSummary }>(`/folders/${folderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  ).folder;

export const renameFolder = (
  folderId: string,
  name: string,
): Promise<FolderSummary> => updateFolder(folderId, { name });

/** Files a folder under another, or at the top level with `null`. */
export const moveFolder = (
  folderId: string,
  parentId: string | null,
): Promise<FolderSummary> => updateFolder(folderId, { parentId });

/** 204. The boards inside become unfiled; none of them is deleted. */
export const deleteFolder = async (folderId: string): Promise<void> => {
  await json(`/folders/${folderId}`, { method: "DELETE" });
};

/** `null` files the board out of every folder rather than deleting anything. */
export const setBoardFolder = async (
  boardId: string,
  folderId: string | null,
): Promise<BoardSummary> =>
  (
    await json<{ board: BoardSummary }>(`/boards/${boardId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId }),
    })
  ).board;
