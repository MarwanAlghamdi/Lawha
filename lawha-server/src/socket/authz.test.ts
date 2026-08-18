import { describe, expect, it } from "vitest";

import { createResolveBoardPermission } from "./authz.js";

import type {
  BoardAccessRecord,
  BoardAccessSource,
  BoardRole,
  LinkAccess,
  Principal,
} from "./authz.js";

/**
 * The permission resolver, which is the only place `canEdit` is decided.
 *
 * Invariant 21 exists because `canEdit` once had zero call sites and
 * `link_access: "view"` silently granted full write for months. ADR 0024 widens
 * this function again — so this file pins every combination, including the ones
 * that must keep refusing.
 */
const BOARD_ID = "board-1";
const OWNER = "user-owner";

const source = (
  board: Partial<BoardAccessRecord> | null,
  roles: Record<string, BoardRole> = {},
): BoardAccessSource => ({
  getBoardAccess: (id: string) =>
    board && id === BOARD_ID
      ? {
          ownerId: OWNER,
          linkAccess: "none",
          guestEdit: false,
          deletedAt: null,
          ...board,
        }
      : null,
  getMemberRole: (_id: string, userId: string) => roles[userId] ?? null,
});

const resolve = (
  board: Partial<BoardAccessRecord> | null,
  principal: Principal,
  roles: Record<string, BoardRole> = {},
  allowUnknownBoards = false,
) =>
  createResolveBoardPermission(source(board, roles), { allowUnknownBoards })(
    principal,
    BOARD_ID,
  );

const guest = (boardId: string | null = BOARD_ID): Principal => ({
  id: "guest_abc",
  isGuest: true,
  guestBoardId: boardId,
});

const signedIn = (id = "user-stranger"): Principal => ({ id });

describe("guest editing", () => {
  const cases: {
    link: LinkAccess;
    guestEdit: boolean;
    canAccess: boolean;
    canEdit: boolean;
  }[] = [
    { link: "none", guestEdit: false, canAccess: false, canEdit: false },
    { link: "none", guestEdit: true, canAccess: false, canEdit: false },
    { link: "view", guestEdit: false, canAccess: true, canEdit: false },
    // The flag alone must not grant anything — the link still has to say edit.
    { link: "view", guestEdit: true, canAccess: true, canEdit: false },
    // The pre-ADR-0024 behaviour, which every existing board keeps.
    { link: "edit", guestEdit: false, canAccess: true, canEdit: false },
    // The new option, and the only combination that lets a guest write.
    { link: "edit", guestEdit: true, canAccess: true, canEdit: true },
  ];

  for (const c of cases) {
    it(`link=${c.link} guest_edit=${c.guestEdit} -> access=${c.canAccess} edit=${c.canEdit}`, () => {
      const permission = resolve(
        { linkAccess: c.link, guestEdit: c.guestEdit },
        guest(),
      );

      expect(permission.canAccess).toBe(c.canAccess);
      expect(permission.canEdit).toBe(c.canEdit);
    });
  }

  it("reports an editing guest as an editor, so the wire says what it means", () => {
    expect(resolve({ linkAccess: "edit", guestEdit: true }, guest()).role).toBe(
      "editor",
    );
    expect(
      resolve({ linkAccess: "edit", guestEdit: false }, guest()).role,
    ).toBe("viewer");
  });

  it("never treats a guest as the owner", () => {
    expect(
      resolve({ linkAccess: "edit", guestEdit: true }, guest()).isOwner,
    ).toBe(false);
  });
});

describe("guest scoping survives the widening", () => {
  it("refuses a guest whose pass is for another board", () => {
    // Invariant 22: widening the role must not widen the scope. Without this,
    // a pass minted for one shared board is a key to every shared board.
    const permission = resolve(
      { linkAccess: "edit", guestEdit: true },
      guest("some-other-board"),
    );

    expect(permission.canAccess).toBe(false);
    expect(permission.canEdit).toBe(false);
    expect(permission.role).toBeNull();
  });

  it("refuses a guest with no board on their pass", () => {
    expect(
      resolve({ linkAccess: "edit", guestEdit: true }, guest(null)).canAccess,
    ).toBe(false);
  });

  it("refuses a guest on a deleted board", () => {
    expect(
      resolve(
        { linkAccess: "edit", guestEdit: true, deletedAt: Date.now() },
        guest(),
      ).canAccess,
    ).toBe(false);
  });

  it("refuses a guest on an unknown board even in dev mode", () => {
    expect(resolve(null, guest(), {}, true).canAccess).toBe(false);
  });
});

describe("nothing else moved", () => {
  it("still lets a signed-in link holder edit on a plain edit link", () => {
    const permission = resolve(
      { linkAccess: "edit", guestEdit: false },
      signedIn(),
    );

    expect(permission.canAccess).toBe(true);
    expect(permission.canEdit).toBe(true);
  });

  it("still refuses a signed-in link holder on a view link", () => {
    expect(
      resolve({ linkAccess: "view", guestEdit: false }, signedIn()).canEdit,
    ).toBe(false);
  });

  it("still lets the owner edit whatever the link says", () => {
    const permission = resolve(
      { linkAccess: "none", guestEdit: false },
      signedIn(OWNER),
    );

    expect(permission.isOwner).toBe(true);
    expect(permission.canEdit).toBe(true);
  });

  it("still lets a named role beat the link", () => {
    // An explicit viewer on a link-editable board stays a viewer.
    const permission = resolve(
      { linkAccess: "edit", guestEdit: true },
      signedIn("user-viewer"),
      { "user-viewer": "viewer" },
    );

    expect(permission.role).toBe("viewer");
    expect(permission.canEdit).toBe(false);
  });

  it("still lets a named editor edit", () => {
    expect(
      resolve({ linkAccess: "none" }, signedIn("user-ed"), {
        "user-ed": "editor",
      }).canEdit,
    ).toBe(true);
  });
});

describe("the permission carries the owner's choice", () => {
  it("reports guestEdit beside linkAccess, so callers cannot read one without the other", () => {
    const permission = resolve(
      { linkAccess: "edit", guestEdit: true },
      signedIn(),
    );

    expect(permission.linkAccess).toBe("edit");
    expect(permission.guestEdit).toBe(true);
  });
});
