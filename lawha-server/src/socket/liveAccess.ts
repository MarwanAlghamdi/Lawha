import type { BoardPermissionResolver } from "./authz.js";

/**
 * The bridge between "access changed" (an HTTP request) and "sockets already in
 * the room" (the relay).
 *
 * `canAccessBoard` runs exactly once, at `join-room`. Without something here, a
 * person whose access is revoked mid-session keeps relaying edits to everyone
 * else while their own HTTP writes start 403ing — and because
 * `LocalData.pauseSave("collaboration")` is active, the server copy is the only
 * durable one, so their work goes nowhere at all. Silent data loss, reported as
 * a live session.
 *
 * It is a module singleton rather than a constructor argument because the two
 * halves are constructed independently in `src/index.ts` — the express app and
 * the socket server never see each other. Both halves are optional: with no
 * socket server published (the HTTP-only tests) a notification is a no-op, and
 * with no resolver published (the socket-only tests) the relay falls back to
 * the `canAccessBoard` it was handed.
 */
export interface RoomAccessController {
  /** Re-evaluates every socket currently in a board's room. */
  applyBoardAccessChange: (boardId: string) => Promise<void>;
  /**
   * Tells the room the board was renamed.
   *
   * Not an access change, and kept as a separate method for that reason: this
   * one evaluates nothing and evicts nobody, it just carries a new title to the
   * people looking at the old one. Folding it into the method above would mean
   * a rename re-ran every socket's permission check, which is work with a
   * failure mode (a mid-rename revocation racing a rename) and no benefit.
   */
  announceBoardRenamed: (boardId: string, name: string) => void;
  /**
   * Throws every live socket belonging to one account off the relay.
   *
   * The user-keyed counterpart to `applyBoardAccessChange`, and it exists for
   * the same reason at one level up: `authenticate` is a socket.io
   * **handshake** middleware (`socket/index.ts`), so it runs once when the
   * connection is established and is never consulted again. Deleting the
   * account's rows out of `sessions` therefore did nothing whatsoever to a
   * connection that was already up.
   *
   * Board-keyed eviction cannot stand in for it. That primitive re-resolves a
   * permission, and permission is not what changed — a revoked session is
   * still, as far as `resolveBoardPermission` is concerned, a member of every
   * board it was a member of a second ago. The fact that moved is "this
   * connection's credential no longer exists", and only the account id
   * identifies it.
   *
   * No demotion branch, unlike the board-keyed method: there is no such thing
   * as half a session. Every match is disconnected.
   *
   * `keepSessionToken` is the socket-side mirror of `sessions.revokeAllExcept`,
   * and it exists for exactly one caller: an account changing its own password.
   * That route spares the session that asked, so the eviction has to spare that
   * session's socket — matching on the account id alone would throw the person
   * who just changed their password off the board they were drawing on, which
   * is the same "indistinguishable by account id" race the redemption route
   * avoids by ordering instead. Omit it and every socket of the account goes,
   * which is what every other caller wants.
   */
  disconnectUser: (userId: string, keepSessionToken?: string) => Promise<void>;
}

let controller: RoomAccessController | null = null;
let resolver: BoardPermissionResolver | null = null;

export const publishRoomAccessController = (
  next: RoomAccessController | null,
): void => {
  controller = next;
};

export const publishPermissionResolver = (
  next: BoardPermissionResolver | null,
): void => {
  resolver = next;
};

export const getPermissionResolver = (): BoardPermissionResolver | null =>
  resolver;

/**
 * Fire-and-forget from a route handler's point of view, but awaited so a test
 * can assert on the eviction rather than sleep for it.
 */
export const notifyBoardAccessChanged = async (
  boardId: string,
): Promise<void> => {
  await controller?.applyBoardAccessChange(boardId);
};

/**
 * A rename reaches the room, or it reaches nobody.
 *
 * `AppState.name` is browser-local, so before this existed a board renamed by
 * its owner kept its old title on every other screen in the session — and, as
 * usual here, said nothing about it. The people looking at the stale name had
 * no reason to think anything had happened.
 */
export const notifyBoardRenamed = (boardId: string, name: string): void => {
  controller?.announceBoardRenamed(boardId, name);
};

/**
 * A session sweep reaches the sockets, or it reaches nothing.
 *
 * Call this from **every** place that calls `sessions.revokeAllForUser`, and
 * call it with the same await the board-keyed notifier gets — the point of
 * awaiting is that a test can assert on the eviction rather than sleep for it.
 *
 * Before this existed the failure was total and silent: an administrator
 * pressed "Turn off" on a stolen laptop's account, watched the panel report
 * the devices signed out, and the thief's tab kept relaying every element to
 * their colleagues — who reconciled those elements and persisted them under
 * their **own** sessions. `rooms.ts` documents that laundering path for the
 * board-access case; this closes the same path for the credential case.
 *
 * **Order matters at the one call site that mints a session.** The redemption
 * route revokes, then evicts, then calls `startSession`. Doing the eviction
 * after the new session exists would race the person who has just recovered
 * their own account: their fresh socket is indistinguishable from the dead
 * ones by account id, so it would be thrown off the board they recovered
 * access for. Evicting while the account has zero live sessions is what makes
 * "every socket of this account" and "every socket holding a session that no
 * longer exists" the same set.
 *
 * **`src/cli/reset-password.ts` calls `revokeAllForUser` and deliberately does
 * NOT call this.** It is a separate process with its own `createContext` and
 * no socket server, so `controller` is null there and the call would be a
 * silent no-op that looked like coverage. The live server's sockets are in
 * another process and unreachable from that one without an IPC channel this
 * server does not have. An operator running the CLI has shell access and can
 * restart the process, which drops every socket. Recorded here because the
 * obvious tidy-up is to "complete the set" and it would buy nothing.
 *
 * **`POST /api/auth/password` is the one caller that passes the second
 * argument.** It is also the one that was missing from this list entirely: it
 * revoked every other session and told nobody, so somebody changing their
 * password *because* they believed a session had been stolen killed the
 * thief's cookie and left the thief's open socket relaying the board. That is
 * the scenario ADR 0018's 2026-08-06 amendment describes — a cookie lifted off
 * the LAN — and changing the password is precisely the thing a person does
 * about it.
 */
export const notifyUserSessionsRevoked = async (
  userId: string,
  keepSessionToken?: string,
): Promise<void> => {
  await controller?.disconnectUser(userId, keepSessionToken);
};
