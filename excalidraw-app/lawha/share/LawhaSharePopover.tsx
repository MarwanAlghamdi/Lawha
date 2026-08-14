import { useCallback, useEffect, useMemo, useState } from "react";

import { useAtomValue } from "../../app-jotai";
import { boardAccessAtom, collabAPIAtom } from "../../collab/Collab";
import {
  listBoardMembers,
  removeBoardMember,
  setBoardMember,
} from "../../data/boards";
import { LawhaPanel } from "../chrome/LawhaPanel";
import { useLawhaSession } from "../auth/useLawhaSession";
import { useLawhaPresence } from "../hooks/useLawhaPresence";

import { ShareCodes } from "./ShareCodes";
import { ShareInviteRow } from "./ShareInviteRow";
import { ShareLinkAccess } from "./ShareLinkAccess";
import { SharePeopleList } from "./SharePeopleList";
import { joinPresence, resolveBoardId } from "./shareModel";
import { useShareOrigins } from "./useShareOrigins";

import "./LawhaSharePopover.scss";

import type { BoardMember, LinkAccess } from "../../data/boards";

interface LawhaSharePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The shareable board URL, or null while a session is being started. */
  link: string | null;
  isCollaborating: boolean;
  onStartSession: () => void;
  /** Leaves the board entirely. Sharing is a separate control inside. */
  onStopSession: () => void;
  /** Own display name; the collaborator map does not carry it for self. */
  currentUsername?: string;
}

/**
 * Sharing, people first.
 *
 * The order is the change. This panel used to run link access → the link →
 * who has access → add people → here now → stop sharing: six headed sections,
 * with the two halves of "who can see this" at opposite ends and the same
 * people listed twice in between. It now reads the way every tool people
 * already know reads — add someone, see who is on it, then the blanket link
 * setting underneath.
 *
 * That ordering is an argument, not a convention. Naming a person is the
 * deliberate act; handing out a link is the blanket one. Whichever is at the
 * top is the one that gets used, and on a board carrying a key in its URL that
 * should not be the blanket one.
 *
 * Nothing here widens permission. Every mutating control is owner-gated, and
 * the server enforces the same rule in four places (invariant 21); this file
 * touches none of them.
 */
const ShareBody = ({
  link,
  isCollaborating,
  onStartSession,
  onStopSession,
  onClose,
  currentUsername,
}: {
  link: string | null;
  isCollaborating: boolean;
  onStartSession: () => void;
  onStopSession: () => void;
  onClose: () => void;
  currentUsername?: string;
}) => {
  const present = useLawhaPresence(currentUsername);
  const collabAPI = useAtomValue(collabAPIAtom);
  const access = useAtomValue(boardAccessAtom);
  const { user } = useLawhaSession();
  const boardId = resolveBoardId(link);
  /**
   * Asked for here and nowhere else, once per opening.
   *
   * This component is mounted by `LawhaPanel` only while the panel is open —
   * Radix does not render popover content while it is shut, and the phone
   * sheet branch renders nothing either — so a mount-time fetch IS a
   * fetch-on-open. Both children get the same answer rather than asking
   * separately, which also keeps the two link surfaces from ever disagreeing
   * about what this deployment answers to.
   */
  const origins = useShareOrigins();

  const [members, setMembers] = useState<BoardMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Bumped after any membership change.
   *
   * The invite row's candidate search has to re-run when the roster changes —
   * someone just added is no longer a candidate. It used to depend on the
   * `members` array itself, which meant every role change re-ran the search as
   * well; a counter says "membership moved" without saying how.
   */
  const [revision, setRevision] = useState(0);

  const isOwner = access.role === "owner";
  const { linkAccess } = access;

  const refreshMembers = useCallback(async () => {
    if (!boardId || access.role === null) {
      setMembers([]);
      return;
    }
    try {
      const membership = await listBoardMembers(boardId);
      setMembers(membership.members);
    } catch {
      // Not fatal: the link half of this panel still works without a roster.
      setMembers([]);
    }
  }, [boardId, access.role]);

  useEffect(() => {
    void refreshMembers();
  }, [refreshMembers]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught: any) {
      setError(caught?.message ?? "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Applies a membership change from the response, rather than refetching.
   *
   * `setBoardMember` and `removeBoardMember` both return the new roster, so the
   * extra `GET /members` the old code fired after each one was a second round
   * trip for an answer already in hand — and a window in which the list on
   * screen was the one from before the change.
   */
  const applyMembers = (next: BoardMember[]) => {
    setMembers(next);
    setRevision((current) => current + 1);
  };

  const people = useMemo(
    () => joinPresence(members, present, user?.id ?? null),
    [members, present, user?.id],
  );

  const header = (
    <div className="lw-share__header">
      <span className="lw-share__heading">Share this board</span>
      <button
        type="button"
        className="lw-share__close"
        onClick={onClose}
        aria-label="Close share panel"
      >
        ×
      </button>
    </div>
  );

  // No board and no session: the plain canvas at `/`. Nothing to share until
  // there is somewhere to share it from.
  if (!boardId && !isCollaborating) {
    return (
      <>
        {header}
        <div className="lw-share__section">
          <p className="lw-share__blurb">
            This board is private. Start a session to get a link your team can
            open.
          </p>
          <button
            type="button"
            className="lw-btn lw-btn--primary lw-share__start"
            onClick={onStartSession}
          >
            Start session
          </button>
        </div>
        {/*
          This said "the link carries the encryption key · the server never
          sees your drawing". Both halves became false in ADR 0012 and the
          second was the dangerous one: this panel is exactly where somebody
          decides how far to hand a board, so overstating the protection here
          is worse than saying nothing. What replaces it is the fact that
          actually governs the decision — the address IS the secret now.
        */}
        <p className="lw-mono lw-share__note lw-share__footer">
          anyone who can open this board can copy its address
        </p>
      </>
    );
  }

  return (
    <>
      {header}

      {/*
       * Pinned under the header rather than beside the control that failed.
       * The panel scrolls, and an alert parked at the bottom of a scrolled
       * panel is an alert nobody reads.
       */}
      {error ? (
        <p className="lw-share__error" role="alert">
          {error}
        </p>
      ) : null}

      {isOwner && boardId ? (
        <ShareInviteRow
          boardId={boardId}
          busy={busy}
          revision={revision}
          onAdd={(userId, role) =>
            run(async () =>
              applyMembers(await setBoardMember(boardId, userId, role)),
            )
          }
        />
      ) : null}

      {access.role !== null ? (
        <SharePeopleList
          people={people}
          isOwner={isOwner}
          busy={busy}
          onChangeRole={(userId, role) =>
            void run(async () =>
              applyMembers(await setBoardMember(boardId!, userId, role)),
            )
          }
          onRemove={(userId) =>
            void run(async () =>
              applyMembers(await removeBoardMember(boardId!, userId)),
            )
          }
        />
      ) : null}

      {/*
       * Between the roster and the link, which is where it belongs in the
       * argument this panel makes. The sections run from most deliberate to
       * most blanket: naming a person needs their account to exist, a code is
       * as easy to hand over as a link but still leaves them a member, and the
       * link grants nothing durable at all.
       */}
      {isOwner && boardId ? (
        <ShareCodes
          boardId={boardId}
          busy={busy}
          onError={setError}
          origins={origins}
        />
      ) : null}

      <ShareLinkAccess
        link={link}
        boardId={boardId}
        origins={origins}
        linkAccess={linkAccess}
        isOwner={isOwner}
        busy={busy}
        onSetAccess={(next: LinkAccess) =>
          void run(async () => {
            await collabAPI?.setLinkAccess(next);
          })
        }
        onStopSharing={() =>
          void run(async () => {
            await collabAPI?.stopSharing();
          })
        }
      />

      {isCollaborating ? (
        <div className="lw-share__actions">
          <button
            type="button"
            className="lw-btn lw-share__leave"
            onClick={onStopSession}
          >
            Leave board
          </button>
        </div>
      ) : null}

      <p className="lw-mono lw-share__note lw-share__footer">
        anyone who can open this board can copy its address
      </p>
    </>
  );
};

/**
 * Sharing, anchored to the Share button inside the canvas.
 *
 * A popover rather than the package's `ShareDialog`, which is built on `Dialog`
 * and therefore renders fullscreen on phones and as a centred modal elsewhere —
 * exactly the external overlay the consolidated UI is meant to avoid. It also
 * portals into the editor container rather than document.body, so it genuinely
 * lives inside the canvas UI.
 *
 * On a phone the same content becomes a bottom sheet, which is reachable
 * one-handed where an anchored popover is not.
 */
export const LawhaSharePopover = ({
  open,
  onOpenChange,
  link,
  isCollaborating,
  onStartSession,
  onStopSession,
  currentUsername,
}: LawhaSharePopoverProps) => (
  <LawhaPanel
    open={open}
    onOpenChange={onOpenChange}
    className="lw-share"
    ariaLabel="Share this board"
    trigger={(triggerProps) => (
      <button
        {...triggerProps}
        type="button"
        className="lw-btn lw-btn--primary lw-share-trigger"
        aria-label="Share this board"
      >
        Share
      </button>
    )}
  >
    <ShareBody
      link={link}
      isCollaborating={isCollaborating}
      onStartSession={onStartSession}
      onStopSession={onStopSession}
      onClose={() => onOpenChange(false)}
      currentUsername={currentUsername}
    />
  </LawhaPanel>
);
