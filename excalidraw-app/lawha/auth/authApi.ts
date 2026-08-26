/**
 * The auth surface of lawha-server, typed.
 *
 * Every call is same-origin: the session lives in an httpOnly cookie the app
 * never reads, so there is no token to store, refresh, or leak. That is the
 * whole reason these are plain fetches rather than an auth SDK.
 */

import { API_BASE, NGROK_SKIP_HEADER, parseJsonBody } from "../../data/api";

import type { ShareOrigins } from "../share/shareOrigins";

export interface LawhaUser {
  id: string;
  username: string;
  /** Index into COLLABORATOR_PALETTE, or null to use the hashed default. */
  colorIndex: number | null;
  /** null means "follow my cursor colour". */
  laserColorIndex: number | null;
  /**
   * Opaque id of the stored profile picture, or null when there is none. It
   * changes on every upload, which is what makes `avatarUrl` cache-safe.
   */
  avatarId: string | null;
  /**
   * Whether this person's picture is drawn as their canvas cursor.
   *
   * **On by default since migration 009**, so the sentence this comment used to
   * open with — "whether this person has *asked* for" — was wrong the moment
   * that landed. It is now an opt-*out*: somebody with a picture gets it on
   * their cursor unless they turn it off, and somebody without one falls back
   * to their initials exactly as before.
   *
   * Present-and-false rather than absent, mirroring the server's `PublicUser`:
   * a client that has to infer this from a missing field will eventually infer
   * the permissive answer, and the permissive answer here publishes a
   * photograph. The server only puts an `avatarId` on the identity broadcast
   * when this is on AND a picture exists, so the flag is the account owner's
   * copy of a decision enforced there.
   *
   * Worth knowing what "on" actually exposes, because it is wider than it
   * sounds: the avatar route is deliberately not session-gated, and
   * `lawha-identities` hands your account id to every co-present peer —
   * including an account-less link guest. So the audience is "anyone in a room
   * with you, or holding a working link to a board you are on", which is the
   * same set that already sees your name and your cursor.
   */
  avatarOnCursor: boolean;
  isAdmin: boolean;
  /**
   * When the account was stopped, or null while it is active (migration 016).
   *
   * A timestamp rather than a boolean because the question asked about a
   * disabled account is "when", and because `disabled: false` and
   * `disabledAt: null` are the same fact told with different amounts of it.
   */
  disabledAt: number | null;
  /**
   * When an administrator deleted this account, or null (ADR 0031).
   *
   * Only ever non-null in the administration list — everywhere else this shape
   * describes a signed-in account, and a deleted account cannot sign in.
   *
   * Distinct from `disabledAt`, and both can be set: an account turned off in
   * March and deleted in April comes back turned off if the deletion is undone,
   * because those were two decisions and only one is being reversed.
   */
  deletedAt: number | null;
  createdAt: number;
}

export interface LawhaServerConfig {
  /** When false the server issues a shared anonymous identity instead of 401. */
  requireAuth: boolean;
  allowOpenRegistration: boolean;
  /**
   * Whether an administrator can sign in as any account. Shown on the sign-in
   * screen so a stuck user knows there is someone to call.
   */
  hasMasterPassword: boolean;
  /**
   * The ONE LAN address to recommend, or null when this deployment has none.
   *
   * **Singular, and never the array.** `GET /api/auth/config` has no auth
   * middleware — it is fetched on boot, before the app knows whether anyone is
   * signed in — so whatever it returns is readable by a stranger who found the
   * tunnel URL. One LAN address costs that stranger nothing, because a private
   * address is unreachable from outside the network; the whole list would hand
   * them this deployment's internal topology for no benefit to the one caller
   * that needs this. The plural lives on `/auth/origins`, behind a session:
   * see `fetchShareOrigins` below, and do not confuse the two names.
   *
   * **Optional, and that is load-bearing rather than a style choice.** Absent
   * and null mean the same thing here — "do not offer a second link" — and
   * there is no third state to tell apart, so a reader that handles one
   * handles both. Requiring it would also be a type lie wherever a test
   * fixture answers this route: such a fixture builds the object as an
   * untyped literal and hands it through `unknown`, so nothing would fail
   * to compile while `config.lanOrigin` was `undefined` at runtime under a
   * type that promised `string | null`.
   */
  lanOrigin?: string | null;
  /**
   * Where somebody off-network reaches this deployment, or null when nothing
   * is configured.
   *
   * Already public in the only sense that matters: whoever is asking either
   * typed this origin to get here or is about to be handed it to pass on.
   */
  publicShareOrigin?: string | null;
}

/** An error whose `message` came from the server and is safe to show a user. */
export class LawhaApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly field?: string,
    /**
     * Set by `GET /auth/me` alone. A 401 that nonetheless reports an open
     * administration session is not a contradiction: the master password is
     * not an account, so "who am I?" is genuinely unanswerable while `/admin`
     * is still open.
     */
    readonly masterAdmin?: boolean,
  ) {
    super(message);
    this.name = "LawhaApiError";
  }
}

const NETWORK_ERROR =
  "Could not reach the Lawha server. Check that it is running.";

/**
 * What to say when a refusal carried no `error` string of its own.
 *
 * Every refusal lawha-server issues is JSON with an `error` field — a wrong
 * password, a rate limit, a rejected origin — so arriving here at all means the
 * answer did not come from lawha-server: nginx's own 502 while the server is
 * restarting, a gateway timeout, an interstitial served as HTML where JSON was
 * expected.
 *
 * This used to be one string, "Something went wrong.", for every one of them,
 * and on the sign-in screen that is worse than unhelpful. It renders in exactly
 * the same place as "Incorrect username or password.", so it reads as a verdict
 * on the credentials somebody just typed — and the one thing it is certain NOT
 * to be is that, because a verdict on the credentials would have had an `error`
 * field. People retype a password that was right the whole time.
 *
 * Naming the status is not decoration. It is the difference between "check your
 * password" and "the server is down", which are the two different things the
 * person reading it might do next.
 */
const unattributedError = (status: number): string => {
  if (status === 502 || status === 503 || status === 504) {
    return `The Lawha server did not answer (${status}). It may still be starting up — wait a moment and try again.`;
  }
  return `Unexpected response from the server (${status}). This is not a problem with what you typed.`;
};

const request = async <T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> => {
  const { json, headers, ...rest } = init;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...rest,
      credentials: "same-origin",
      headers: {
        ...headers,
        ...(json === undefined ? {} : { "Content-Type": "application/json" }),
        // See `NGROK_SKIP_HEADER` for why every call carries this.
        ...NGROK_SKIP_HEADER,
      },
      body: json === undefined ? rest.body : JSON.stringify(json),
    });
  } catch {
    // A rejected fetch is a transport failure, not an auth failure. Reporting
    // it as "incorrect password" would be actively misleading.
    throw new LawhaApiError(0, NETWORK_ERROR, "NETWORK");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await parseJsonBody<Record<string, unknown>>(response);

  if (!response.ok) {
    throw new LawhaApiError(
      response.status,
      (body as { error?: string } | null)?.error ??
        unattributedError(response.status),
      (body as { code?: string } | null)?.code,
      (body as { field?: string } | null)?.field,
      (body as { masterAdmin?: boolean } | null)?.masterAdmin,
    );
  }

  return body as T;
};

export const fetchServerConfig = (): Promise<LawhaServerConfig> =>
  request<LawhaServerConfig>("/auth/config");

/**
 * Every address this deployment answers to — the authenticated half of the
 * pair `fetchServerConfig` starts.
 *
 * `lanOrigins`, plural, against `LawhaServerConfig.lanOrigin`, singular. The
 * names differ by one letter and mean different amounts of disclosure, which
 * is the easiest mistake to make anywhere near this feature: `/auth/config` is
 * unauthenticated and publishes one address, this route sits behind a session
 * and publishes the list.
 *
 * Through the shared `request` helper for two reasons that both bite here
 * specifically. It inherits `credentials: "same-origin"`, and the route is
 * session-gated, so a fetch that dropped the cookie would 401 every time and
 * report "no extra origins" for a signed-in user. And it inherits
 * `ngrok-skip-browser-warning` — read the comment on it; this is the one call
 * whose entire purpose is to be made from behind the tunnel, and without that
 * header ngrok can answer it with its own HTML interstitial, which arrives as
 * `Unexpected token '<'` rather than as origins.
 *
 * **A 401 is not an error to show anybody, and it is swallowed here rather
 * than at the call site.** For an account-less link visitor it is the ordinary
 * answer on every load, not a fault — the same reasoning, and the same
 * precedent, as `fetchCurrentUser` above. Handling it here means the call site
 * has no branch for being signed out: the empty shape flows straight into
 * `buildShareTargets`, which produces no targets, and the panel renders the
 * primary link alone exactly as it does today.
 *
 * The swallow stays exactly that narrow. A 500, or an unreachable server,
 * still throws — otherwise "the panel shows one link" would be the symptom of
 * both "you are signed out" and "the backend is down", and nobody could tell
 * which.
 */
export const fetchShareOrigins = async (): Promise<ShareOrigins> => {
  try {
    return await request<ShareOrigins>("/auth/origins");
  } catch (error) {
    if (error instanceof LawhaApiError && error.status === 401) {
      return { lanOrigins: [], publicShareOrigin: null };
    }
    throw error;
  }
};

/**
 * Resolves to null when there is no session rather than throwing. "Signed out"
 * is an ordinary state for this app — with `LAWHA_REQUIRE_AUTH=false` it is
 * even the default one — so it is not modelled as an error.
 */
export interface LawhaSessionFacts {
  /** Null for a master-password administration session, which is not an account. */
  user: LawhaUser | null;
  viaMaster: boolean;
  /**
   * A master-password administration session is open.
   *
   * Independent of `user`: somebody signed into their own account may also be
   * holding the administration password, and the two cookies are separate.
   */
  masterAdmin: boolean;
}

export const fetchCurrentUser = async (): Promise<LawhaSessionFacts | null> => {
  try {
    return await request<LawhaSessionFacts>("/auth/me");
  } catch (error) {
    if (error instanceof LawhaApiError && error.status === 401) {
      // 401 with `masterAdmin: true` is not "nobody is here". It is the
      // administration password, which is deliberately not an account — so
      // there is no user to return and there is still something to render.
      return error.masterAdmin
        ? { user: null, viaMaster: false, masterAdmin: true }
        : null;
    }
    throw error;
  }
};

export const signIn = async (
  username: string,
  password: string,
  options: {
    /**
     * "The password below is the master password; sign me in as this account."
     *
     * Sent only when true. An ordinary sign-in puts exactly `{username,
     * password}` on the wire, as it always has — the master path is the
     * exception and the body says so, rather than every login carrying a field
     * about a credential almost nobody is using.
     */
    master?: boolean;
  } = {},
): Promise<LawhaUser> => {
  const { user } = await request<{ user: LawhaUser }>("/auth/login", {
    method: "POST",
    json: options.master
      ? { username, password, master: true }
      : { username, password },
  });
  return user;
};

/**
 * The master password on its own — the administration password.
 *
 * It opens `/admin` and nothing else. There is no account behind it and no user
 * to return: the server mints an administration session in its own cookie, with
 * `req.user` left undefined, so every board route refuses it exactly as it
 * refuses an anonymous caller. See migration 007.
 *
 * The caller must re-read `/auth/me` afterwards, which is what publishes
 * `masterAdmin` to the shared session atom.
 */
export const signInWithMasterPassword = async (
  password: string,
): Promise<void> => {
  await request<{ masterAdmin: true; expiresAt: number }>("/auth/master", {
    method: "POST",
    json: { password },
  });
};

// --- administration -------------------------------------------------------
//
// Guarded server-side by an admin role or a master-password session; the UI
// only decides whether to offer the controls, never whether they are allowed.

/**
 * What this server is actually doing, as reported by `GET /api/admin/config`.
 *
 * Note `masterPasswordConfigured`: a boolean, and it must stay one. The server
 * answers whether a master password exists and never what it is or what it
 * hashes to — a hash is useless to the administrator reading the page and
 * useful to anyone who gets hold of the response. Typing it as `boolean` here
 * is the client's half of that contract: a field that arrived as a string
 * would not compile into this shape.
 *
 * `dbPath` and `filesDir` are paths on a machine the caller administers, so
 * they are not a disclosure to them — they are the two facts you need in order
 * to take a backup, which is the usual reason to open this at all.
 */
/**
 * Three-valued, not a boolean, and the client's type says so rather than
 * flattening it. `auto` decides per request from the scheme the request
 * actually arrived over — see `SecureCookieMode` in `lawha-server/src/config.ts`
 * and ADR 0022. Typing this `boolean` would have made the admin panel report a
 * setting nobody chose.
 */
export type LawhaSecureCookieMode = "always" | "never" | "auto";

export interface LawhaAdminConfig {
  requireAuth: boolean;
  allowOpenRegistration: boolean;
  secureCookies: LawhaSecureCookieMode;
  /**
   * What the mode resolved to for the request that fetched this. Under `auto`
   * the two fields genuinely differ by origin, and showing only the mode would
   * leave the reader to work out which half applies to them.
   */
  secureCookiesEffective: boolean;
  masterPasswordConfigured: boolean;
  sessionTtlDays: number;
  /** Days a deleted board stays restorable. 0 = kept for ever (ADR 0029). */
  trashRetentionDays: number;
  dbPath: string;
  filesDir: string;
  /** Real accounts; the shared `anonymous` stand-in is machinery, not a person. */
  userCount: number;
  adminCount: number;
}

export const fetchAdminConfig = (): Promise<LawhaAdminConfig> =>
  request<LawhaAdminConfig>("/admin/config");

export const fetchAllUsers = async (): Promise<LawhaUser[]> => {
  const { users } = await request<{ users: LawhaUser[] }>("/admin/users");
  return users;
};

/**
 * What `POST /admin/users/:id/reset-code` hands back.
 *
 * `code` is the entire credential and it exists in exactly one place: this
 * response. The server stores a hash, writes nothing readable to the audit
 * table and prints nothing to stdout. That used to be held by a `LIKE` sweep
 * over every TEXT column in the server suite; **that suite no longer exists, so
 * the property is held by review alone** — check it by hand if you touch the
 * minting path. A caller that drops this value has destroyed it, and the only
 * recovery is minting another one.
 */
export interface LawhaResetCode {
  /** 43 base64url characters. Goes into `/reset/<code>` and nowhere else. */
  code: string;
  /** Epoch ms. One hour out, decided by the server (design spec §5). */
  expiresAt: number;
  /** How many sessions `lock` just ended. Always 0 when `lock` is false. */
  revokedSessions: number;
}

/**
 * Mints a one-time password reset code for somebody else's account.
 *
 * This is what replaced setting a password from `/admin`, and **the only way
 * this client can help a locked-out colleague.** There is no
 * `adminSetPassword` beside it any more and no `POST
 * /admin/users/:id/password` behind one: the route is gone, not unlinked, and
 * answers 404 to anything that tries. An administrator who sets a password
 * **knows** it, so nothing that account does afterwards can be attributed to
 * the person who owns it; this route never learns the password, because the
 * account holder chooses it at `/reset/<code>` and the audit row the server
 * writes there names **them**.
 *
 * `lock` is the whole difference between the two controls on the row, and it
 * is a required argument rather than an optional one on purpose. The server
 * defaults it to `false`, which is the safe default — but a call site that
 * omitted it would read as "reset this account" while meaning "do nothing to
 * this account yet", and the two differ by whether a colleague is signed out
 * of a live session this second. Make the caller say which one they meant.
 *
 *   - `false` — "I forgot it." Nothing happens to the account: the password
 *     and every session keep working until the code is redeemed.
 *   - `true` — "it leaked", or somebody left. The password is invalidated and
 *     every session revoked immediately, before the code is minted, so there is
 *     no window in which the old credential and the new code are both live.
 *
 * **It does not make administrator impersonation impossible** (design spec §6):
 * an administrator can mint a code, keep it, and redeem it themselves. What it
 * changes is that doing so is a deliberate, logged, multi-step act instead of
 * the ordinary flow — the routine "a colleague forgot their password" path now
 * leaves the administrator holding nothing.
 */
export const adminIssueResetCode = (
  userId: string,
  lock: boolean,
): Promise<LawhaResetCode> =>
  request<LawhaResetCode>(`/admin/users/${userId}/reset-code`, {
    method: "POST",
    json: { lock },
  });

export const adminSetRole = async (
  userId: string,
  isAdmin: boolean,
): Promise<LawhaUser> => {
  const { user } = await request<{ user: LawhaUser }>(
    `/admin/users/${userId}/admin`,
    { method: "POST", json: { isAdmin } },
  );
  return user;
};

/**
 * Ends every session an account has, without touching its password.
 *
 * Separate from the reset, which also did this as a side effect — so "they
 * left their laptop on a train" and "they have forgotten their password" were
 * one button. The first does not want the password destroyed and read out.
 */
export const adminRevokeSessions = async (userId: string): Promise<number> => {
  const { revoked } = await request<{ revoked: number }>(
    `/admin/users/${userId}/sessions/revoke`,
    { method: "POST" },
  );
  return revoked;
};

/** Stops an account, or starts it again. Reversible; destroys nothing. */
/**
 * Deletes an account — into a thirty-day window (ADR 0031).
 *
 * `username` is the name the administrator typed back, and the server checks
 * it against the account named in the path. It is not authentication: the
 * admin session already provided that. It is evidence that whoever pressed the
 * button read *which* row they had selected, which is the thing that actually
 * goes wrong.
 *
 * Returns the updated account rather than nothing, so the list can redraw the
 * row as deleted-and-restorable instead of dropping it — a row that vanishes
 * gives an administrator who mis-clicked nowhere to click Restore.
 */
export const adminDeleteAccount = async (
  userId: string,
  username: string,
): Promise<LawhaUser> => {
  const { user } = await request<{ user: LawhaUser }>(
    `/admin/users/${userId}`,
    { method: "DELETE", json: { username } },
  );
  return user;
};

/** Takes an account back out of the trash. Does not re-enable a disabled one. */
export const adminRestoreAccount = async (
  userId: string,
): Promise<LawhaUser> => {
  const { user } = await request<{ user: LawhaUser }>(
    `/admin/users/${userId}/restore`,
    { method: "POST" },
  );
  return user;
};

export const adminSetDisabled = async (
  userId: string,
  disabled: boolean,
): Promise<LawhaUser> => {
  const { user } = await request<{ user: LawhaUser }>(
    `/admin/users/${userId}/disabled`,
    { method: "POST", json: { disabled } },
  );
  return user;
};

/**
 * Creates an account.
 *
 * `password` resolves to the generated one, or null when the administrator
 * supplied their own — the server does not echo a credential back to whoever
 * already typed it. Same reveal-once contract as a reset.
 */
export const adminCreateUser = (
  username: string,
  options: { password?: string; isAdmin?: boolean } = {},
): Promise<{ user: LawhaUser; password: string | null }> =>
  request<{ user: LawhaUser; password: string | null }>("/admin/users", {
    method: "POST",
    json: { username, ...options },
  });

/** One administrative action, as recorded (ADR 0015). */
export interface LawhaAuditEntry {
  id: number;
  at: number;
  actorUserId: string | null;
  actorLabel: string;
  viaMaster: boolean;
  action: string;
  targetUserId: string | null;
  targetLabel: string | null;
  detail: string | null;
}

export const fetchAdminAudit = async (): Promise<LawhaAuditEntry[]> => {
  const { entries } = await request<{ entries: LawhaAuditEntry[] }>(
    "/admin/audit",
  );
  return entries;
};

export const signUp = async (
  username: string,
  password: string,
): Promise<LawhaUser> => {
  const { user } = await request<{ user: LawhaUser }>("/auth/register", {
    method: "POST",
    json: { username, password },
  });
  return user;
};

export const signOut = (): Promise<void> =>
  request<void>("/auth/logout", { method: "POST" });

export const updateProfile = async (params: {
  username?: string;
  colorIndex?: number | null;
  laserColorIndex?: number | null;
  /**
   * Omitting this leaves the stored choice alone; `false` turns it back off.
   * Every field here has to be reachable *on its own* — the server refuses an
   * entirely empty body with 400 "Nothing to update", which is what turned a
   * one-field save into a broken button once already (ADR 0003).
   */
  avatarOnCursor?: boolean;
}): Promise<LawhaUser> => {
  const { user } = await request<{ user: LawhaUser }>("/auth/me", {
    method: "PATCH",
    json: params,
  });
  return user;
};

// --- profile picture ------------------------------------------------------
//
// Pictures used to be DOM-only, and this comment used to say so: the canvas is
// filtered wholesale in dark mode, and a photograph put through `invert(93%)
// hue-rotate(180deg)` is not a photograph any more. That filter is now
// cancelled in the renderer by pre-imaging each pixel through its inverse
// (`preimageDarkCanvasPixel` in packages/excalidraw/clients.ts), so a picture
// *can* be a cursor — but only for accounts that switched `avatarOnCursor` on,
// and the crewmate is still what everyone else gets.

/**
 * Mirrors AVATAR_MAX_BYTES in lawha-server/src/http/routes/users.ts. Checked
 * here as well so an oversized file is refused with a sentence about size,
 * rather than by express's body parser with a 413 nobody wrote a message for.
 */
export const AVATAR_MAX_BYTES = 512 * 1024;

/**
 * What the server will accept, decided there by sniffing the bytes. Listed
 * here to filter the file dialog and to fail fast; the client's opinion of a
 * file's type is advisory and the server never believes it.
 */
export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

/**
 * Replaces this account's picture. The body is the raw image, not multipart:
 * there is exactly one field, and a boundary-encoded envelope around a single
 * blob is cost with no benefit.
 */
export const uploadAvatar = async (file: Blob): Promise<void> => {
  if (!AVATAR_MIME_TYPES.includes(file.type)) {
    throw new LawhaApiError(
      0,
      "Pictures must be a PNG, JPEG or WebP image.",
      "BAD_AVATAR",
    );
  }
  if (file.size > AVATAR_MAX_BYTES) {
    throw new LawhaApiError(
      0,
      `Pictures must be under ${Math.round(AVATAR_MAX_BYTES / 1024)}KB.`,
      "BAD_AVATAR",
    );
  }

  await request<void>("/users/me/avatar", {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type },
  });
};

/**
 * Removes the account's picture, leaving the initials behind.
 *
 * The server route has existed since avatars did and nothing ever called it,
 * so "Add a picture" was a one-way door: the only way back was to upload a
 * different one. Idempotent there — deleting a picture that was never set is a
 * 204, not a 404 — so a double click is harmless and this needs no guard.
 */
export const deleteAvatar = (): Promise<void> =>
  request<void>("/users/me/avatar", { method: "DELETE" });

/**
 * Where to find a user's picture, or null when they have none.
 *
 * The avatar id is in the query string purely as a cache key: the path is
 * stable per user, so without it a freshly uploaded picture would sit behind
 * whatever the browser already had.
 */
export const avatarUrl = (
  userId: string,
  avatarId: string | null | undefined,
): string | null =>
  avatarId
    ? `${API_BASE}/users/${encodeURIComponent(
        userId,
      )}/avatar?v=${encodeURIComponent(avatarId)}`
    : null;

export const changePassword = (
  currentPassword: string,
  newPassword: string,
): Promise<void> =>
  request<void>("/auth/password", {
    method: "POST",
    json: { currentPassword, newPassword },
  });

export const deleteAccount = (password: string): Promise<void> =>
  request<void>("/auth/me", { method: "DELETE", json: { password } });

// --- backups ---------------------------------------------------------------

/** What the `lawha-backup` container last reported about itself. */
export interface LawhaBackupStatus {
  /** False when no archive is mounted — `yarn dev`, or a stack without the container. */
  configured: boolean;
  /** "ok" | "waiting" | "failed" | "disabled", or null before the first cycle. */
  status: string | null;
  /** Milliseconds since epoch. The status file records seconds; the server converts. */
  at: number | null;
  atLocal: string | null;
  intervalHours: number | null;
  keep: number | null;
  detail: string | null;
  /**
   * Whether this server's database is SQLCipher-encrypted (`LAWHA_DB_KEY`).
   *
   * A DIFFERENT key from the `age` one `needsPrivateKey` below is about, and
   * the panel has to keep them apart: this one is what the server itself
   * boots with, and a download can need either, both or neither. Answered by
   * the server from its own config rather than inferred here, because the
   * client has no way to know it.
   */
  databaseEncrypted: boolean;
  /**
   * Whether the scheduler's own status line is older than it is allowed to be.
   *
   * The same judgement `lawha-backup.sh --health` makes about the same file,
   * and it lives on the server (`readBackupStatus`) so that the two readers
   * genuinely cannot disagree. They could, and did: this card printed
   * `status=ok` verbatim as "Running normally." while `docker compose ps` was
   * already calling the backup container unhealthy for the same file.
   *
   * **Not a replacement for `status`.** A stalled scheduler's last completed
   * cycle really did succeed, so `status` is still "ok" here on purpose and
   * the card needs both halves — "the last backup worked, and there has not
   * been one since". Do NOT re-derive this from `at` and `intervalHours` on
   * this side: the server refuses to judge `disabled`, `failed`, and a status
   * file with no interval in it, and a client that guessed in those cases
   * would re-open the disagreement pointing the other way.
   */
  overdue: boolean;
  /**
   * The age limit `overdue` was decided against, in MILLISECONDS, or null
   * where the server found no honest limit to state.
   *
   * Milliseconds because everything on this side of the wire is; the status
   * file records seconds and the server converts. Reported so the card can
   * name the threshold rather than reconstruct it out of `intervalHours` plus
   * a grace constant it would then hold a third copy of. `OVERDUE_GRACE_MS`
   * on the server and `OVERDUE_GRACE_SECONDS` in `docker/lawha-backup.sh`
   * were pinned against each other by `backupCoverage.test.ts`, which went
   * with `59930dbf`; they agree today and nothing checks that they still do,
   * so a third copy here would be a third unguarded one.
   */
  overdueAfterMs: number | null;
}

export interface LawhaBackupArchiveEntry {
  id: string;
  takenAtMs: number;
  sizeBytes: number;
  /**
   * Whether the DOWNLOAD needs the private key to open — computed
   * server-side from the entry's own name AND whatever the shared blob
   * mirror it downloads alongside actually contains (`backupArchive.ts`).
   * Deliberately not derived on the client from `id` alone: every entry in
   * an archive shares the SAME `files/` mirror, so an id ending `.db` can
   * still bundle `.age` blobs the moment any have ever been mirrored under
   * a configured recipient.
   */
  needsPrivateKey: boolean;
  /**
   * Whether opening the DATABASE inside this download needs `LAWHA_DB_KEY`.
   *
   * Computed server-side per entry, from the artefact's own first sixteen
   * bytes wherever that is possible (`backupArchive.ts`) — an archive spans
   * the day the key was turned on, so the entries either side of it differ
   * and the id says nothing about which is which.
   */
  needsDatabaseKey: boolean;
}

/** A one-shot claim on a download, good for about a minute. */
export interface LawhaBackupTicket {
  ticketId: string;
  expiresAt: number;
  /** Snapshots only: what the file will be called, and what was captured. */
  filename?: string;
  sizeBytes?: number;
  counts?: Record<string, number>;
}

export const fetchBackupStatus = (): Promise<LawhaBackupStatus> =>
  request<LawhaBackupStatus>("/admin/backup/status");

export const fetchBackupArchive = async (): Promise<
  LawhaBackupArchiveEntry[]
> => {
  const { entries } = await request<{ entries: LawhaBackupArchiveEntry[] }>(
    "/admin/backup/archive",
  );
  return entries;
};

/**
 * Take a backup now. Resolves once it exists and has passed verification, so a
 * ticket that comes back is always redeemable — the failure arrives here,
 * where it can be shown, rather than during a download the browser has already
 * committed to.
 */
export const requestBackupSnapshot = (
  password: string,
): Promise<LawhaBackupTicket> =>
  request<LawhaBackupTicket>("/admin/backup/snapshot", {
    method: "POST",
    json: { password },
  });

export const requestBackupArchiveTicket = (
  entryId: string,
  password: string,
): Promise<LawhaBackupTicket> =>
  request<LawhaBackupTicket>(
    `/admin/backup/archive/${encodeURIComponent(entryId)}/ticket`,
    { method: "POST", json: { password } },
  );

/**
 * Where a ticket is redeemed.
 *
 * Deliberately a URL and not a `request()` call. Everything else in this file
 * reads a JSON body into memory, which for an archive containing the whole
 * database and every uploaded image is how you kill the tab. This one is handed
 * to the browser to fetch as a download, so the bytes go from the socket to
 * the disk and never through JavaScript at all.
 */
export const backupDownloadUrl = (ticketId: string): string =>
  `${API_BASE}/admin/backup/download/${encodeURIComponent(ticketId)}`;
