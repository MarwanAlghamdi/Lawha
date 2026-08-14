/**
 * The wire protocol shared between lawha-server and the Excalidraw client.
 *
 * These names are dictated by the client (`excalidraw-app/collab/Portal.tsx`
 * and `excalidraw-app/app_constants.ts`) and must not be renamed unilaterally.
 */

/** server -> client */
export const SERVER_EVENTS = {
  /** handshake complete; client replies with JOIN_ROOM */
  INIT_ROOM: "init-room",
  /** a peer joined; existing members respond with a full SCENE_INIT */
  NEW_USER: "new-user",
  /** authoritative room membership, excluding nobody */
  ROOM_USER_CHANGE: "room-user-change",
  /** this socket is alone in the room; it should load the persisted scene */
  FIRST_IN_ROOM: "first-in-room",
  /** relayed ciphertext from a peer */
  CLIENT_BROADCAST: "client-broadcast",
  /** membership of the `follow@<socketId>` sub-room */
  USER_FOLLOW_ROOM_CHANGE: "user-follow-room-change",
  /** Lawha-specific: a non-fatal, user-actionable error */
  LAWHA_ERROR: "lawha-error",
  /** Lawha-specific: who each socket in the room actually is */
  LAWHA_IDENTITIES: "lawha-identities",
  /** Lawha-specific: the board's own metadata changed under everyone */
  LAWHA_BOARD: "lawha-board",
  /** Lawha-specific: dev latency probe */
  LAWHA_PONG: "lawha-pong",
} as const;

/**
 * One socket's identity, as decided by the server.
 *
 * This rides *alongside* `room-user-change`, never inside it: that event's
 * shape is dictated by the client (a bare array of socket ids) and widening it
 * would break `Collab.setCollaborators`, which reads it positionally.
 *
 * Emitted from here rather than carried on the client's pointer payload, and
 * that is the whole point. The pointer payload is client-claimed — a link guest
 * could put someone else's `userId` on it and inherit their name and their
 * picture. The relay already knows each socket's authenticated principal, so
 * the only trustworthy sender of an identity is the server.
 */
export interface LawhaIdentity {
  socketId: string;
  /** null for a link guest, who has no account to be identified by. */
  userId: string | null;
  /** Display name. Guests get a stable, obviously-a-guest placeholder. */
  username: string;
  /** Index into COLLABORATOR_PALETTE. Never a hex — see invariant 16. */
  colorIndex: number | null;
  /**
   * Only present when that account has a picture *and* has opted in to showing
   * it on their cursor.
   *
   * Gated here, on the server, and not sent-and-filtered on the client: a peer
   * must not be able to learn your picture by ignoring a flag. Withholding the
   * id is what makes the opt-in a privacy contract rather than a rendering
   * preference.
   */
  avatarId: string | null;
  isGuest: boolean;
  canEdit: boolean;
}

/**
 * The board's metadata, after somebody changed it.
 *
 * Sent to the room, by the server, for the same reason `LawhaIdentity` is: it
 * is a fact about the board rather than about the sender, and a peer must not
 * be able to rename someone else's board by claiming it did.
 *
 * **Only the name.** A rename had no way to reach anyone at all — it was a REST
 * PATCH and nothing else, so a board renamed by its owner kept its old title on
 * every other screen until a reload. Link access deliberately does *not* ride
 * here: it already has a complete path of its own through
 * `applyBoardAccessChange`, which re-resolves each socket's permission and
 * evicts or demotes it. Carrying the same fact on a second, weaker channel
 * would give clients two answers to one question and a reason to trust the one
 * that cannot enforce anything.
 */
export interface LawhaBoardUpdate {
  boardId: string;
  name: string;
}

/** client -> server */
export const CLIENT_EVENTS = {
  JOIN_ROOM: "join-room",
  /** reliable channel: SCENE_INIT / SCENE_UPDATE */
  SERVER_BROADCAST: "server-broadcast",
  /** volatile channel: MOUSE_LOCATION / IDLE_STATUS / USER_VISIBLE_SCENE_BOUNDS */
  SERVER_VOLATILE_BROADCAST: "server-volatile-broadcast",
  USER_FOLLOW: "user-follow",
  LAWHA_PING: "lawha-ping",
} as const;

/** Reasons surfaced through socket.io's `connect_error`. */
export const SOCKET_ERRORS = {
  UNAUTHENTICATED: "LAWHA_UNAUTHENTICATED",
  FORBIDDEN: "LAWHA_FORBIDDEN",
} as const;

/**
 * The client sends FOLLOW/UNFOLLOW — see OnUserFollowedPayload in
 * packages/excalidraw/types.ts. SUBSCRIBE/UNSUBSCRIBE are accepted as aliases
 * because that is the vocabulary this relay was originally written against,
 * and an older client is not worth breaking over a word.
 */
export type FollowAction = "FOLLOW" | "UNFOLLOW" | "SUBSCRIBE" | "UNSUBSCRIBE";

export const isFollowJoin = (action: unknown): boolean =>
  action === "FOLLOW" || action === "SUBSCRIBE";

export const isFollowLeave = (action: unknown): boolean =>
  action === "UNFOLLOW" || action === "UNSUBSCRIBE";

export interface UserFollowPayload {
  userToFollow: { socketId: string; username: string };
  action: FollowAction;
}

export const FOLLOW_ROOM_PREFIX = "follow@";

export const followRoomFor = (socketId: string): string =>
  `${FOLLOW_ROOM_PREFIX}${socketId}`;

export const isFollowRoom = (roomId: string): boolean =>
  roomId.startsWith(FOLLOW_ROOM_PREFIX);

/**
 * Board ids are the socket room ids. `ROOM_ID_BYTES = 10` on the client
 * (`excalidraw-app/app_constants.ts`) so ids are 20 lowercase hex chars.
 * We also accept the legacy/looser id shape so hand-made rooms still work.
 */
export const RE_ROOM_ID = /^[a-zA-Z0-9_-]{8,64}$/;

export const isValidRoomId = (value: unknown): value is string =>
  typeof value === "string" && RE_ROOM_ID.test(value);

/** Mirrors FILE_CACHE_MAX_AGE_SEC in excalidraw-app/app_constants.ts. */
export const FILE_CACHE_MAX_AGE_SEC = 31536000;

/** Mirrors FILE_UPLOAD_MAX_BYTES in excalidraw-app/app_constants.ts. */
export const FILE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/** Headers used by the scene compare-and-swap protocol. */
export const SCENE_HEADERS = {
  /** the `rev` the client believes the server holds; empty means "create" */
  EXPECTED_REV: "x-lawha-expected-rev",
  /** server-owned monotonic revision */
  REV: "x-lawha-rev",
  /** client's getSceneVersion(); opaque to the server */
  SCENE_VERSION: "x-lawha-scene-version",
  /** AES-GCM initialisation vector, hex encoded */
  IV: "x-lawha-iv",
} as const;

export const FILE_SCOPES = ["rooms", "shareLinks"] as const;
export type FileScope = typeof FILE_SCOPES[number];

/**
 * The client passes storage prefixes like `files/rooms/<boardId>`.
 * Parsing (rather than interpolating) is what keeps path traversal out of
 * the filesystem layer.
 */
export const RE_FILE_PREFIX =
  /^\/*files\/(rooms|shareLinks)\/([A-Za-z0-9_-]+)$/;

export const parseFilePrefix = (
  prefix: string,
): { scope: FileScope; containerId: string } | null => {
  const match = prefix.match(RE_FILE_PREFIX);
  if (!match) {
    return null;
  }
  return { scope: match[1] as FileScope, containerId: match[2]! };
};

export const RE_FILE_ID = /^[A-Za-z0-9_-]{1,255}$/;
