import { useEffect, useRef } from "react";

import { COLLABORATOR_PALETTE } from "@excalidraw/common";

import type { Theme } from "@excalidraw/element/types";

import { LawhaLogo } from "../chrome/LawhaLogo";
import { LawhaThemeToggle } from "../chrome/LawhaThemeToggle";

import { avatarUrl } from "../auth/authApi";

import type { LawhaUser } from "../auth/authApi";

interface LawhaHomeBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** People on boards right now, summed across the list. */
  live: number;
  user: LawhaUser | null;
  editorTheme: Theme;
  onThemeChange: (theme: Theme) => void;
  onOpenAccount: () => void;
  onSignOut: () => void;
  onNewBoard: () => void;
  onImport: () => void;
  /**
   * Opens tag management, with no board in mind.
   *
   * Tags were reachable only from a card's chip row and the filter chips — so
   * renaming or recolouring one meant finding a board that happened to carry
   * it first, and a tag on no boards at all was unreachable entirely.
   */
  onManageTags: () => void;
  /**
   * "import" or "export" while one is running.
   *
   * Import locks for an export too, even though the export button no longer
   * lives on this bar: the two write to the same board list, and creating
   * boards behind a reload that is about to replace the grid is how a bulk
   * transfer loses track of what it did.
   */
  transferring: "import" | "export" | null;
}

/** Up to two letters, the way the mockup's avatar reads. */
const initialsOf = (username: string) =>
  username
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || username.slice(0, 2).toUpperCase();

/**
 * The dashboard's one bar: brand, search, presence, tools, account, new board.
 *
 * A single island rather than a page header plus a toolbar. The first build
 * split them, and on anything narrower than a desktop the controls wrapped into
 * three ragged rows — which is what the mockup's single wrapping flex row
 * exists to prevent.
 */
export const LawhaHomeBar = ({
  query,
  onQueryChange,
  live,
  user,
  editorTheme,
  onThemeChange,
  onOpenAccount,
  onSignOut,
  onNewBoard,
  onImport,
  onManageTags,
  transferring,
}: LawhaHomeBarProps) => {
  const searchRef = useRef<HTMLInputElement>(null);

  // The `/` hint in the field has to mean something, or it is decoration.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;

      if (event.key === "/" && !isTyping && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const colour =
    COLLABORATOR_PALETTE[(user?.colorIndex ?? 0) % COLLABORATOR_PALETTE.length]
      ?.hex;

  // The same profile picture the canvas chrome and the account page show. This
  // pill was the one avatar surface left on initials, because the package that
  // built avatars did not own this file.
  const picture = user ? avatarUrl(user.id, user.avatarId) : null;

  return (
    <div className="lw-home__bar">
      <LawhaLogo />

      <div className="lw-home__bar-spacer" />

      <div className="lw-home__search">
        <input
          ref={searchRef}
          className="lw-home__search-input"
          type="search"
          placeholder="Search boards and tags"
          aria-label="Search boards and tags"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <span className="lw-home__search-key" aria-hidden="true">
          /
        </span>
      </div>

      {live > 0 ? (
        <span className="lw-home__live" aria-live="polite">
          <span className="lw-dot lw-dot--pulse" aria-hidden="true" />
          {live} on boards
        </span>
      ) : null}

      {/*
        Import, and only import.

        There used to be an "Export all" next to it, and it was the wrong shape
        for the question: exporting is something you do to *particular* boards,
        so the control belongs where the boards are chosen — the selection bar
        in the grid. Import has no selection to derive from (the boards do not
        exist yet), which is exactly why it stays here.

        The outcome — including every board that could *not* be transferred — is
        reported by the route, in the page. Never a native dialog: one blocks
        the renderer, and the answer here is a list, not a yes/no.
      */}
      <div className="lw-home__transfer">
        <button
          type="button"
          className="lw-btn"
          onClick={onImport}
          disabled={transferring !== null}
          title="Add boards from .excalidraw files or a Lawha bundle"
        >
          {transferring === "import" ? "Importing…" : "Import files"}
        </button>
        <button
          type="button"
          className="lw-btn"
          onClick={onManageTags}
          title="Rename, recolour or delete your tags"
        >
          Tags
        </button>
      </div>

      <LawhaThemeToggle editorTheme={editorTheme} onChange={onThemeChange} />

      {user ? (
        <button
          type="button"
          className="lw-home__account"
          onClick={onOpenAccount}
          aria-label={`Account settings for ${user.username}`}
        >
          <span
            className="lw-home__avatar"
            // `hex`, not `hexDark`: this is DOM, and only the interactive
            // canvas is colour-filtered in dark mode.
            style={colour ? { background: colour } : undefined}
            aria-hidden="true"
          >
            {picture ? (
              <img
                className="lw-avatar__img"
                src={picture}
                alt=""
                draggable={false}
              />
            ) : (
              initialsOf(user.username)
            )}
          </span>
          <span className="lw-home__account-text">
            <span className="lw-home__account-name">{user.username}</span>
            <span className="lw-home__account-role">
              {user.isAdmin ? "admin" : "member"}
            </span>
          </span>
        </button>
      ) : null}

      <button type="button" className="lw-home__signout" onClick={onSignOut}>
        Sign out
      </button>

      <button
        type="button"
        className="lw-btn lw-btn--primary lw-home__new"
        onClick={onNewBoard}
      >
        <span aria-hidden="true">+</span> New board
      </button>
    </div>
  );
};
