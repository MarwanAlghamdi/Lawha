import { UserIdleState } from "@excalidraw/common";
import { useExcalidrawStateValue } from "@excalidraw/excalidraw";
import { getClientColor } from "@excalidraw/excalidraw/clients";

import { useMemo } from "react";

import type { Collaborator, SocketId } from "@excalidraw/excalidraw/types";

export interface LawhaPresenceUser {
  socketId: SocketId;
  /**
   * The account id, when the server has announced one.
   *
   * Null for a link guest, who has no account, and for the window before
   * `lawha-identities` arrives — in both cases the dedupe above falls back to
   * the socket id, which is not an account and must not be matched against one.
   * The share panel joins presence to the member roster on this, so handing it
   * a socket id would silently light up nobody.
   */
  userId: string | null;
  /** Display name, or a placeholder when a peer has not sent one yet. */
  name: string;
  /** Up to two characters, as the mockup's avatar chips show. */
  initials: string;
  color: string;
  /**
   * The peer's profile picture, or null for initials on their colour.
   *
   * Available for *peers* now, not just for yourself: the server announces each
   * socket's identity on `lawha-identities`, and Collab turns the avatar id it
   * carries into this URL. It is null unless that account both has a picture
   * and opted in — the server withholds the id otherwise, so there is nothing
   * here for the UI to decide.
   */
  avatarUrl: string | null;
  /** A share-link visitor with no account. */
  isGuest: boolean;
  isCurrentUser: boolean;
  isIdle: boolean;
}

/**
 * Two initials rather than one.
 *
 * `getNameInitial` in the package returns a single character, which is right
 * for the canvas cursor label but not for the mockup's 28px avatar chips
 * (YA / OM / HB). Multi-word names take one letter from each of the first two
 * words; single words take their first two characters.
 *
 * Exported because the share panel draws the same chips for the board's
 * roster. Two copies of this drifted apart once already in spirit — the
 * presence stack and the canvas disagreed about a collaborator's colour for
 * exactly that reason (ADR 0001) — and initials are the same kind of thing:
 * the same person must not be "YA" in one surface and "Y" in another.
 */
export const getInitials = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return "?";
  }
  if (words.length === 1) {
    return [...words[0]].slice(0, 2).join("").toUpperCase();
  }
  return ([...words[0]][0] + [...words[words.length - 1]][0]).toUpperCase();
};

/**
 * Presence colour for a collaborator.
 *
 * Delegates to the canvas cursor's own `getClientColor` rather than
 * re-deriving it. Re-deriving is exactly what went wrong before: this hashed
 * the id and ignored `collaborator.colorIndex`, so a user who had been
 * assigned a colour appeared as one colour on the canvas and a different one
 * in the avatar stack, in the same session. Keeping the two in agreement is
 * the whole point of ADR 0001, and one shared function is the only way to
 * guarantee it.
 *
 * The theme argument is deliberately omitted: this value goes into the DOM,
 * which — unlike the interactive canvas — is not colour-filtered in dark mode.
 */
export const getPresenceColor = (
  socketId: SocketId,
  collaborator: Collaborator | undefined,
): string => getClientColor(socketId, collaborator);

/**
 * The presence stack's view of a collaborator map.
 *
 * Deduped by user id, because one person with two tabs open holds two sockets
 * and should still read as one person. That dedupe was written long before it
 * could work: nothing put an account id on the map, so `collaborator.id` was
 * always absent and every tab counted as a separate stranger. The server's
 * `lawha-identities` event supplies it, and this is where it pays off.
 *
 * Pure, and separate from the hook, so the dedupe and the fallbacks can be
 * tested without mounting an editor.
 */
export const toPresenceUsers = (
  collaborators: ReadonlyMap<SocketId, Collaborator> | undefined | null,
  /** Own display name; the collaborator map does not carry it for self. */
  currentUsername?: string,
): LawhaPresenceUser[] => {
  if (!collaborators?.size) {
    return [];
  }

  const seen = new Set<string>();
  const users: LawhaPresenceUser[] = [];

  for (const [socketId, collaborator] of collaborators) {
    const identity = collaborator.id ?? socketId;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);

    // Excalidraw only transmits a username inside pointer and idle payloads,
    // so a peer that has just joined and not moved yet has none — which is why
    // the server now announces one on join instead. "Joining…" remains the
    // honest answer for the window before that arrives; "Anonymous" would read
    // as their name.
    const name =
      collaborator.username?.trim() ||
      (collaborator.isCurrentUser ? currentUsername?.trim() : "") ||
      "Joining…";

    users.push({
      socketId,
      // `collaborator.id` is the *account* id when the server has announced
      // one, and falls back to the socket id when it has not — so the fallback
      // has to be undone here rather than passed on as if it were an account.
      userId:
        collaborator.id && collaborator.id !== socketId
          ? collaborator.id
          : null,
      name,
      initials: getInitials(name),
      color: getPresenceColor(socketId, collaborator),
      avatarUrl: collaborator.avatarUrl ?? null,
      isGuest: collaborator.isGuest === true,
      isCurrentUser: collaborator.isCurrentUser === true,
      isIdle:
        collaborator.userState === UserIdleState.IDLE ||
        collaborator.userState === UserIdleState.AWAY,
    });
  }

  return users;
};

/** The collaborators to show in the presence stack. */
export const useLawhaPresence = (
  currentUsername?: string,
): LawhaPresenceUser[] => {
  const collaborators = useExcalidrawStateValue("collaborators");

  return useMemo(
    () => toPresenceUsers(collaborators, currentUsername),
    [collaborators, currentUsername],
  );
};
