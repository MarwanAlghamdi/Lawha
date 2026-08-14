import { createServer } from "node:http";

import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { createApp } from "./http/app.js";
import { createSocketAuthenticator } from "./http/middleware/session.js";
import { resolveAnonymousUser } from "./lib/anonymousUser.js";
import { seedFirstAdmin } from "./lib/firstBootAdmin.js";
import { createSocketServer } from "./socket/index.js";

/**
 * Say why the process died, before it dies.
 *
 * These do NOT change what happens — Node already terminates on both, and
 * these still exit non-zero so Docker's `restart: unless-stopped` brings the
 * server back. What they change is that the operator gets a line naming the
 * cause instead of a container that restarted for no stated reason, which is
 * this project's oldest failure mode: silence is the bug.
 *
 * Installed before anything else so they cover configuration loading and the
 * first-boot migrations too, not just the serving that follows.
 *
 * They are a net, not a fix. The known async surfaces — the socket handshake
 * and the `join-room` / `user-follow` handlers, none of which socket.io awaits
 * or catches — are guarded where they are, so a transient database error there
 * refuses one socket rather than reaching this handler at all.
 */
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `lawha: FATAL unhandled rejection: ${
      reason instanceof Error ? reason.stack ?? reason.message : String(reason)
    }\n`,
  );
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  process.stderr.write(
    `lawha: FATAL uncaught exception: ${error.stack ?? error.message}\n`,
  );
  process.exit(1);
});

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);
const httpServer = createServer(app);

createSocketServer({
  httpServer,
  config,
  authenticate: createSocketAuthenticator(ctx),
  canAccessBoard: ctx.canAccessBoard,
  // Same account the HTTP layer hands out, so socket identity and board
  // ownership agree while auth is disabled.
  getAnonymousUser: () => {
    const row = resolveAnonymousUser(ctx);
    return { id: row.id, username: row.username_display };
  },
  // Where `lawha-identities` reads a peer's display name, palette index and —
  // only when they opted in — their avatar id. Without this line the event
  // still fires and still carries socket id, user id, guest status and
  // `canEdit`, so nothing throws and no test at the relay level notices; what
  // is missing is every column that lives in the database, which is to say the
  // colour and the picture. That is the shape of failure invariant 21 warns
  // about — a feature that looks wired because the parts around it are.
  identity: ctx.users,
  metrics: ctx.metrics,
  presence: ctx.presence,
});

// Expired sessions are also pruned lazily on resolve; this keeps the table from
// growing for users who simply stop coming back.
//
// It still runs when LAWHA_SESSION_TTL_DAYS=0, and deliberately: "never expires"
// is a property of the rows the repository writes, not of this timer, and a
// database that has lived through a finite TTL — or through a deployment that
// turned expiry off yesterday — still holds rows with a real expiry that nobody
// is coming back to claim. Skipping the sweep on a never-expiring server would
// leave those there for ever. `deleteExpired` is the thing that knows which
// rows are exempt, and it excludes the year-9999 sentinel in SQL rather than
// trusting `expires_at <= now` to be false for it; the long note there explains
// why the clock is not trustworthy enough for that.
const sessionSweep = setInterval(() => {
  // Housekeeping, so it must never be the thing that takes the server down.
  // Unguarded, a single busy-database moment on the hour threw out of a timer
  // callback with no caller to catch it — which is a process exit, and every
  // open board dropped, for a sweep whose only job is to delete rows nobody
  // is coming back for. Skipping one hour costs nothing; the next tick retries.
  try {
    ctx.sessions.deleteExpired();
  } catch (error: unknown) {
    process.stderr.write(
      `lawha: session sweep failed, will retry in an hour: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}, 60 * 60 * 1000);
sessionSweep.unref();

// Before the promotion below, not after: on a genuinely empty database this is
// what creates the account that the promotion would otherwise report as
// missing. It is a no-op, and silent, once any account exists.
await seedFirstAdmin(ctx);

// Promotes the configured account on every boot, so a lost admin role is one
// restart away from being back rather than a database surgery job.
if (config.adminUsername) {
  const row = ctx.users.findByUsername(config.adminUsername);
  if (!row) {
    process.stdout.write(
      `lawha: LAWHA_ADMIN_USERNAME=${config.adminUsername} has no account yet;` +
        " it will be promoted once that account is created.\n",
    );
  } else if (row.is_admin !== 1) {
    ctx.users.setAdmin(row.id, true);
    process.stdout.write(`lawha: promoted ${row.username_display} to admin\n`);
  }
}

httpServer.listen(config.port, config.host, () => {
  process.stdout.write(
    `lawha-server listening on http://${config.host}:${config.port}\n` +
      `  database: ${config.dbPath}\n` +
      `  files:    ${config.filesDir}\n`,
  );
  if (ctx.masterPassword.enabled) {
    process.stdout.write(
      "  master password: ON — it signs in as any account, and every use is\n" +
        "                   logged here and shown in that session's UI.\n",
    );
  }
  if (!config.requireAuth) {
    process.stdout.write(
      "  WARNING: LAWHA_REQUIRE_AUTH=false — every connection is anonymous.\n" +
        "           Set it to true before exposing this server.\n",
    );
  }
});

const shutdown = () => {
  httpServer.close(() => {
    ctx.db.close();
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
