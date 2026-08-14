import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  looksLikeInviteCode,
  previewInvite,
  redeemInvite,
  tidyInviteCode,
} from "../../data/invites";

import "./JoinRoute.scss";

import type { InvitePreview } from "../../data/invites";

/**
 * Spending an invite code. See ADR 0014.
 *
 * Two ways in and one page. `/join/<code>` arrives with the code already in
 * hand — somebody clicked a copied link — and `/join` arrives from a person
 * who was told three words and is typing them.
 *
 * **It previews before it redeems.** Landing on a link and being silently
 * added to a stranger's board is the behaviour every link-based invite has and
 * the one worth not copying: you are shown the board's name and what the code
 * grants, and you press the button. That is also what makes the page
 * refreshable — the preview is a GET and redemption is the deliberate act.
 *
 * `RequireSession` wraps this route, so anybody who is not signed in is sent
 * to sign in first and returned here. That is not a hurdle to route around: a
 * code grants *membership*, and membership needs an account to belong to.
 */
export const JoinRoute = () => {
  const params = useParams<{ code?: string }>();
  const navigate = useNavigate();

  const [typed, setTyped] = useState(params.code ?? "");
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [joining, setJoining] = useState(false);

  const code = tidyInviteCode(typed);

  /**
   * The most recently started `check`, bumped on every call.
   *
   * Guards against a stale answer overwriting a newer one. Browser
   * back/forward between two `/join/<code>` links changes `params.code`
   * before the first `previewInvite` has settled, so the effect below can
   * start a second request while the first is still in flight — and network
   * order does not follow call order. Without this, whichever settles last
   * wins even when it is the older one, and the page can end up showing one
   * board's name while `preview.code` — what "Join this board" would actually
   * spend — is a different code than the one in the address bar.
   */
  const requestId = useRef(0);

  const check = useCallback(async (candidate: string) => {
    const id = ++requestId.current;
    setChecking(true);
    setError(null);
    setPreview(null);
    try {
      const result = await previewInvite(candidate);
      if (requestId.current === id) {
        setPreview(result);
      }
    } catch (caught: any) {
      if (requestId.current === id) {
        setError(caught?.message ?? "That code did not work.");
      }
    } finally {
      if (requestId.current === id) {
        setChecking(false);
      }
    }
  }, []);

  /**
   * The code this mount has already asked about on arrival.
   *
   * `index.tsx` wraps the app in `<StrictMode>`, and React 19 runs mount,
   * cleanup, mount again in development — a plain effect below would fire
   * `check` twice for the same arriving code, spending two attempts of the
   * redemption rate limit before the page had even finished loading. Same
   * guard as `reset/ResetRoute.tsx`'s `asked` ref, for the same reason; see
   * its longer comment for why there is deliberately no "ignore a stale
   * effect" flag alongside it.
   */
  const asked = useRef<string | null>(null);

  // A code in the address is checked once, on arrival. Not on every keystroke
  // afterwards: each attempt spends the redemption rate limit, which is tight
  // on purpose, and a person mid-way through typing three words would burn it
  // before finishing the first.
  useEffect(() => {
    const fromUrl = tidyInviteCode(params.code ?? "");
    if (!fromUrl || !looksLikeInviteCode(fromUrl)) {
      return;
    }
    if (asked.current === fromUrl) {
      return;
    }
    asked.current = fromUrl;
    void check(fromUrl);
  }, [params.code, check]);

  const join = async () => {
    if (!preview) {
      return;
    }
    setJoining(true);
    setError(null);
    try {
      const result = await redeemInvite(preview.code);
      navigate(`/b/${result.boardId}`, { replace: true });
    } catch (caught: any) {
      setError(caught?.message ?? "Could not join that board.");
      setJoining(false);
    }
  };

  return (
    <main className="lw-join">
      <div className="lw-join__card">
        <h1 className="lw-join__title">Join a board</h1>

        {preview ? (
          <>
            <p className="lw-join__blurb">
              You have been invited to{" "}
              <strong>{preview.boardName ?? "a board"}</strong>, and you will be
              able to{" "}
              <strong>
                {preview.role === "editor" ? "draw on it" : "watch it"}
              </strong>
              .
            </p>
            <p className="lw-mono lw-join__note">
              it will stay on your dashboard until somebody removes you
            </p>
            <div className="lw-join__actions">
              <button
                type="button"
                className="lw-btn lw-btn--primary"
                disabled={joining}
                onClick={() => void join()}
              >
                {joining ? "Joining…" : "Join this board"}
              </button>
              <button
                type="button"
                className="lw-btn"
                disabled={joining}
                onClick={() => navigate("/")}
              >
                Not now
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="lw-join__blurb">
              Type the three words you were given.
            </p>
            <form
              className="lw-join__form"
              onSubmit={(event) => {
                event.preventDefault();
                if (looksLikeInviteCode(code)) {
                  void check(code);
                }
              }}
            >
              <label className="lw-field">
                <span className="lw-field__label">Invite code</span>
                <input
                  className="lw-field__input lw-join__input"
                  value={typed}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="brave otter lantern"
                  onChange={(event) => {
                    setTyped(event.target.value);
                    setError(null);
                  }}
                />
              </label>
              <button
                type="submit"
                className="lw-btn lw-btn--primary"
                // Gated on the shape rather than on the words, because the
                // client has no copy of the word list and should not grow one.
                // The server is what decides whether a code is real.
                disabled={checking || !looksLikeInviteCode(code)}
              >
                {checking ? "Checking…" : "Continue"}
              </button>
            </form>
          </>
        )}

        {error ? (
          <p className="lw-join__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
};
