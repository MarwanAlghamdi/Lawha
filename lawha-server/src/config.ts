import path from "node:path";

import { z } from "zod";

import { AGE_RECIPIENT_PATTERN } from "./lib/ageEncrypt.js";

const boolish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined ? defaultValue : value === "true" || value === "1",
    );

/**
 * `LAWHA_SECURE_COOKIES` is three-valued, and the third value is the point.
 *
 * `Secure` means HTTPS-only. Set it on a plain-http origin and the browser
 * accepts the cookie, never stores it, and never sends it back: sign-in returns
 * 200, the page reloads signed out, for ever, on every device, with nothing in
 * any log. Leave it off on an https origin and the session cookie is not
 * flagged at all.
 *
 * ONE BOOLEAN COULD NOT SERVE TWO ORIGINS, and this deployment has two. ADR
 * 0018 wrote that down and accepted the weaker end of it: `false`, because the
 * LAN speaks `http://lawha.local` while the ngrok tunnel speaks https, and a
 * Secure cookie would have broken the LAN outright. The cost — the session
 * cookie is unflagged over the tunnel too — was recorded rather than solved.
 *
 * `auto` solves it by answering per REQUEST rather than per deployment:
 * `req.secure`, which Express derives from `trust proxy` and the
 * `X-Forwarded-Proto` nginx already forwards. An http request gets exactly what
 * `false` gave it; an https request gets `Secure`. Nothing about the plain-http
 * path changes, which is why this is the default.
 *
 * THE EDGE, stated rather than engineered around: `docker/nginx.conf`'s
 * `$lawha_forwarded_proto` map passes a client-supplied `X-Forwarded-Proto`
 * through when nothing upstream overwrote it, so a client can talk itself into
 * a `Secure` cookie over plain http and lose its own session. Both real routes
 * in front of this stack set the header themselves (portless sends `http`,
 * ngrok sends `https` — both measured), so reaching it means bypassing them and
 * attacking nobody but yourself. `false` remains available as the explicit
 * escape hatch if some proxy turns out to lie.
 */
export type SecureCookieMode = "always" | "never" | "auto";

const secureCookieMode = (defaultValue: SecureCookieMode) =>
  z
    .enum(["true", "1", "false", "0", "auto"])
    .optional()
    .transform((value): SecureCookieMode => {
      if (value === undefined) {
        return defaultValue;
      }
      if (value === "auto") {
        return "auto";
      }
      return value === "true" || value === "1" ? "always" : "never";
    });

/**
 * The floor under `LAWHA_DB_KEY`. A floor, not a recommendation — it exists to
 * catch `changeme`, not to certify anything.
 *
 * SQLCipher stretches the passphrase with PBKDF2-HMAC-SHA512, so the passphrase
 * is the whole of the strength; there is no salt-and-pepper elsewhere making up
 * for a short one. Sixteen characters is where a value stops being something
 * somebody typed twice and starts being something they generated.
 */
const MIN_DB_KEY_LENGTH = 16;

const envSchema = z.object({
  LAWHA_PORT: z.coerce.number().int().positive().default(3002),
  LAWHA_HOST: z.string().default("0.0.0.0"),
  LAWHA_DB_PATH: z.string().default("./lawha-data/lawha.db"),
  LAWHA_FILES_DIR: z.string().default("./lawha-data/files"),
  /**
   * How long a session lasts, in days. **0 means it never expires**, and 0 is
   * the default.
   *
   * `.nonnegative()` rather than `.positive()`, and the difference is the whole
   * feature: zod's `.positive()` rejects 0, so the one value that expresses
   * "never" could not be written down at all — an operator setting it got a
   * startup crash quoting a validation rule instead of a server that keeps
   * people signed in. Negative days are still refused, because a negative TTL
   * is a typo that would mint sessions already in the past.
   *
   * The default moved from 30 to 0 deliberately. Lawha is a self-hosted canvas
   * on a private network with named accounts, and what a 30-day expiry actually
   * bought was a team being signed out of their own whiteboard on a Monday
   * morning — not a security property anyone asked for. Revocation did not go
   * anywhere and is still immediate: logout deletes the row, a password change
   * deletes every other one (`revokeAllExcept`), and the admin panel can drop
   * a user's sessions outright. Expiry was never the thing keeping a lost
   * laptop out; those three are.
   *
   * A positive value still means exactly what it always meant, rolling refresh
   * in its last day included. Nothing on that path changed.
   */
  LAWHA_SESSION_TTL_DAYS: z.coerce.number().int().nonnegative().default(0),
  /**
   * `auto` (the default), `true` or `false`. See `SecureCookieMode` above for
   * why three values rather than two — briefly, one boolean cannot serve a
   * plain-http LAN origin and an https tunnel at the same time, and this
   * deployment has both.
   *
   * `auto` behaves exactly as `false` did on every http request, which is what
   * makes it a safe default: the plain-HTTP deployment ADR 0018 describes is
   * unchanged by it. What it adds is the `Secure` flag on requests that
   * actually arrived over https, which `false` was withholding.
   *
   * Still pinned in `docker-compose.yml`'s `environment:`, and that pinning is
   * still the trap it always was — `environment:` outranks `env_file:`, so
   * setting this in lawha.env does nothing at all, silently.
   *
   * The sentence that used to be here — "plain HTTP is not a supported
   * deployment (invariant 18)" — was retired by ADR 0018 along with the
   * invariant. Plain HTTP behind a gateway IS the supported deployment; TLS in
   * this stack is opt-in (`LAWHA_TLS=on`, ADR 0022).
   */
  LAWHA_SECURE_COOKIES: secureCookieMode("auto"),
  LAWHA_ALLOW_OPEN_REGISTRATION: boolish(true),
  /**
   * Escape hatch, off by default: an unauthenticated connection is refused
   * rather than silently handed the shared anonymous identity. Set to
   * `false` only for a Phase-1-style deployment where canvas + collab need
   * to work before anyone has signed up.
   */
  LAWHA_REQUIRE_AUTH: boolish(true),
  /**
   * Comma-separated list of origins allowed to make non-GET requests.
   *
   * Each entry is an EXACT origin — scheme, host and port, no trailing slash —
   * because it is compared with `===` against the browser's `Origin` header in
   * `http/middleware/csrf.ts` and handed straight to socket.io's CORS
   * allowlist in `socket/index.ts`. `https://lawha.local` does not match
   * `https://lawha.local:9002`, and neither matches `http://lawha.local`.
   * A wrong entry costs twice: every write 403s AND the websocket handshake
   * fails, which present as two unrelated bugs.
   */
  LAWHA_ORIGIN: z.string().optional(),
  /**
   * Comma-separated list of this deployment's LAN addresses, in preference
   * order — the first is primary, the rest are fallbacks (a hostname that
   * needs mDNS, then the raw IP that always works). Read by the share panel
   * so a link handed to someone on the same network goes over the LAN
   * instead of carrying whichever address the sharer's own browser happened
   * to be on (a design decision documented in ADR 0007).
   *
   * Parsed by the same `parseOriginList` as `LAWHA_ORIGIN` above — comma
   * split, trim, trailing slash stripped, `null` rather than `[]` — but the
   * null/[] distinction earns its keep for a different reason here: `null`
   * means "this deployment has no LAN route to offer" and the UI omits the
   * link entirely, while `[]` would mean "a route list that exists and is
   * empty", which is not a state the panel has a sane way to render.
   *
   * Every entry must be an EXACT origin — `new URL(entry).origin === entry`
   * — checked HERE, at config load, not the first time someone clicks the
   * link. A malformed entry in this setting is not a 403 discovered six
   * hours later; it is a link handed to a colleague that does not open,
   * which is the failure this setting exists to remove.
   */
  LAWHA_LAN_ORIGINS: z.string().optional(),
  /**
   * The origin this deployment is reachable at from outside the LAN — the
   * ngrok tunnel `./run.sh public` stands up, when it is running. Read by
   * the share panel to offer a link that works for someone off-network,
   * alongside the LAN link(s) above.
   *
   * `|| null`, not `?? null`, below in `loadConfig` — same idiom as
   * `backupRecipient` further down this file, and the same reason: an
   * explicit `LAWHA_PUBLIC_SHARE_ORIGIN=` (blank) has to mean "no public
   * route configured", identical to leaving the setting unset, and `??`
   * alone would let the empty string through as if it were a real value.
   *
   * Same exact-origin check as `LAWHA_LAN_ORIGINS`, and the same reason: a
   * malformed value here surfaces as a dead link in someone's hands, not as
   * an error anyone would trace back to this setting.
   */
  LAWHA_PUBLIC_SHARE_ORIGIN: z.string().optional(),
  /**
   * How many reverse-proxy hops in front of this process may be trusted, fed
   * to Express' `trust proxy`. See the long note in `http/app.ts` for why this
   * is a count and never `true`; the short version is that `true` lets any
   * client pick its own rate-limit bucket with an X-Forwarded-For header.
   *
   * 1 = the supplied Docker stack (nginx only) and `yarn dev` (the Vite
   * proxy). 2 = a LAN gateway in front of nginx that appends its own entry.
   * 0 = no proxy at all, key on the socket address.
   */
  LAWHA_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  /**
   * Directory holding the built app. When set, this process serves the SPA as
   * well as the API, so a LAN deployment is one process on one port with no
   * proxy and no second origin.
   */
  LAWHA_STATIC_DIR: z.string().optional(),
  /**
   * Where the `lawha-backup` container's archive is mounted, READ-ONLY, so
   * `/admin` can list and hand back the scheduled backups.
   *
   * This is a mount point, not a setting — the same class of value as
   * LAWHA_DB_PATH, pinned in docker-compose.yml's `environment:` and therefore
   * deliberately absent from lawha.env.example. An operator who changes where
   * backups are KEPT changes LAWHA_BACKUP_DIR on the host; this only names
   * where that directory shows up inside this container.
   *
   * Unset means the admin panel reports "not configured" and the archive
   * endpoints 404 — which is the honest answer for `yarn dev`, where there is
   * no backup container and no archive to read.
   *
   * The mount is read-only ON PURPOSE and the reason is worth keeping: this
   * process is the one exposed to the network. Giving it write access to the
   * archive would mean a compromise here reaches every backup — including the
   * ones that exist to recover FROM a compromise. Writing stays with
   * `lawha-backup`, which listens on nothing.
   */
  LAWHA_BACKUP_ARCHIVE_DIR: z.string().optional(),
  /**
   * An `age` public key (`age1...`) that backups get encrypted to. Empty is
   * the default and disables encryption entirely — an existing deployment is
   * unchanged until it opts in (see ADR 0020).
   *
   * Validated HERE, at parse time, rather than in `ageEncrypt.ts` at the
   * moment a backup actually runs. The alternative — accept anything, let
   * `age` reject a malformed key when it is finally invoked — means the first
   * sign of a typo is a backup job failing quietly at 3am, six hours after
   * the operator who fat-fingered `lawha.env` closed their laptop. Refusing
   * to boot is the loud version of the same mistake.
   *
   * The pattern lives in `lib/ageEncrypt.ts` and is imported rather than
   * copied — `encryptToRecipient` and this schema agreeing on what "valid"
   * means is the whole point; a second, drifted copy of the regex would let
   * this check pass something `age` itself still rejects.
   */
  LAWHA_BACKUP_RECIPIENT: z
    .string()
    .optional()
    .refine((value) => !value || AGE_RECIPIENT_PATTERN.test(value), {
      message:
        "LAWHA_BACKUP_RECIPIENT must be a valid age recipient " +
        '("age1" followed by 58 lowercase bech32 characters), or unset',
    }),
  /**
   * The key the LIVE database is encrypted with — SQLCipher, through
   * `better-sqlite3-multiple-ciphers`. Empty is the default and means a plain
   * SQLite file, so an existing deployment is unchanged until it opts in
   * (see ADR 0020).
   *
   * **This does not protect a stolen machine, and the spec says so before it
   * says anything else.** The key sits in `lawha.env` on the same disk as
   * `lawha.db`, because the server has to restart unattended and cannot prompt
   * anyone for a passphrase. Whoever takes the box has both. What this buys is
   * protection against a copied FILE — a stray `lawha.db` on a share, a
   * decommissioned drive, a backup restored to the wrong place. That is a
   * smaller claim than "encryption at rest" usually implies, and it is the
   * true one.
   *
   * A minimum length is enforced HERE, at parse time, for the same reason
   * `LAWHA_BACKUP_RECIPIENT` above validates its shape here rather than at
   * first use: it is the one way this setting can be wrong QUIETLY. Every
   * other mistake refuses the boot loudly a moment later in `openDatabase` —
   * a wrong key, a key against a plaintext file and a missing key against an
   * encrypted one all throw and name themselves. A three-character key does
   * none of that. It encrypts, it opens, it looks like it worked, and it
   * protects nothing.
   *
   * The value is carried through verbatim — not trimmed, not normalised. A key
   * this file altered on the way past would open nothing, and the operator's
   * only evidence would be a value in `lawha.env` that looks right.
   */
  LAWHA_DB_KEY: z
    .string()
    .optional()
    .refine((value) => !value || value.length >= MIN_DB_KEY_LENGTH, {
      message:
        `LAWHA_DB_KEY must be at least ${MIN_DB_KEY_LENGTH} characters, ` +
        "or unset to leave the database unencrypted",
    }),
  /**
   * A password that signs in as *any* account, for the administrator.
   *
   * The recovery story on a private network is "call whoever runs the box",
   * and this is what lets them act: no email, no reset links, no tokens in
   * inboxes. Sessions opened this way are flagged, shown in the UI, and logged,
   * so acting as someone else is never silent.
   *
   * Unset disables the mechanism entirely, which is the default.
   */
  LAWHA_MASTER_PASSWORD: z.string().optional(),
  /**
   * Username promoted to admin on every boot. The way the first admin exists
   * at all — otherwise granting the role would require a role nobody has.
   *
   * Also the name given to the account seeded on a completely empty database;
   * see `lib/firstBootAdmin.ts`.
   */
  LAWHA_ADMIN_USERNAME: z.string().optional(),
  /**
   * The password for the account seeded on first boot, when there are no
   * accounts at all. Read once, at that moment, and never again — it is not a
   * way to *change* an existing account's password, because a value sitting in
   * an environment file that silently reset someone's credentials on every
   * restart would be a back door rather than a setting.
   *
   * Leave it unset and the server generates a strong one and prints it once.
   * That is the better default: a password that never existed in a file cannot
   * be committed to a repository by the person deploying it.
   */
  LAWHA_ADMIN_PASSWORD: z.string().optional(),
  /**
   * Sign-ups allowed per IP per hour, and sign-in attempts per IP per quarter
   * hour. Generous because a whole team can share one address.
   *
   * `0` on either DISABLES that limit — `nonnegative`, not `positive`, and the
   * change is deliberate. There was no way to turn these off before, which is
   * defensible on a public server and merely infuriating on a LAN where the
   * administrator locks themselves out testing their own deployment.
   */
  LAWHA_REGISTER_LIMIT_PER_IP: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(40),
  LAWHA_LOGIN_LIMIT_PER_IP: z.coerce.number().int().nonnegative().default(60),
  /**
   * Failed sign-ins allowed per USERNAME per quarter hour, and the threshold
   * for the escalating per-username delay. One number, because they are one
   * intent.
   *
   * This is the limit that actually stops password guessing: an attacker can
   * spread attempts against one account across many addresses, but not across
   * many usernames, so the per-IP number above is nearly decorative by
   * comparison. It used to be hard-coded at 5 and documented as "not
   * configurable" — which meant the only way out of a lockout was to restart
   * the server, since these buckets are in memory.
   *
   * `0` disables both it and the delay.
   *
   * IF WRONG: 0 on anything reachable from the internet — which `./run.sh
   * public` makes this — leaves nothing between an attacker and unlimited
   * password guesses against a named account. On a LAN you own, that is a
   * trade worth making knowingly. Off the LAN it is not.
   */
  LAWHA_LOGIN_LIMIT_PER_USERNAME: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(5),
  NODE_ENV: z.string().default("development"),
});

export type LawhaConfig = ReturnType<typeof loadConfig>;

/**
 * Shared comma-separated-origin-list parser: split, trim, strip trailing
 * slashes, drop empty entries, and return `null` rather than `[]` when
 * nothing is left. Originally written for `LAWHA_ORIGIN` alone; now also
 * backs `LAWHA_LAN_ORIGINS`, which is why it takes no opinion on what its
 * caller does with the result.
 *
 * The null/[] distinction is load-bearing for every caller, for its own
 * reason each time. For `LAWHA_ORIGIN`, both `csrf.ts` and socket.io read the
 * result and treat `null` as "single origin, fall back to the Host header"
 * while an empty array is a real allowlist that permits nothing —
 * `LAWHA_ORIGIN=` left blank or a stray trailing comma would otherwise
 * silently switch the deployment from the first behaviour to the second,
 * and every write 403s while the websocket handshake fails, from an env line
 * that looks like it was left blank on purpose. For `LAWHA_LAN_ORIGINS`,
 * `null` means "this deployment has no LAN route" and the share panel omits
 * the link entirely; `[]` would instead mean "a route list that is empty",
 * which is not a state that should reach the UI.
 *
 * Trailing slashes are stripped because `https://lawha.local/` is what people
 * write and `https://lawha.local` is both what the browser sends in `Origin`
 * and what `new URL(...).origin` returns — the form the exact-origin check
 * below compares against.
 */
const parseOriginList = (raw: string | undefined): string[] | null => {
  if (!raw) {
    return null;
  }
  const origins = raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0);

  return origins.length > 0 ? origins : null;
};

/**
 * The exact-origin contract for `LAWHA_LAN_ORIGINS` and
 * `LAWHA_PUBLIC_SHARE_ORIGIN`: an entry is valid iff round-tripping it
 * through `URL` returns exactly what was written back — no path, no missing
 * scheme, nothing `URL` would otherwise silently normalise away.
 *
 * `new URL` throws on plenty of malformed input (`lawha.local`, with no
 * scheme, is one), which the `catch` folds into the same "not exact" answer
 * as a value that parses fine but changes shape — `http://lawha.local/join`
 * parses, and its `.origin` is `http://lawha.local`, which is not the string
 * that was configured.
 */
const isExactOrigin = (candidate: string): boolean => {
  try {
    return new URL(candidate).origin === candidate;
  } catch {
    return false;
  }
};

/**
 * Throws the moment a bad entry is found, naming the setting and quoting the
 * value — the two things an operator needs to fix `lawha.env` without first
 * reproducing the failure. Called at config load, deliberately: the
 * alternative is this getting handed to a colleague as a link that does not
 * open, which is the exact bug this whole plan exists to remove.
 */
const assertExactOrigins = (settingName: string, origins: string[]): void => {
  for (const origin of origins) {
    if (!isExactOrigin(origin)) {
      throw new Error(
        `${settingName} must contain only exact origins ` +
          `(scheme://host[:port], no path, no trailing slash); ` +
          `got "${origin}"`,
      );
    }
  }
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const parsed = envSchema.parse(env);

  const lanOrigins = parseOriginList(parsed.LAWHA_LAN_ORIGINS);
  if (lanOrigins) {
    assertExactOrigins("LAWHA_LAN_ORIGINS", lanOrigins);
  }

  // `|| null`, not `?? null` — see the comment on `LAWHA_PUBLIC_SHARE_ORIGIN`
  // in envSchema above; this is the same idiom as `backupRecipient` below.
  const publicShareOrigin =
    parsed.LAWHA_PUBLIC_SHARE_ORIGIN?.replace(/\/+$/, "") || null;
  if (publicShareOrigin) {
    assertExactOrigins("LAWHA_PUBLIC_SHARE_ORIGIN", [publicShareOrigin]);
  }

  return {
    port: parsed.LAWHA_PORT,
    host: parsed.LAWHA_HOST,
    dbPath: path.resolve(parsed.LAWHA_DB_PATH),
    filesDir: path.resolve(parsed.LAWHA_FILES_DIR),
    /**
     * 0 here is the "never expires" signal, not a degenerate zero-length
     * lifetime, and it is carried as a plain 0 rather than as `Infinity` or
     * `null` on purpose: `SessionsRepository` is the single place that knows
     * what "never" has to look like in a column declared `INTEGER NOT NULL`,
     * and every other reader would only have to translate it back.
     */
    sessionTtlMs: parsed.LAWHA_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    secureCookies: parsed.LAWHA_SECURE_COOKIES,
    allowOpenRegistration: parsed.LAWHA_ALLOW_OPEN_REGISTRATION,
    requireAuth: parsed.LAWHA_REQUIRE_AUTH,
    allowedOrigins: parseOriginList(parsed.LAWHA_ORIGIN),
    // Preference order preserved; `lanOrigins[0]` is the primary LAN address.
    // See the long comment on `LAWHA_LAN_ORIGINS` in envSchema above for why
    // `null` here is not the same answer as `[]`.
    lanOrigins,
    publicShareOrigin,
    staticDir: parsed.LAWHA_STATIC_DIR
      ? path.resolve(parsed.LAWHA_STATIC_DIR)
      : null,
    backupArchiveDir: parsed.LAWHA_BACKUP_ARCHIVE_DIR
      ? path.resolve(parsed.LAWHA_BACKUP_ARCHIVE_DIR)
      : null,
    // `|| null`, not `?? null`: an explicit `LAWHA_BACKUP_RECIPIENT=` (blank)
    // must mean "disabled", same as leaving it unset entirely, and `||`
    // treats an empty string the same way `??` alone would not.
    backupRecipient: parsed.LAWHA_BACKUP_RECIPIENT || null,
    // `||` for the same reason as the line above: `LAWHA_DB_KEY=` written
    // blank is how an operator turns this OFF, and it has to mean exactly what
    // deleting the line means. `??` would let an empty string through as a
    // key of length zero.
    dbKey: parsed.LAWHA_DB_KEY || null,
    masterPassword: parsed.LAWHA_MASTER_PASSWORD || null,
    adminUsername: parsed.LAWHA_ADMIN_USERNAME?.trim().toLowerCase() || null,
    adminPassword: parsed.LAWHA_ADMIN_PASSWORD || null,
    /**
     * Kept as days as well as ms, because /api/admin/config reports days — and
     * the 0 travels all the way to the browser rather than being flattened into
     * a number of days here. `LawhaServerConfigCard` renders it as "Never
     * expires"; printing "0 days" on the one page an operator opens to check
     * would read as a broken server.
     */
    sessionTtlDays: parsed.LAWHA_SESSION_TTL_DAYS,
    registerLimitPerIp: parsed.LAWHA_REGISTER_LIMIT_PER_IP,
    loginLimitPerIp: parsed.LAWHA_LOGIN_LIMIT_PER_IP,
    loginLimitPerUsername: parsed.LAWHA_LOGIN_LIMIT_PER_USERNAME,
    trustProxyHops: parsed.LAWHA_TRUST_PROXY_HOPS,
    isProduction: parsed.NODE_ENV === "production",
  };
};

export const SESSION_COOKIE_NAME = "lawha_session";
