import {
  COLLABORATOR_PALETTE,
  getCollaboratorPaletteIndex,
} from "@excalidraw/common";
import * as Popover from "@radix-ui/react-popover";

import { useState } from "react";

import { avatarUrl } from "../auth/authApi";
import { useLawhaSession } from "../auth/useLawhaSession";
import { useLawhaContainer } from "../hooks/useLawhaContainer";

export interface LawhaAccount {
  username: string;
  colorIndex: number | null;
}

interface LawhaAccountButtonProps {
  account: LawhaAccount | null;
  onSignOut?: () => void;
  onOpenAccount?: () => void;
  /** Given when the server allows accounts and this browser has none. */
  onSignIn?: () => void;
  compact?: boolean;
}

const initialsOf = (username: string) =>
  [...username.trim()].slice(0, 2).join("").toUpperCase() || "?";

/**
 * Account entry point.
 *
 * The canvas mockup has no account control — it is reachable only from the home
 * dashboard. With strict consolidation there is no external chrome to put it
 * in, so the home page's avatar pill is lifted here verbatim.
 *
 * The menu portals into the editor container rather than document.body, so it
 * stays inside the canvas UI as the consolidation constraint requires.
 */
export const LawhaAccountButton = ({
  account,
  onSignOut,
  onOpenAccount,
  onSignIn,
  compact,
}: LawhaAccountButtonProps) => {
  const [open, setOpen] = useState(false);
  const { ref, container } = useLawhaContainer<HTMLDivElement>();
  // Read from the session rather than taken as a prop. The alternative was a
  // new prop threaded through App.tsx, which another work package owns; this
  // component already sits under the same jotai store, so the identity is
  // right here for the asking.
  const { user } = useLawhaSession();

  if (!account) {
    // Signed out. Offering the way in matters more here than on a page with a
    // header, because the canvas is the whole interface — without this there
    // is no route to an account at all.
    return onSignIn ? (
      <button type="button" className="lw-btn" onClick={onSignIn}>
        Sign in
      </button>
    ) : null;
  }

  const initials = initialsOf(account.username);
  const picture = user ? avatarUrl(user.id, user.avatarId) : null;

  // The chip used to be hardcoded to `--lw-presence-0` in CSS while this
  // component took a colorIndex it never read — so everyone's chip was blue
  // no matter what colour their cursor was. Resolved here, from the same
  // palette and the same fallback hash the canvas uses.
  const paletteIndex =
    account.colorIndex ?? (user ? getCollaboratorPaletteIndex(user.id) : null);
  const swatch =
    paletteIndex === null ? undefined : COLLABORATOR_PALETTE[paletteIndex];

  return (
    <div ref={ref} className="lw-account">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="lw-account__trigger"
            aria-label={`Account: ${account.username}`}
          >
            <span
              className="lw-account__avatar"
              // `hex`, not `hexDark`: this is DOM, and only the interactive
              // canvas is colour-filtered in dark mode.
              style={swatch ? { background: swatch.hex } : undefined}
            >
              {picture ? (
                <img
                  className="lw-avatar__img"
                  src={picture}
                  alt=""
                  draggable={false}
                />
              ) : (
                initials
              )}
            </span>
            {compact ? null : (
              <span className="lw-account__labels">
                <span className="lw-account__name">{account.username}</span>
              </span>
            )}
          </button>
        </Popover.Trigger>

        <Popover.Portal container={container ?? undefined}>
          <Popover.Content
            className="lw-menu"
            side="bottom"
            align="end"
            sideOffset={10}
            collisionPadding={14}
          >
            <button
              type="button"
              className="lw-menu__item"
              onClick={() => {
                setOpen(false);
                onOpenAccount?.();
              }}
            >
              Account settings
            </button>
            <button
              type="button"
              className="lw-menu__item lw-menu__item--danger"
              onClick={() => {
                setOpen(false);
                onSignOut?.();
              }}
            >
              Sign out
            </button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
};
