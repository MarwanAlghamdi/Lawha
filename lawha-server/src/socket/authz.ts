/**
 * Board-level authorization.
 *
 * This is deliberately separate from handshake authentication: the board id is
 * only known at `join-room` time, so identity is established once per socket
 * while access is checked once per room.
 *
 * Two decisions come out of here, and they are not the same one:
 *
 *  - **can this principal reach the board at all** (`canAccess`), and
 *  - **may it change the board** (`canEdit`).
 *
 * They used to be conflated: `canEdit` existed but had no call sites, so
 * `link_access = "view"` granted full write over both the REST scene write and
 * the socket relay. Everything that gates on a role now goes through
 * `resolveBoardPermission`, so the two answers cannot drift apart again.
 */

export type BoardRole = "owner" | "editor" | "viewer";
export type LinkAccess = "none" | "view" | "edit";

export interface BoardAccessRecord {
  ownerId: string;
  linkAccess: LinkAccess;
  deletedAt: number | null;
}

export interface BoardAccessSource {
  getBoardAccess: (boardId: string) => BoardAccessRecord | null;
  getMemberRole: (boardId: string, userId: string) => BoardRole | null;
}

/**
 * Who is asking.
 *
 * A guest is a server-minted, account-less visitor holding a share link. It is
 * scoped to exactly one board: without `guestBoardId`, a guest token issued for
 * one shared board would be a key to every other shared board on the server.
 */
export interface Principal {
  id: string;
  isGuest?: boolean;
  guestBoardId?: string | null;
}

export interface BoardPermission {
  canAccess: boolean;
  canEdit: boolean;
  /** Membership role, or null when access comes from the link alone. */
  role: BoardRole | null;
  linkAccess: LinkAccess;
  isOwner: boolean;
  /** True when no board row exists yet and the config allows that. */
  isUnknownBoard: boolean;
}

const DENIED: BoardPermission = {
  canAccess: false,
  canEdit: false,
  role: null,
  linkAccess: "none",
  isOwner: false,
  isUnknownBoard: false,
};

export interface CanAccessBoardOptions {
  /**
   * When auth is disabled (Phase 1 dev), unknown boards are joinable so a
   * canvas can be opened before any board row exists.
   */
  allowUnknownBoards: boolean;
}

/** Whether a role may mutate the persisted scene. */
export const canEdit = (
  role: BoardRole | null,
  linkAccess: LinkAccess,
): boolean => role === "owner" || role === "editor" || linkAccess === "edit";

export type BoardPermissionResolver = (
  principal: Principal,
  boardId: string,
) => BoardPermission;

export const createResolveBoardPermission = (
  source: BoardAccessSource,
  options: CanAccessBoardOptions,
): BoardPermissionResolver => {
  return (principal: Principal, boardId: string): BoardPermission => {
    const board = source.getBoardAccess(boardId);

    if (!board) {
      // A guest exists only because some board was shared, so "no such board"
      // is always a refusal for one — never the dev-mode affordance below.
      if (!options.allowUnknownBoards || principal.isGuest) {
        return DENIED;
      }
      return {
        canAccess: true,
        canEdit: true,
        role: null,
        linkAccess: "none",
        isOwner: false,
        isUnknownBoard: true,
      };
    }

    if (board.deletedAt !== null) {
      return DENIED;
    }

    const base = { linkAccess: board.linkAccess, isUnknownBoard: false };

    if (principal.isGuest) {
      // Guests are VIEW ONLY, and that is a product decision rather than a
      // consequence of `link_access`: an account-less visitor holding a link
      // watches, whatever the link says. `link_access = "edit"` widens editing
      // to signed-in link holders only.
      const allowed =
        principal.guestBoardId === boardId && board.linkAccess !== "none";

      return {
        ...base,
        canAccess: allowed,
        canEdit: false,
        role: allowed ? "viewer" : null,
        isOwner: false,
      };
    }

    if (board.ownerId === principal.id) {
      return {
        ...base,
        canAccess: true,
        canEdit: true,
        role: "owner",
        isOwner: true,
      };
    }

    const role = source.getMemberRole(boardId, principal.id);

    if (role !== null) {
      return {
        ...base,
        canAccess: true,
        // A named role wins over the link: someone explicitly made a viewer of
        // a board that is also link-editable is still a viewer.
        canEdit: role === "owner" || role === "editor",
        role,
        isOwner: role === "owner",
      };
    }

    // Holding the link is not by itself sufficient — the board must be shared.
    return {
      ...base,
      canAccess: board.linkAccess !== "none",
      canEdit: board.linkAccess !== "none" && canEdit(null, board.linkAccess),
      role: null,
      isOwner: false,
    };
  };
};

export const createCanAccessBoard = (
  source: BoardAccessSource,
  options: CanAccessBoardOptions,
) => {
  const resolve = createResolveBoardPermission(source, options);
  return async (userId: string, boardId: string): Promise<boolean> =>
    resolve({ id: userId }, boardId).canAccess;
};
