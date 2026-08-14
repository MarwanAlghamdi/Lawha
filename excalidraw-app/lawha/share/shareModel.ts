import { getCurrentBoardId } from "../../data/currentBoard";

import type { BoardMember, BoardRole, LinkAccess } from "../../data/boards";
import type { LawhaPresenceUser } from "../hooks/useLawhaPresence";

/**
 * The three link settings, each with the consequence of choosing it.
 *
 * `hint` used to be shown only to people who could not change the setting,
 * which is backwards: the person deciding is the one who needs to know what the
 * decision does. Every reader now sees the sentence, and the owner sees all
 * three side by side — the difference between "view" and "edit" is not
 * something a two-word chip can carry.
 *
 * The sentences are deliberately order-independent ("people added to this
 * board" rather than "the people listed below"): this panel reorders its
 * sections between the owner's view and a viewer's, and a hint that points at a
 * section which is not rendered is worse than no hint.
 */
export const LINK_OPTIONS: {
  value: LinkAccess;
  label: string;
  hint: string;
}[] = [
  {
    value: "none",
    label: "Off",
    hint: "The link is dead. Only people added to this board can open it, and a link that gets forwarded is refused.",
  },
  {
    value: "view",
    label: "Can view",
    hint: "Anyone with the link can open this board and watch it live. They cannot draw, move or delete anything.",
  },
  {
    value: "edit",
    label: "Can edit",
    hint: "Anyone with the link who is signed in can draw on this board. Visitors without an account still only watch.",
  },
];

export const ROLE_LABEL: Record<BoardRole, string> = {
  owner: "Owner",
  editor: "Can edit",
  viewer: "Can view",
};

const RE_BOARD_PATH = /^\/b\/([a-zA-Z0-9_-]+)\/?$/;

/**
 * The board this panel is about.
 *
 * Prefers the route's board over the link: the link is null until a session has
 * started, while the route is set before the editor even mounts. The panel
 * takes no board id as a prop because its only caller is the top bar, which
 * belongs to another package — anything it needs beyond those props, it has to
 * find for itself.
 */
export const resolveBoardId = (link: string | null): string | null => {
  const fromRoute = getCurrentBoardId();
  if (fromRoute) {
    return fromRoute;
  }
  if (!link) {
    return null;
  }
  try {
    return new URL(link).pathname.match(RE_BOARD_PATH)?.[1] ?? null;
  } catch {
    return null;
  }
};

/** A member row, with whether that person is in the room at this moment. */
export interface SharePerson {
  member: BoardMember;
  isHere: boolean;
  isYou: boolean;
}

export interface SharePeople {
  people: SharePerson[];
  /**
   * People in the room with no row of their own.
   *
   * Link guests, mostly — they have no account, so no membership, so nothing to
   * put a dot beside. They are the ones a link owner most wants to see, so they
   * get a line rather than being dropped for not fitting the table.
   */
  guests: LawhaPresenceUser[];
}

/**
 * Joins the roster to who is actually in the room.
 *
 * Presence used to be a section of its own at the bottom of the panel, under
 * the heading "Here now", which meant the same person appeared twice — once as
 * a row with a role and once as an avatar with a colour — with nothing on
 * screen saying they were the same person. One list, one row each, a dot for
 * the ones who are here.
 *
 * Pure and exported so the join can be tested without an editor, a socket or a
 * server.
 */
export const joinPresence = (
  members: readonly BoardMember[],
  present: readonly LawhaPresenceUser[],
  ownUserId: string | null,
): SharePeople => {
  const here = new Set(
    present
      .map((user) => user.userId)
      .filter((id): id is string => id !== null),
  );

  const known = new Set(members.map((member) => member.userId));

  return {
    people: members.map((member) => ({
      member,
      isHere: here.has(member.userId),
      isYou: member.userId === ownUserId,
    })),
    // A signed-in peer whose identity has not landed yet has a null `userId`
    // and would otherwise be filed as a guest for that half-second. Checking
    // `isGuest` rather than the absence of an id keeps the flicker out.
    guests: present.filter(
      (user) =>
        user.isGuest || (user.userId !== null && !known.has(user.userId)),
    ),
  };
};

/** Owner first, then everyone else by name. Yourself is not special. */
export const sortPeople = (people: readonly SharePerson[]): SharePerson[] =>
  [...people].sort((a, b) => {
    const aOwns = a.member.role === "owner";
    const bOwns = b.member.role === "owner";
    if (aOwns !== bOwns) {
      return aOwns ? -1 : 1;
    }
    return a.member.username.localeCompare(b.member.username);
  });
