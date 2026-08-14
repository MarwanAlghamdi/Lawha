import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  followRoomFor,
  isFollowJoin,
  isFollowLeave,
  isFollowRoom,
  isValidRoomId,
  FOLLOW_ROOM_PREFIX,
} from "../protocol.js";

import { emitRoomIdentities } from "./identity.js";
import { getPermissionResolver } from "./liveAccess.js";

import type { LawhaMetrics } from "./metrics.js";
import type { PresenceRegistry } from "./presence.js";
import type { Principal } from "./authz.js";
import type { UserFollowPayload } from "../protocol.js";
import type { Server, Socket } from "socket.io";

export interface SocketUser {
  id: string;
  username: string;
  /** A server-minted share-link visitor with no account. Always view only. */
  isGuest?: boolean;
  /** The one board a guest pass is scoped to. */
  guestBoardId?: string | null;
}

declare module "socket.io" {
  interface SocketData {
    user: SocketUser;
    /**
     * Write rights for the room this socket joined, resolved once at
     * `join-room`.
     *
     * Cached on the socket because the reliable broadcast handler reads it on
     * every message, and that path is what meets the sync target — a database
     * hit per element update would violate invariant 3 by another route.
     */
    canEdit?: boolean;
    /**
     * The session cookie this socket handshook with, when it had one.
     *
     * Recorded for exactly one purpose: `disconnectUser` has to be able to
     * spare the session that asked for the revocation, because
     * `sessions.revokeAllExcept` spares it on the HTTP side and the two have to
     * agree. Without it the only handle on a socket is its account id, and
     * "every socket of this account" includes the browser that just changed its
     * own password.
     *
     * Absent for a guest and for the anonymous user — neither holds a session
     * row, so neither can be the one spared.
     *
     * It is NOT re-checked: this is a handshake value and the socket keeps it
     * for its lifetime. Nothing here treats it as proof of anything; it is only
     * ever compared against a token the caller already has.
     */
    sessionToken?: string;
  }
}

/** Codes carried by `lawha-error`; the client branches on them. */
export const ROOM_ERRORS = {
  BAD_ROOM_ID: "BAD_ROOM_ID",
  FORBIDDEN: "FORBIDDEN",
  /** Access survived, editing did not: demoted to viewer mid-session. */
  VIEW_ONLY: "VIEW_ONLY",
  /** Promoted back. Sent so an editor does not stay stuck in view mode. */
  CAN_EDIT: "CAN_EDIT",
  /**
   * The server failed while handling this event — not a refusal, a fault.
   *
   * Distinct from `FORBIDDEN` on purpose. Telling somebody they lack access
   * when the database hiccuped sends them to an administrator who will find
   * nothing wrong with their account, and it hides an operational fault behind
   * a permissions story. This says "we broke", which is the truth and is
   * actionable by a different person.
   *
   * `Collab.handleServerError` has a `default:` branch that shows a dialog and
   * stops collaboration, so an older client that has never heard of this code
   * still fails safe rather than silently believing it is in a room.
   */
  SERVER_ERROR: "SERVER_ERROR",
} as const;

export interface RoomHandlerDeps {
  io: Server;
  /** Authorization check performed at join time, when the board id is known. */
  canAccessBoard: (userId: string, boardId: string) => Promise<boolean>;
  metrics?: LawhaMetrics;
  onRoomActivity?: (roomId: string) => void;
  /** Kept in step so the dashboard can show live editor counts over HTTP. */
  presence?: PresenceRegistry;
}

/** Members of a room right now, as an array of socket ids. */
const membersOf = (io: Server, roomId: string): string[] => [
  ...(io.sockets.adapter.rooms.get(roomId) ?? []),
];

const principalOfSocket = (socket: Socket): Principal => ({
  id: socket.data.user.id,
  isGuest: socket.data.user.isGuest === true,
  guestBoardId: socket.data.user.guestBoardId ?? null,
});

/**
 * Wires the excalidraw-room protocol onto a socket.
 *
 * The server is a relay only: every payload is AES-GCM ciphertext encrypted
 * in whatever form the client sends them. Since ADR 0012 that is plaintext
 * JSON with a zero-length iv; the relay has never looked inside either and
 * still does not.
 * Nothing here can — or should — inspect message contents.
 */
export const registerRoomHandlers = (
  socket: Socket,
  deps: RoomHandlerDeps,
): void => {
  const { io, canAccessBoard, metrics, onRoomActivity, presence } = deps;

  metrics?.socketConnected();

  /**
   * Wraps an async socket handler so a rejection cannot take down the process.
   *
   * socket.io does **not** await or catch the promise an `async` listener
   * returns. Node has terminated the process on an unhandled rejection since
   * v15, so before this existed a single transient database error inside
   * `join-room` — one row read failing while SQLite was busy — killed the
   * server for **every** connected user, mid-drawing, and left nothing in the
   * log that named the room or the account it happened for.
   *
   * The failure is per-socket, so the recovery is per-socket: refuse this one
   * join, loudly, and leave the other rooms alone. `SERVER_ERROR` rather than
   * silence because a client that is told nothing sits in `waitFor` believing
   * it is about to be in a room, which is the failure presenting as a hang.
   */
  const guarded =
    <A extends unknown[]>(
      event: string,
      handler: (...args: A) => Promise<void>,
    ) =>
    (...args: A): void => {
      void handler(...args).catch((error: unknown) => {
        process.stderr.write(
          `lawha: socket ${event} failed for user ${
            socket.data.user?.id ?? "unknown"
          }: ${
            error instanceof Error
              ? error.stack ?? error.message
              : String(error)
          }\n`,
        );
        socket.emit(SERVER_EVENTS.LAWHA_ERROR, {
          code: ROOM_ERRORS.SERVER_ERROR,
        });
      });
    };

  // The client's `init-room` handler responds by emitting `join-room`.
  socket.emit(SERVER_EVENTS.INIT_ROOM);

  socket.on(
    CLIENT_EVENTS.JOIN_ROOM,
    guarded("join-room", async (roomId: unknown) => {
      if (!isValidRoomId(roomId)) {
        socket.emit(SERVER_EVENTS.LAWHA_ERROR, {
          code: ROOM_ERRORS.BAD_ROOM_ID,
        });
        return;
      }

      const permission = getPermissionResolver()?.(
        principalOfSocket(socket),
        roomId,
      );

      // A guest pass is scoped to one board, and only the resolver knows which —
      // `canAccessBoard` takes a bare user id and would read a guest as an
      // ordinary stranger holding the link, which is exactly the check that must
      // not be reused here.
      const allowed = socket.data.user.isGuest
        ? permission?.canAccess === true
        : await canAccessBoard(socket.data.user.id, roomId);

      if (!allowed) {
        socket.emit(SERVER_EVENTS.LAWHA_ERROR, {
          code: ROOM_ERRORS.FORBIDDEN,
          roomId,
        });
        return;
      }

      // Resolved once, here, and read per message below. With no resolver
      // published — the relay-only unit tests — everyone who may join may write,
      // which is the behaviour those tests were written against.
      socket.data.canEdit = permission ? permission.canEdit : true;

      await socket.join(roomId);
      onRoomActivity?.(roomId);
      presence?.join(roomId, socket.id);

      const members = membersOf(io, roomId);

      if (members.length <= 1) {
        // Nobody else here, so this client is responsible for seeding the room
        // from persisted storage.
        socket.emit(SERVER_EVENTS.FIRST_IN_ROOM);
      } else {
        // Existing members answer with a full SCENE_INIT.
        socket.broadcast.to(roomId).emit(SERVER_EVENTS.NEW_USER, socket.id);
      }

      io.in(roomId).emit(SERVER_EVENTS.ROOM_USER_CHANGE, members);
      // Alongside, never inside. `room-user-change` is the client's own event and
      // its shape is a bare array of socket ids (invariant 15); the identities
      // ride on a Lawha-only event that the client merges on top of the map it
      // has just rebuilt from that array.
      emitRoomIdentities(io, roomId, members);
      metrics?.roomSizeChanged(roomId, members.length);
    }),
  );

  /**
   * Reliable channel — SCENE_INIT / SCENE_UPDATE. Never volatile: dropping an
   * element update produces silent divergence.
   */
  socket.on(
    CLIENT_EVENTS.SERVER_BROADCAST,
    (roomId: unknown, encryptedData: ArrayBuffer, iv: Uint8Array) => {
      if (typeof roomId !== "string" || !socket.rooms.has(roomId)) {
        // Upstream excalidraw-room omits this check, which lets any connected
        // client inject undecryptable ciphertext into any guessable room.
        return;
      }
      // A viewer's scene updates are dropped here, and only here: the volatile
      // channel below carries cursors, and a viewer still has a cursor. One
      // property read, no I/O — this runs on every element update.
      if (socket.data.canEdit === false) {
        return;
      }
      metrics?.messageRelayed(CLIENT_EVENTS.SERVER_BROADCAST, encryptedData);
      socket.broadcast
        .to(roomId)
        .emit(SERVER_EVENTS.CLIENT_BROADCAST, encryptedData, iv);
    },
  );

  /**
   * Volatile channel — MOUSE_LOCATION / IDLE_STATUS / USER_VISIBLE_SCENE_BOUNDS.
   * `volatile` drops rather than buffers when a peer's send buffer is full,
   * which is exactly right for a ~30Hz cursor stream.
   */
  socket.on(
    CLIENT_EVENTS.SERVER_VOLATILE_BROADCAST,
    (roomId: unknown, encryptedData: ArrayBuffer, iv: Uint8Array) => {
      if (typeof roomId !== "string" || !socket.rooms.has(roomId)) {
        return;
      }
      metrics?.messageRelayed(
        CLIENT_EVENTS.SERVER_VOLATILE_BROADCAST,
        encryptedData,
      );
      socket.volatile.broadcast
        .to(roomId)
        .emit(SERVER_EVENTS.CLIENT_BROADCAST, encryptedData, iv);
    },
  );

  socket.on(
    CLIENT_EVENTS.USER_FOLLOW,
    guarded("user-follow", async (payload: UserFollowPayload) => {
      const followeeId = payload?.userToFollow?.socketId;
      if (
        typeof followeeId !== "string" ||
        !io.sockets.sockets.has(followeeId)
      ) {
        return;
      }

      const followRoom = followRoomFor(followeeId);

      // Matched explicitly in both directions rather than "join unless it says
      // unfollow". That `else` was the bug: the client sends FOLLOW, this relay
      // was written against SUBSCRIBE, and every follow request fell through to
      // `leave` — so the follower silently never joined the room and the
      // followee never learned to broadcast its viewport. The relay's own tests
      // missed it by speaking the server's vocabulary rather than the client's.
      if (isFollowJoin(payload.action)) {
        await socket.join(followRoom);
      } else if (isFollowLeave(payload.action)) {
        await socket.leave(followRoom);
      } else {
        return;
      }

      // The followee needs to know whether to keep broadcasting its viewport.
      io.to(followeeId).emit(
        SERVER_EVENTS.USER_FOLLOW_ROOM_CHANGE,
        membersOf(io, followRoom),
      );
    }),
  );

  socket.on(CLIENT_EVENTS.LAWHA_PING, (sentAt: number) => {
    socket.emit(SERVER_EVENTS.LAWHA_PONG, sentAt);
  });

  // `disconnecting`, not `disconnect`: by the time `disconnect` fires,
  // socket.rooms is already empty.
  socket.on("disconnecting", () => {
    metrics?.socketDisconnected();

    for (const roomId of socket.rooms) {
      if (roomId === socket.id) {
        continue;
      }

      // The leaving socket is still a member at this point, so it has to be
      // filtered out. Collab.setCollaborators rebuilds its whole map from this
      // array — a stale id leaves a phantom cursor on every peer.
      const remaining = membersOf(io, roomId).filter((id) => id !== socket.id);

      presence?.leave(roomId, socket.id);

      if (isFollowRoom(roomId)) {
        const followeeId = roomId.slice(FOLLOW_ROOM_PREFIX.length);
        io.to(followeeId).emit(
          SERVER_EVENTS.USER_FOLLOW_ROOM_CHANGE,
          remaining,
        );
      } else if (remaining.length > 0) {
        io.in(roomId).emit(SERVER_EVENTS.ROOM_USER_CHANGE, remaining);
        // Built from `remaining` for the same reason the membership array is:
        // this socket has not actually left yet, and an identity for someone
        // who is gone leaves a named phantom in the presence stack.
        emitRoomIdentities(io, roomId, remaining);
        metrics?.roomSizeChanged(roomId, remaining.length);
      } else {
        metrics?.roomSizeChanged(roomId, 0);
      }
    }

    // Anyone following this socket must stop: the followee is gone.
    const myFollowRoom = followRoomFor(socket.id);
    for (const followerId of membersOf(io, myFollowRoom)) {
      void io.sockets.sockets.get(followerId)?.leave(myFollowRoom);
    }
  });
};

export interface RoomAccessControllerDeps {
  io: Server;
  metrics?: LawhaMetrics;
  presence?: PresenceRegistry;
}

/**
 * Re-checks a board's live sockets after its sharing changed.
 *
 * Access was previously decided once, at join time, and never revisited — so
 * revoking someone's access did nothing at all to a session already in
 * progress. They kept relaying edits to everyone else while their own HTTP
 * writes started failing, and since `LocalData` saving is paused during
 * collaboration, that work had nowhere durable to go.
 *
 * Two outcomes, kept distinct on purpose: losing edit rights leaves you in the
 * room as a viewer, losing access removes you from it. Demotion is not
 * disconnection — a viewer should keep seeing the board they can still see.
 */
export const createRoomAccessController = ({
  io,
  metrics,
  presence,
}: RoomAccessControllerDeps) => ({
  applyBoardAccessChange: async (boardId: string): Promise<void> => {
    const resolve = getPermissionResolver();
    if (!resolve) {
      return;
    }

    let evicted = false;

    for (const socketId of membersOf(io, boardId)) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) {
        continue;
      }

      const permission = resolve(principalOfSocket(socket), boardId);

      if (!permission.canAccess) {
        socket.emit(SERVER_EVENTS.LAWHA_ERROR, {
          code: ROOM_ERRORS.FORBIDDEN,
          roomId: boardId,
        });
        presence?.leave(boardId, socket.id);
        await socket.leave(boardId);
        socket.data.canEdit = false;
        evicted = true;
        continue;
      }

      if (socket.data.canEdit !== permission.canEdit) {
        socket.data.canEdit = permission.canEdit;
        socket.emit(SERVER_EVENTS.LAWHA_ERROR, {
          code: permission.canEdit
            ? ROOM_ERRORS.CAN_EDIT
            : ROOM_ERRORS.VIEW_ONLY,
          roomId: boardId,
        });
      }
    }

    if (evicted) {
      // Everyone left behind rebuilds their collaborator map from this array,
      // so an eviction that skipped it would leave a phantom cursor for
      // someone who is no longer in the room.
      const remaining = membersOf(io, boardId);
      io.in(boardId).emit(SERVER_EVENTS.ROOM_USER_CHANGE, remaining);
      metrics?.roomSizeChanged(boardId, remaining.length);
    }

    // Unconditional, and not folded into the `evicted` branch above: access is
    // re-checked rather than checked once (invariant 23), and the common
    // outcome of a re-check is a *demotion* with no eviction at all. The
    // membership array is unchanged in that case, so `room-user-change` says
    // nothing — but `canEdit` has moved, and this is the only event that
    // carries it.
    emitRoomIdentities(io, boardId, membersOf(io, boardId));
  },

  /**
   * Throws every socket belonging to one account off the relay.
   *
   * The user-keyed counterpart to `applyBoardAccessChange` above, and it walks
   * `io.sockets.sockets` rather than a room's membership for the reason that
   * makes it a separate primitive at all: the question is not "who is in this
   * board" but "whose credential just stopped existing", and the answer spans
   * every room that account had open, including none.
   *
   * There is no demotion branch, and no permission is re-resolved. A revoked
   * session is not a smaller permission — `resolveBoardPermission` would still
   * happily call this principal an editor, because their membership rows are
   * untouched. What changed is that the connection is no longer speaking for
   * anybody, and the only honest response to that is to close it.
   *
   * `canEdit` is set false before the disconnect rather than left to it. The
   * disconnect is asynchronous at the transport, the reliable broadcast
   * handler is one property read away on the same socket, and that gap is
   * precisely the window this whole primitive exists to close.
   *
   * The membership fan-out, the presence bookkeeping and the identity
   * re-announce are all left to the `disconnecting` handler, which already
   * does exactly this work for an ordinary leave. Repeating it here would
   * emit `room-user-change` twice with the second copy still containing the
   * socket that is on its way out.
   *
   * A snapshot of the map, because `disconnect()` mutates it while we iterate.
   */
  disconnectUser: async (
    userId: string,
    keepSessionToken?: string,
  ): Promise<void> => {
    for (const socket of [...io.sockets.sockets.values()]) {
      if (socket.data.user?.id !== userId) {
        continue;
      }

      // The socket-side half of `sessions.revokeAllExcept`. Only the
      // password-change route passes a token; for everyone else this is
      // `undefined` and matches nothing, so every socket of the account goes.
      //
      // The `keepSessionToken &&` guard is load-bearing rather than defensive:
      // without it, a caller passing `undefined` would spare every socket that
      // also has no session token — which is every guest and, when
      // `LAWHA_REQUIRE_AUTH=false`, the anonymous user. `undefined === undefined`
      // is true, and that would have turned a full eviction into a silent
      // partial one for exactly the visitors with the least right to stay.
      if (keepSessionToken && socket.data.sessionToken === keepSessionToken) {
        continue;
      }

      // A socket is only ever in one board room, but it is read rather than
      // assumed so a socket in none still gets the event. The client reads
      // only `code` (`Portal.tsx`); `roomId` rides along for parity with the
      // refusal `join-room` already sends.
      const [roomId] = [...socket.rooms].filter(
        (id) => id !== socket.id && !isFollowRoom(id),
      );

      // FORBIDDEN rather than a bare close: `Collab.handleServerError` branches
      // on this code to resume and flush local saving before tearing the
      // session down. `LocalData.pauseSave("collaboration")` is active for the
      // whole session (invariant 17), so the server copy is the only durable
      // one — and the server has just stopped accepting this client's writes.
      // A silent disconnect would read as a flaky network, and the last few
      // minutes of drawing would evaporate on the next reload.
      socket.emit(SERVER_EVENTS.LAWHA_ERROR, {
        code: ROOM_ERRORS.FORBIDDEN,
        roomId,
      });
      socket.data.canEdit = false;
      socket.disconnect(true);
    }
  },

  /**
   * Broadcast to the whole room, the renamer included.
   *
   * Echoing it back to whoever typed it is deliberate: their editor already
   * shows the new name, so the echo is a no-op there, and excluding them would
   * mean the sender's socket id had to be threaded from an HTTP handler that
   * does not know it. One rule — "the room learns the board's name from the
   * server" — beats one rule plus an exception.
   */
  announceBoardRenamed: (boardId: string, name: string): void => {
    io.in(boardId).emit(SERVER_EVENTS.LAWHA_BOARD, { boardId, name });
  },
});
