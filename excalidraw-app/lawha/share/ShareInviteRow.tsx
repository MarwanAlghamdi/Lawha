import { useEffect, useState } from "react";

import { searchMemberCandidates } from "../../data/boards";
import { getInitials } from "../hooks/useLawhaPresence";

import type { BoardRole, UserCandidate } from "../../data/boards";

interface ShareInviteRowProps {
  boardId: string;
  busy: boolean;
  /** Bumped by the panel after any membership change, to re-run the search. */
  revision: number;
  onAdd: (userId: string, role: BoardRole) => Promise<void>;
}

/**
 * How long to wait after the last keystroke before asking the server.
 *
 * This used to fire on every character: typing "a.smith" was seven round trips,
 * five of them for a prefix nobody wanted the answer to, and the last one
 * racing the other five. 220ms is under the threshold where a search feels
 * delayed and above the interval between keystrokes.
 */
const SEARCH_DEBOUNCE_MS = 220;

/**
 * Adding someone by name, at the top of the panel.
 *
 * First rather than last, because it is the reason the panel gets opened. It
 * used to sit fifth, below the roster it modifies, so adding a person meant
 * scrolling past the list of people already added to reach the field that adds
 * one — and then scrolling back to see the result.
 *
 * Owner-only. The server refuses a non-owner's membership change outright, and
 * invariant 24 says the client must know what the server will refuse: offering
 * a control that always fails is worse than not offering it.
 */
export const ShareInviteRow = ({
  boardId,
  busy,
  revision,
  onAdd,
}: ShareInviteRowProps) => {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<BoardRole>("editor");
  const [candidates, setCandidates] = useState<UserCandidate[]>([]);

  useEffect(() => {
    let cancelled = false;

    // The debounce and the cancel do different jobs and both are needed: the
    // timer stops most requests being made, and the flag stops a slow early
    // one overwriting the results of a fast later one when they are.
    const timer = setTimeout(() => {
      void searchMemberCandidates(boardId, query)
        .then((users) => {
          if (!cancelled) {
            setCandidates(users);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCandidates([]);
          }
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [boardId, query, revision]);

  return (
    <section className="lw-share__section">
      <div className="lw-share__add">
        <label className="lw-field lw-share__add-find">
          <span className="lw-field__label">Add people</span>
          <input
            className="lw-field__input lw-share__search"
            value={query}
            placeholder="Type a name"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <label className="lw-field lw-share__add-role">
          <span className="lw-field__label">They join as</span>
          <select
            className="lw-select lw-share__role"
            value={role}
            onChange={(event) => setRole(event.target.value as BoardRole)}
          >
            <option value="viewer">Can view</option>
            <option value="editor">Can edit</option>
            <option value="owner">Owner</option>
          </select>
        </label>
      </div>

      {candidates.length > 0 ? (
        <ul className="lw-share__candidates">
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              {/*
               * The avatar is hidden from the accessible tree so the button is
               * still named by the person, not by "ZA zaid".
               */}
              <button
                type="button"
                className="lw-share__candidate"
                disabled={busy}
                onClick={async () => {
                  await onAdd(candidate.id, role);
                  setQuery("");
                }}
              >
                <span
                  className="lw-avatar lw-avatar--sm lw-share__member-avatar"
                  aria-hidden="true"
                >
                  {getInitials(candidate.username)}
                </span>
                {candidate.username}
              </button>
            </li>
          ))}
        </ul>
      ) : query ? (
        <p className="lw-share__blurb lw-share__blurb--muted">
          No account here matches “{query}”.
        </p>
      ) : (
        <p className="lw-mono lw-share__note">
          named people keep their access whatever the link is set to
        </p>
      )}
    </section>
  );
};
