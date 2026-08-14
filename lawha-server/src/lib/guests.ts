import crypto from "node:crypto";

import type { Principal } from "../socket/authz.js";

export const GUEST_COOKIE_NAME = "lawha_guest";

/** A guest link is a day pass, not a session. */
const GUEST_TTL_MS = 12 * 60 * 60 * 1000;

/** Bounds memory on a server someone points a crawler at. */
const MAX_GUESTS = 5000;

export interface GuestRecord {
  id: string;
  boardId: string;
  expiresAt: number;
}

export interface GuestRegistry {
  /** Mints a pass for exactly one board. */
  mint: (boardId: string) => { token: string; guest: GuestRecord };
  resolve: (token: string | null | undefined) => GuestRecord | null;
  size: () => number;
}

/**
 * Account-less visitors, held in memory.
 *
 * Deliberately *not* a row in `sessions`: that table's foreign key is a real
 * user, and the alternative — one shared `anonymous` account, which is what
 * `LAWHA_REQUIRE_AUTH=false` hands out — makes every guest the same principal,
 * so guests end up co-owning each other's boards. A guest here is its own id,
 * scoped to one board, and can never be an owner of anything.
 *
 * In memory is the right durability for it, too: a guest pass grants nothing
 * that the share link does not already grant, and a restart simply means the
 * next page load mints another one.
 */
export const createGuestRegistry = (): GuestRegistry => {
  const guests = new Map<string, GuestRecord>();

  const prune = (now: number) => {
    for (const [token, record] of guests) {
      if (record.expiresAt <= now) {
        guests.delete(token);
      }
    }
  };

  return {
    mint: (boardId: string) => {
      const now = Date.now();
      prune(now);

      if (guests.size >= MAX_GUESTS) {
        // Oldest first: Map preserves insertion order and every record has the
        // same TTL, so the head is always the closest to expiring.
        const oldest = guests.keys().next();
        if (!oldest.done) {
          guests.delete(oldest.value);
        }
      }

      const token = crypto.randomBytes(32).toString("base64url");
      const guest: GuestRecord = {
        id: `guest_${crypto.randomBytes(12).toString("hex")}`,
        boardId,
        expiresAt: now + GUEST_TTL_MS,
      };
      guests.set(token, guest);
      return { token, guest };
    },

    resolve: (token) => {
      if (!token) {
        return null;
      }
      const record = guests.get(token);
      if (!record) {
        return null;
      }
      if (record.expiresAt <= Date.now()) {
        guests.delete(token);
        return null;
      }
      return record;
    },

    size: () => guests.size,
  };
};

/**
 * The process-wide registry.
 *
 * One instance, shared by the HTTP middleware and the socket handshake, in the
 * same way `resolveAnonymousUser` is shared: a guest that the REST layer
 * recognises and the relay does not is a visitor who can read the scene and
 * never see it change.
 */
export const guestRegistry: GuestRegistry = createGuestRegistry();

export const guestPrincipal = (guest: GuestRecord): Principal => ({
  id: guest.id,
  isGuest: true,
  guestBoardId: guest.boardId,
});

export const buildGuestCookie = (
  token: string,
  expiresAt: number,
  secure: boolean,
): string => {
  const attributes = [
    `${GUEST_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    // Lax for the same reason the session cookie is: a share link clicked from
    // a chat window is a cross-site top-level GET.
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`,
  ];
  if (secure) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
};
