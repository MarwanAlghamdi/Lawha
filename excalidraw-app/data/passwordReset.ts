import { API_BASE, NGROK_SKIP_HEADER, parseJsonBody } from "./api";

import type { LawhaUser } from "../lawha/auth/authApi";

/**
 * Redeeming a one-time password reset code. See
 * docs/adr/0021-admin-password-reset-codes.md
 * and `lawha-server/src/http/routes/passwordReset.ts` for the other end.
 *
 * The client half of the only route in the product that mints a session for a
 * caller it has never seen. Both calls are **unauthenticated by necessity** —
 * somebody locked out cannot sign in first, which is the whole premise — so
 * `credentials: "same-origin"` below is not what carries them; the code in the
 * path is the entire credential.
 *
 * These throw, exactly like `data/invites.ts` and for the same reason: every
 * call is a deliberate act by a person who is watching, and a swallowed
 * failure would leave somebody staring at a form that quietly did nothing to
 * the account they are locked out of.
 *
 * Shaped like `data/invites.ts` rather than like `lawha/auth/authApi.ts`,
 * because this is a code being spent rather than an account signing in, and
 * `authApi`'s helper swallows a 401 — ordinary for a link visitor, never a
 * possible answer here.
 *
 * This comment used to give a second reason: that `authApi` carries
 * `ngrok-skip-browser-warning` and this route did not need it. That was wrong,
 * and it was wrong in the direction that hurts — not going through the shared
 * helper is exactly why the header had to be added here by hand, and until it
 * was, a `/reset/<code>` link opened through the tunnel by somebody with no
 * interstitial cookie got ngrok's HTML page instead of an answer. The header
 * now comes from `data/api.ts`, which is the only place it is spelt.
 */

/**
 * What a code is for, before deciding whether to spend it.
 *
 * `username` is the field this exists for. The server hands it over
 * deliberately (`routes/passwordReset.ts`), because a person given the wrong
 * code must not set the wrong account's password without ever seeing that they
 * did. There is no email on it — there is none anywhere in this product
 * (invariant 9).
 */
export interface ResetPreview {
  /** Echoed back by the server; the page keeps using it for the POST. */
  code: string;
  username: string;
  /** Whether minting this code also locked the account out immediately. */
  locked: boolean;
  expiresAt: number;
}

/**
 * The refusal, with the server's code attached.
 *
 * The same shape as `InviteError` (`data/invites.ts`) and for the same reason:
 * the page has to say different things for expired, revoked and already-used,
 * and a bare `Error` would force it to match on prose. `code` is what those
 * branches key on — `NO_SUCH_CODE`, `EXPIRED`, `REVOKED`, `REDEEMED`,
 * `ACCOUNT_DISABLED`, all spelt by `routes/passwordReset.ts`.
 */
export class ResetError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = "ResetError";
  }
}

/**
 * The code for "this never reached the server, or what answered was not it".
 *
 * Minted on this side; the server's vocabulary is the five refusals
 * `routes/passwordReset.ts` spells plus `RATE_LIMITED` and `INTERNAL` from
 * `middleware/errors.ts`, and none of them is this word.
 *
 * It exists because of a real defect: every transport failure used to arrive
 * with `code: null`, which is the page's *"check you copied the whole link"*
 * branch — so somebody holding a perfectly valid code was told their link had
 * been cut short, sent to ask for a replacement that could not help, and given
 * no way to try again. The code is the one thing that is definitely fine in
 * every one of these cases.
 *
 * And this is the deployment's own failure shape rather than a hypothetical:
 * `docker/nginx.conf` serves the SPA statically and proxies only `/api/`, so a
 * stopped `lawha-server` leaves this page rendering perfectly while `/api`
 * answers nginx's HTML 502 — a body `response.json()` cannot parse.
 */
export const RESET_UNREACHABLE = "UNREACHABLE";

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: "same-origin",
      ...init,
      // After the spread, so a caller's own headers cannot drop it. This file
      // does not go through `authApi`'s helper — the route is deliberately
      // unauthenticated — so it does not inherit the header either, and a
      // `/reset/<code>` link is opened by somebody who has never seen this
      // deployment and therefore has no interstitial cookie by construction.
      headers: { ...NGROK_SKIP_HEADER, ...init?.headers },
    });
  } catch {
    // DNS, a refused connection, a dropped link, a suspended laptop. `fetch`
    // rejects with a bare `TypeError` that carries no `code` at all, so
    // without this it reaches the page as an unrecognised refusal of the code.
    throw new ResetError(
      "Could not reach the server, so nothing has been checked yet. Your code is untouched.",
      RESET_UNREACHABLE,
    );
  }

  if (!response.ok) {
    const body = await parseJsonBody<{ error?: string; code?: string }>(
      response,
    );

    if (!body) {
      // Not this server's JSON, so nothing here is a statement about the code.
      // The status is kept in the sentence because "502" is the thing somebody
      // repeats to whoever runs the machine.
      throw new ResetError(
        `The server did not answer properly (${response.status}), so nothing has been checked yet. Your code is untouched.`,
        RESET_UNREACHABLE,
      );
    }

    throw new ResetError(
      body.error ?? "Something went wrong.",
      body.code ?? null,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  try {
    return (await response.json()) as T;
  } catch {
    // A 200 that is not JSON is the SPA's own index.html, answered by nginx to
    // a path it did not proxy. Left alone this rejects with a `SyntaxError` —
    // no `code`, same wrong branch.
    throw new ResetError(
      "The server's answer could not be read, so nothing has been checked yet. Your code is untouched.",
      RESET_UNREACHABLE,
    );
  }
};

/**
 * Whose password this code sets, and whether it can still set it.
 *
 * A GET, and idempotent, which is what makes the page refreshable. It is also
 * why the page must call it **once per mount**: the server puts this and the
 * POST under one limiter of 10 per quarter hour keyed on the client address,
 * so a preview per render would spend the recovery path while somebody typed
 * into it.
 */
export const previewReset = (code: string): Promise<ResetPreview> =>
  json<ResetPreview>(`/auth/reset/${encodeURIComponent(code)}`);

/**
 * Spending the code: the account holder sets their own password.
 *
 * On success the server has already written the password, stamped the code as
 * redeemed, revoked every other session for that account, and set a fresh
 * session cookie on this response — so the returned user is signed in by the
 * time this resolves. The caller still has to tell the app's cached session
 * about it (`useLawhaSession().setUser`), because a cookie the app never reads
 * cannot move an atom.
 */
export const redeemReset = (
  code: string,
  newPassword: string,
): Promise<{ user: LawhaUser }> =>
  json<{ user: LawhaUser }>(`/auth/reset/${encodeURIComponent(code)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newPassword }),
  });
