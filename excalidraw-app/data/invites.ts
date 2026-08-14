import { API_BASE, NGROK_SKIP_HEADER, parseJsonBody } from "./api";

/**
 * Invite codes — three words that add somebody to a board. See ADR 0014.
 *
 * These throw, unlike the best-effort board helpers: every call here is a
 * deliberate act by a person who is watching, and swallowing a failure would
 * leave an owner reading out a code that was never minted, or a guest looking
 * at a join page that quietly did nothing.
 */

export type InviteRole = "viewer" | "editor";

export type InviteStatus = "live" | "revoked" | "expired" | "exhausted";

export interface InviteRedemption {
  userId: string;
  username: string;
  redeemedAt: number;
}

export interface BoardInvite {
  code: string;
  role: InviteRole;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  status: InviteStatus;
  redeemedBy: InviteRedemption[];
}

export interface InvitePreview {
  code: string;
  boardId: string;
  boardName: string | null;
  role: InviteRole;
  expiresAt: number | null;
}

export interface RedeemResult {
  boardId: string;
  role: string;
  /** False when the code was already spent by this account — not a failure. */
  joined: boolean;
}

/**
 * The refusal, with the server's code attached.
 *
 * The join page has to say different things for "expired", "revoked" and "we
 * have never heard of that code", and a bare `Error` would force it to match
 * on prose. `code` is what those branches key on.
 */
export class InviteError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = "InviteError";
  }
}

/**
 * The code for "this never reached the server, or nothing there answered".
 *
 * Minted on this side, same idea as `RESET_UNREACHABLE` in
 * `data/passwordReset.ts` and for the same reason: the server's own
 * vocabulary for a refused invite is `NO_SUCH_CODE`, `REVOKED`, `EXPIRED` and
 * `EXHAUSTED` (`lawha-server/src/http/routes/invites.ts`), plus
 * `RATE_LIMITED` and `INTERNAL` from the shared error middleware — none of
 * them is this word, and none of them is a statement to make when the server
 * was never reached at all. `/join/<code>` is opened by somebody who has
 * never seen this deployment and has nobody to ask what "Failed to fetch"
 * means, which is the raw exception a rejected `fetch` throws if nothing
 * catches it here.
 */
export const INVITE_UNREACHABLE = "UNREACHABLE";

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: "same-origin",
      ...init,
      // After the spread, so a caller passing its own headers cannot drop this
      // one. `/join/<code>` is opened by somebody who has never seen this
      // deployment, so through the tunnel they are exactly the visitor with no
      // interstitial cookie — see the header's own comment.
      headers: { ...NGROK_SKIP_HEADER, ...init?.headers },
    });
  } catch {
    // DNS, a refused connection, a dropped link, a suspended laptop. Nothing
    // has been sent to the server about this code — but left uncaught this is
    // a bare `TypeError` ("Failed to fetch") that names neither the code nor
    // the problem, on the one screen whose visitor has nobody to ask what it
    // means. `data/passwordReset.ts` carries the identical guard, for the
    // identical reason — read its long comment if this one is not enough.
    throw new InviteError(
      "Could not reach the server, so nothing has been checked yet. Your code is untouched.",
      INVITE_UNREACHABLE,
    );
  }

  if (!response.ok) {
    const body = await parseJsonBody<{ error?: string; code?: string }>(
      response,
    );
    throw new InviteError(
      body?.error ?? "Something went wrong.",
      body?.code ?? null,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  // A 200 whose body is not JSON is ngrok's interstitial or nginx's error
  // page, not an invite. Letting `response.json()` throw here reported it as
  // `Unexpected token '<'` — a parse error with no status in it, on the one
  // screen whose visitor cannot ask anybody what went wrong.
  const body = await parseJsonBody<T>(response);
  if (body === null) {
    throw new InviteError(
      "The server sent something this page could not read. Reload, and if it keeps happening the deployment is behind something that is answering for it.",
      "NOT_JSON",
    );
  }
  return body;
};

const postJson = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

export const listBoardInvites = async (
  boardId: string,
): Promise<BoardInvite[]> =>
  (await json<{ invites: BoardInvite[] }>(`/boards/${boardId}/invites`))
    .invites;

export const createBoardInvite = async (
  boardId: string,
  options: {
    role: InviteRole;
    /** null means it never expires; the UI never sends that. */
    expiresInHours: number | null;
    maxUses: number | null;
  },
): Promise<{ invites: BoardInvite[]; code: string }> =>
  json<{ invites: BoardInvite[]; code: string }>(
    `/boards/${boardId}/invites`,
    postJson(options),
  );

export const revokeBoardInvite = async (
  boardId: string,
  code: string,
): Promise<BoardInvite[]> =>
  (
    await json<{ invites: BoardInvite[] }>(
      `/boards/${boardId}/invites/${encodeURIComponent(code)}`,
      { method: "DELETE" },
    )
  ).invites;

/** What a code is for, before deciding whether to accept it. */
export const previewInvite = (code: string): Promise<InvitePreview> =>
  json<InvitePreview>(`/invites/${encodeURIComponent(code)}`);

export const redeemInvite = (code: string): Promise<RedeemResult> =>
  json<RedeemResult>(`/invites/${encodeURIComponent(code)}/redeem`, postJson());

/**
 * The shape a code takes in a URL and in the database.
 *
 * The server normalises too, and that is the one that counts — this exists so
 * the join page can put a tidy code in the address bar rather than whatever
 * was pasted, and so an obviously malformed entry is caught before a round
 * trip. It deliberately does **not** validate against the word list: the
 * client has no copy of it, and shipping one would be a second thing to keep
 * in step for no gain.
 */
export const tidyInviteCode = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .join("-");

/** Three words, which is the only shape a code ever has. */
export const looksLikeInviteCode = (input: string): boolean =>
  /^[a-z]+-[a-z]+-[a-z]+$/.test(tidyInviteCode(input));
