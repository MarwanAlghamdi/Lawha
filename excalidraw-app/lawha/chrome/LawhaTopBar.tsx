import { useState } from "react";

import { LawhaAIMenu } from "../ai/LawhaAIMenu";
import { usePublishedHeight } from "../hooks/useLawhaContainer";
import { useLawhaFormFactor } from "../hooks/useLawhaFormFactor";
import { LawhaSharePopover } from "../share/LawhaSharePopover";

import { LawhaAccountButton } from "./LawhaAccountButton";
import { LawhaBoardTitle } from "./LawhaBoardTitle";
import { LawhaLaserColor } from "./LawhaLaserColor";
import { useLawhaSheet } from "./LawhaPanel";
import { LawhaPresenceStack } from "./LawhaPresenceStack";
import { LawhaSaveStatus } from "./LawhaSaveStatus";

import "./LawhaTopBar.scss";

import type { LawhaAccount } from "./LawhaAccountButton";
import type { LawhaSaveState } from "./LawhaSaveStatus";

export interface LawhaTopBarProps {
  saveState: LawhaSaveState;
  savedAt: number | null;
  shareLink: string | null;
  isCollaborating: boolean;
  onStartSession: () => void;
  onStopSession: () => void;
  onBack?: () => void;
  account?: LawhaAccount | null;
  onSignOut?: () => void;
  onOpenAccount?: () => void;
  onSignIn?: () => void;
  boardTag?: string | null;
}

/**
 * The consolidated Lawha app bar.
 *
 * Rendered as a child of `<Excalidraw>`, which mounts it inside `LayerUI` on
 * every form factor, and positioned absolutely over a full-bleed canvas — the
 * mockup's separate header outside an inset canvas card is replaced by a
 * floating island, per the strict-consolidation requirement.
 *
 * Two mechanics make that work:
 *
 *  - `data-viewport-ui="top"` opts into `getViewportOffsets`, so zoom-to-fit
 *    and scroll-to-content never place content underneath the bar.
 *  - the bar publishes its measured height as `--lawha-topbar-height`, which
 *    lawha-editor.scss uses to push the toolbar row down. It is measured rather
 *    than fixed because the bar wraps to a second row on narrow viewports.
 *
 * `pointer-events` are off on the bar itself and on for each control, so a drag
 * beginning in the empty middle still pans the canvas.
 */
export const LawhaTopBar = ({
  saveState,
  savedAt,
  shareLink,
  isCollaborating,
  onStartSession,
  onStopSession,
  onBack,
  account,
  onSignOut,
  onOpenAccount,
  onSignIn,
  boardTag,
}: LawhaTopBarProps) => {
  const { ref: heightRef } = usePublishedHeight("--lawha-topbar-height");
  const { ref: formFactorRef, formFactor } = useLawhaFormFactor();
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [isAIOpen, setIsAIOpen] = useState(false);
  // No `isLaserOpen` here any more: the laser picker mounts itself inside the
  // toolbar island and owns its own open state, because the bar no longer
  // decides where that control appears.
  const [isOverflowOpen, setIsOverflowOpen] = useState(false);
  // This sheet is not built on `LawhaPanel` — it has no popover form to fall
  // back to, only a phone one — but it is still a phone sheet, so it owes
  // Escape, a Tab trap and focus restore to the same shared hook that
  // component uses, rather than a second copy of the same listener.
  const overflowSheetRef = useLawhaSheet(isOverflowOpen, () =>
    setIsOverflowOpen(false),
  );

  const isPhone = formFactor === "phone";
  const isTablet = formFactor === "tablet";

  const setBarRef = (node: HTMLDivElement | null) => {
    heightRef(node);
    formFactorRef(node);
  };

  return (
    <div
      ref={setBarRef}
      className={`lw-topbar lw-topbar--${formFactor}`}
      data-viewport-ui="top"
    >
      {onBack ? (
        <button
          type="button"
          className={`lw-btn lw-topbar__back${isPhone ? " lw-btn--icon" : ""}`}
          onClick={onBack}
          aria-label="Back to all boards"
          title="All boards"
        >
          <span aria-hidden="true">←</span>
          {isPhone ? null : <span>All boards</span>}
        </button>
      ) : null}

      <LawhaBoardTitle tag={isPhone || isTablet ? null : boardTag} />

      <div className="lw-topbar__spacer" />

      {isPhone ? null : (
        <LawhaSaveStatus
          state={saveState}
          savedAt={savedAt}
          compact={isTablet}
        />
      )}

      <LawhaPresenceStack
        compact={isPhone}
        currentUsername={account?.username}
        onOpenAccount={onOpenAccount}
      />

      {isPhone ? (
        <>
          <button
            type="button"
            className="lw-btn lw-btn--icon lw-topbar__overflow"
            onClick={() => setIsOverflowOpen((value) => !value)}
            aria-expanded={isOverflowOpen}
            aria-label="More board options"
          >
            <span aria-hidden="true">⋯</span>
          </button>

          {isOverflowOpen ? (
            <>
              {/* Tapping outside closes the sheet, as a bottom sheet should. */}
              <button
                type="button"
                className="lw-sheet-scrim"
                aria-label="Close board options"
                onClick={() => setIsOverflowOpen(false)}
              />
              <div
                ref={overflowSheetRef}
                className="lw-sheet"
                role="dialog"
                aria-modal="true"
                aria-label="Board options"
                tabIndex={-1}
              >
                <LawhaSaveStatus state={saveState} savedAt={savedAt} />
                {/* The phone keeps the laser picker here rather than in the
                    toolbar. Excalidraw's MobileToolbar measures itself and
                    pushes its own tools into an overflow menu when space runs
                    out — the laser is one of the tools it pushes — so there is
                    nothing in that row to sit beside, and a control added to
                    it would only take a tool's place. */}
                <LawhaLaserColor placement="inline" />
                <LawhaAIMenu open={isAIOpen} onOpenChange={setIsAIOpen} />
                <LawhaSharePopover
                  open={isShareOpen}
                  onOpenChange={setIsShareOpen}
                  link={shareLink}
                  isCollaborating={isCollaborating}
                  onStartSession={onStartSession}
                  onStopSession={onStopSession}
                  currentUsername={account?.username}
                />
                <LawhaAccountButton
                  account={account ?? null}
                  onSignOut={onSignOut}
                  onOpenAccount={onOpenAccount}
                  onSignIn={onSignIn}
                />
              </div>
            </>
          ) : null}
        </>
      ) : (
        <>
          {/* Not a bar control, despite being rendered here: it portals itself
              into the editor's toolbar island, beside the laser tool, and puts
              no node in this row. It is mounted from the bar only because the
              bar is the Lawha surface that is already a child of
              `<Excalidraw>` on every form factor. */}
          <LawhaLaserColor />
          <LawhaAIMenu
            open={isAIOpen}
            onOpenChange={setIsAIOpen}
            compact={isTablet}
          />
          <LawhaSharePopover
            open={isShareOpen}
            onOpenChange={setIsShareOpen}
            link={shareLink}
            isCollaborating={isCollaborating}
            onStartSession={onStartSession}
            onStopSession={onStopSession}
            currentUsername={account?.username}
          />
          <LawhaAccountButton
            account={account ?? null}
            onSignOut={onSignOut}
            onOpenAccount={onOpenAccount}
            onSignIn={onSignIn}
            compact={isTablet}
          />
        </>
      )}
    </div>
  );
};
