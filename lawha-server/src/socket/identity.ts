import { SERVER_EVENTS } from "../protocol.js";

import type { LawhaIdentity } from "../protocol.js";
import type { Server, Socket } from "socket.io";

/**
 * Turning a room's sockets into the identities its members are allowed to know.
 *
 * ADR 0003 named this as the blocker for peer profile pictures: Excalidraw's
 * collaborator map is keyed by socket and carries a username, an idle state and
 * a palette index — no account id — so there is nothing to fetch a peer's
 * picture *by*. This is the wire-format change that fixes it, and it is
 * deliberately server-authoritative. Putting a user id on the pointer payload
 * would have been half the lines and a hole: pointer payloads are
 * client-claimed, so a guest could assert someone else's account and be handed
 * their name and their photograph.
 */

/**
 * The columns of `users` this needs, named structurally so the socket layer
 * does not depend on the repository class.
 *
 * `UsersRepository` satisfies it as-is.
 */
export interface AccountIdentityRow {
  username_display: string;
  color_index: number | null;
  avatar_id: string | null;
  /**
   * The opt-in, added by migration 005.
   *
   * Declared optional so this compiles *and runs* against a database that has
   * not been migrated yet: `SELECT *` simply does not return the column,
   * `undefined` is not `1`, and the avatar is withheld. That is the safe
   * direction for a privacy flag — the failure mode of a missing column is
   * "nobody's picture is shared", never "everybody's is".
   */
  avatar_on_cursor?: number | null;
}

export interface AccountIdentitySource {
  findById: (id: string) => AccountIdentityRow | null;
}

/**
 * A module singleton, for the same reason `liveAccess.ts` is one: the socket
 * server is constructed in `src/index.ts` from a fixed set of callbacks and
 * never sees the context that owns the repositories.
 *
 * Optional throughout. With nothing published — the relay-only unit tests, and
 * any deployment that has not wired it — identities still carry socket id,
 * user id, guest status and edit rights, which is everything except the parts
 * that live in the database. Colour and picture simply stay null.
 */
let accounts: AccountIdentitySource | null = null;

export const publishAccountIdentitySource = (
  next: AccountIdentitySource | null,
): void => {
  accounts = next;
};

export const getAccountIdentitySource = (): AccountIdentitySource | null =>
  accounts;

/**
 * Placeholder names for account-less visitors.
 *
 * Every guest used to be called "Guest", which on a board with two of them is
 * indistinguishable from one person with two tabs open. These are stable for
 * the life of a guest pass (they are derived from its id), obviously not real
 * account names, and carry no information about the visitor — which is the
 * point: a link guest has told us nothing about themselves and we must not
 * invent anything.
 */
const GUEST_NAMES = [
  "Heron",
  "Otter",
  "Falcon",
  "Ibex",
  "Marten",
  "Oryx",
  "Puffin",
  "Quail",
  "Sable",
  "Lynx",
  "Vole",
  "Wren",
] as const;

export const guestDisplayName = (guestId: string): string => {
  let hash = 0;
  for (let index = 0; index < guestId.length; index += 1) {
    // The same cheap string hash the client uses for palette indices. It only
    // has to be stable and spread, not uniform.
    hash = (hash * 31 + guestId.charCodeAt(index)) >>> 0;
  }
  return `Guest ${GUEST_NAMES[hash % GUEST_NAMES.length]}`;
};

/**
 * Whether this account's picture may be put on their cursor.
 *
 * Two conditions, and both are the server's to check. A row with the flag set
 * but no picture is not an error — it is somebody who turned the toggle on and
 * then removed their photograph — and it must resolve to "no avatar" rather
 * than to a broken image on every peer's canvas.
 */
const sharesAvatarOnCursor = (row: AccountIdentityRow | null): boolean =>
  row !== null && row.avatar_on_cursor === 1 && row.avatar_id !== null;

/**
 * Builds the `lawha-identities` payload for a set of sockets.
 *
 * Takes resolved sockets rather than a room id so this module never has to
 * import `rooms.ts`, which imports this one.
 */
export const buildRoomIdentities = (
  sockets: readonly Socket[],
): LawhaIdentity[] =>
  sockets.map((socket) => {
    const user = socket.data.user;
    // `canEdit` is resolved at join and re-resolved whenever a board's sharing
    // changes; `undefined` is the relay-only case, where everyone who may join
    // may write. Written as `!== false` so an unset value never reads as a
    // demotion.
    const canEdit = socket.data.canEdit !== false;

    // A guest, or — belt and braces — a socket whose principal we somehow do
    // not have. Both resolve to the narrower identity, never the wider one.
    if (!user || user.isGuest === true) {
      return {
        socketId: socket.id,
        userId: null,
        username: user?.username || guestDisplayName(socket.id),
        colorIndex: null,
        avatarId: null,
        isGuest: true,
        canEdit,
      };
    }

    // Read fresh rather than cached on the socket at handshake time, so a
    // rename, a new picture or a flipped opt-in reaches the room on the next
    // membership change instead of on the next reconnect. This runs on
    // membership changes only — never on the pointer path — so a lookup per
    // member is affordable where one per message would not be.
    const row = accounts?.findById(user.id) ?? null;

    return {
      socketId: socket.id,
      userId: user.id,
      username: row?.username_display || user.username,
      colorIndex: row?.color_index ?? null,
      avatarId: sharesAvatarOnCursor(row) ? row!.avatar_id : null,
      isGuest: false,
      canEdit,
    };
  });

/**
 * Announces who is in a room, to that room.
 *
 * Always emitted *after* `room-user-change`, because the client rebuilds its
 * collaborator map wholesale from that event: identities sent first would be
 * merged into entries that the membership array then replaces.
 */
export const emitRoomIdentities = (
  io: Server,
  roomId: string,
  socketIds: readonly string[],
): void => {
  const sockets: Socket[] = [];

  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      sockets.push(socket);
    }
  }

  io.in(roomId).emit(
    SERVER_EVENTS.LAWHA_IDENTITIES,
    buildRoomIdentities(sockets),
  );
};
