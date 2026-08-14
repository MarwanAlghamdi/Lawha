import { Server } from "socket.io";

import { GUEST_COOKIE_NAME, guestRegistry } from "../lib/guests.js";
import { parseCookies, readSessionToken } from "../http/middleware/session.js";
import { SOCKET_ERRORS } from "../protocol.js";

import { guestDisplayName, publishAccountIdentitySource } from "./identity.js";
import { publishRoomAccessController } from "./liveAccess.js";
import { createRoomAccessController, registerRoomHandlers } from "./rooms.js";

import type { AccountIdentitySource } from "./identity.js";
import type { LawhaMetrics } from "./metrics.js";
import type { PresenceRegistry } from "./presence.js";
import type { SocketUser } from "./rooms.js";
import type { LawhaConfig } from "../config.js";
import type { IncomingHttpHeaders, Server as HttpServer } from "node:http";

export interface CreateSocketServerDeps {
  httpServer: HttpServer;
  config: LawhaConfig;
  /** Resolves the session cookie on the handshake into a user, or null. */
  authenticate: (
    cookieHeader: string | undefined,
  ) => Promise<SocketUser | null>;
  canAccessBoard: (userId: string, boardId: string) => Promise<boolean>;
  /**
   * The stand-in identity used when `LAWHA_REQUIRE_AUTH=false`.
   *
   * Must resolve to the *same* user the HTTP layer uses, or the socket sees a
   * different id than the one that owns the boards, and even the board's own
   * creator is refused at `join-room`.
   */
  getAnonymousUser?: () => SocketUser;
  /**
   * Where `lawha-identities` reads a peer's display name, palette index and
   * — only if they opted in — their avatar id. `ctx.users` satisfies it.
   *
   * Optional because the relay's own tests construct this server without a
   * database. Without it the event still carries socket id, user id, guest
   * status and edit rights; only the columns are missing.
   */
  identity?: AccountIdentitySource;
  metrics?: LawhaMetrics;
  presence?: PresenceRegistry;
}

/**
 * Is this handshake allowed to become a socket, judged on its `Origin`?
 *
 * This is `http/middleware/csrf.ts`'s rule, deliberately the same rule and not
 * merely a similar one: allowlisted origin, OR an origin whose host is the
 * `Host` the request arrived on, OR no usable `Origin` at all. `LAWHA_ORIGIN`
 * has two consumers and must not mean two different things — a box reachable
 * by a name nobody listed still saves over HTTP, because csrf falls back to
 * `Host`, and if the socket half did not it would go quiet instead. That is
 * exactly the pair of "two unrelated bugs at once" `lawha.env.example` warns
 * about, arriving from the fix rather than from the misconfiguration. If the
 * rule in `csrf.ts` changes, this moves with it.
 *
 * A missing `Origin` is allowed on purpose. Any client that this would refuse
 * can simply omit the header — so refusing costs every non-browser client
 * (operator tooling, this relay's own test suite) and buys nothing.
 *
 * Which is the honest framing of the whole check: it is a BROWSER-SAFETY
 * measure, not an authentication boundary. What it closes is cross-site
 * WebSocket hijacking — a page on another origin opening a relay socket with
 * the visitor's cookies riding along. The actual boundaries are the session
 * cookie resolved in the middleware below and the per-room, re-checked
 * authorization in `rooms.ts` (invariants 22 and 23).
 */
const isHandshakeOriginAllowed = (
  headers: IncomingHttpHeaders,
  allowedOrigins: string[] | null,
): boolean => {
  const origin = headers.origin;

  // `"null"` is the opaque origin a sandboxed iframe or a `file://` page sends.
  // csrf.ts lets it through and so does this; diverging here would reintroduce
  // the one-name-two-meanings problem for a case Lawha has no deployment for
  // (invariant 18 — retired by ADR 0018; plain http behind a gateway IS a supported deployment now, and TLS in the stack is opt-in per ADR 0022).
  if (typeof origin !== "string" || origin === "null") {
    return true;
  }

  if (allowedOrigins?.includes(origin)) {
    return true;
  }

  try {
    // `docker/nginx.conf` forwards `$http_host` — the host the browser typed,
    // port included — on `/socket.io/` specifically so this comparison holds
    // with no `LAWHA_ORIGIN` entry at all. The Vite dev proxy sets
    // `changeOrigin: false` for the same reason.
    return new URL(origin).host === headers.host;
  } catch {
    return false;
  }
};

export const createSocketServer = ({
  httpServer,
  config,
  authenticate,
  canAccessBoard,
  getAnonymousUser,
  identity,
  metrics,
  presence,
}: CreateSocketServerDeps): Server => {
  const io = new Server(httpServer, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    // The 1 MiB default silently disconnects sockets mid-SCENE_INIT on any
    // board of consequence.
    maxHttpBufferSize: 20e6,
    pingTimeout: 20000,
    pingInterval: 25000,
    /**
     * The refusal. `cors` below cannot be it, and used to be believed to be.
     *
     * `cors` is a GRANT, not a GUARD. For a disallowed origin the `cors`
     * package pushes `Access-Control-Allow-Origin: false`, `applyHeaders`
     * skips false-valued headers, and it calls `next()` with no error —
     * while engine.io's `_applyMiddlewares` aborts only when a middleware
     * passes an error. Measured against the installed socket.io 4.7.2 /
     * engine.io 6.5.5 / cors 2.8.6, with this exact option shape: a polling
     * handshake from `https://evil.example` returned 200 and a usable sid,
     * and a raw websocket upgrade carrying that Origin returned 101 with the
     * socket open. The allowlist refused nothing, in either transport, ever
     * — and `Collab.tsx` opens websocket-first, which browsers do not
     * CORS-check at all.
     *
     * `allowRequest` is where a refusal can happen, rather than an
     * `io.use()` middleware: engine.io's `verify()` runs it on any request
     * carrying no `sid`, which is the first request of both transports, so
     * the connection is answered 403/400 and destroyed before a websocket
     * exists. An `io.use()` check would let the upgrade reach 101 and only
     * then error at the namespace layer.
     */
    allowRequest: (req, callback) => {
      const allowed = isHandshakeOriginAllowed(
        req.headers,
        config.allowedOrigins,
      );
      // The message reaches the server's `connection_error` context, not the
      // client — deliberately: a refused origin is a hostile page far more
      // often than a typo, and the operator's copy of this is the config.
      callback(allowed ? undefined : "origin not allowed", allowed);
    },
    // Same-origin in every supported deployment (Vite proxy in dev, nginx in
    // prod), so credentials ride along without CORS negotiation. Kept for the
    // split-origin case, where it is the header the browser needs to *read*
    // the polling handshake — including the `sid` that `allowRequest` is
    // skipped for on every subsequent request.
    cors: config.allowedOrigins
      ? { origin: config.allowedOrigins, credentials: true }
      : undefined,
  });

  io.use((socket, next) => {
    void (async () => {
      const user = await authenticate(socket.handshake.headers.cookie);

      if (user) {
        socket.data.user = user;
        // Kept so a revocation that spares one session can spare its socket
        // too — `rooms.ts` documents why the account id alone is not enough.
        // `authenticate` has already proved this token; reading it again here
        // rather than threading it out of that callback keeps the resolver's
        // signature the tests inject unchanged.
        socket.data.sessionToken =
          readSessionToken(socket.handshake.headers.cookie) ?? undefined;
        next();
        return;
      }

      // A share-link visitor with no account. The pass is minted over HTTP
      // (POST /api/boards/:id/access) and is scoped to one board, so this
      // identity can reach that room and nothing else — and `authz` gives it
      // no write rights anywhere, whatever the board's link access says.
      //
      // This is what makes a share link usable without an account at all. The
      // stopgap it replaces — `LAWHA_REQUIRE_AUTH=false` — gave every visitor
      // the *same* `anonymous` user id, so guests co-owned each other's
      // boards: that disables the authorization model rather than relaxing it.
      const guest = guestRegistry.resolve(
        parseCookies(socket.handshake.headers.cookie).get(GUEST_COOKIE_NAME),
      );

      if (guest) {
        socket.data.user = {
          id: guest.id,
          // Every guest used to be called "Guest", which on a board with two of
          // them is indistinguishable from one person with two tabs open. The
          // placeholder is derived from the pass id, so it is stable for that
          // visitor and tells nobody anything they did not already know.
          username: guestDisplayName(guest.id),
          isGuest: true,
          guestBoardId: guest.boardId,
        };
        next();
        return;
      }

      if (!config.requireAuth) {
        socket.data.user = getAnonymousUser
          ? getAnonymousUser()
          : { id: "anonymous", username: "anonymous" };
        next();
        return;
      }

      // Surfaces client-side as `connect_error`; Collab.tsx branches on the
      // message to prompt for login rather than silently falling back.
      next(new Error(SOCKET_ERRORS.UNAUTHENTICATED));
    })().catch((error: unknown) => {
      // `void` on its own threw this promise away. `authenticate` reads the
      // session row out of SQLite, so a database that is briefly busy or
      // locked rejects here — and since Node 15 an unhandled rejection
      // terminates the process. One person's reconnect could therefore kill
      // the server for everyone who was drawing, with nothing in the log
      // beyond the bare stack.
      //
      // Refusing this ONE handshake is the proportionate answer. `next(err)`
      // reaches the client as `connect_error`, which Collab.tsx already
      // handles, and socket.io's own retry means a transient fault heals on
      // the next attempt instead of needing an operator.
      process.stderr.write(
        `lawha: socket handshake failed: ${
          error instanceof Error ? error.stack ?? error.message : String(error)
        }\n`,
      );
      next(new Error("LAWHA_HANDSHAKE_FAILED"));
    });
  });

  if (identity) {
    publishAccountIdentitySource(identity);
  }

  io.on("connection", (socket) => {
    registerRoomHandlers(socket, { io, canAccessBoard, metrics, presence });
  });

  // Published so the HTTP layer can evict or demote live sockets when a
  // board's sharing changes. The two halves are built independently in
  // `src/index.ts` and never see each other directly.
  publishRoomAccessController(
    createRoomAccessController({ io, metrics, presence }),
  );

  return io;
};

export { registerRoomHandlers } from "./rooms.js";
export type { SocketUser } from "./rooms.js";
export {
  buildRoomIdentities,
  guestDisplayName,
  publishAccountIdentitySource,
} from "./identity.js";
export type { AccountIdentitySource } from "./identity.js";
