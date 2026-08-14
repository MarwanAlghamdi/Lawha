import {
  useExcalidrawAPI,
  useExcalidrawStateValue,
} from "@excalidraw/excalidraw";

import { avatarUrl } from "../auth/authApi";
import { useLawhaSession } from "../auth/useLawhaSession";
import { useLawhaPresence } from "../hooks/useLawhaPresence";

import type { LawhaPresenceUser } from "../hooks/useLawhaPresence";

/** Three fits the 44px bar at tablet width; the built-in UserList uses four. */
const MAX_VISIBLE = 3;

interface LawhaPresenceStackProps {
  /** Phone collapses to a count-only chip. */
  compact?: boolean;
  /** Own display name, which the collaborator map does not carry for self. */
  currentUsername?: string;
  /** Opens the account panel when you click your own avatar. */
  onOpenAccount?: () => void;
}

/**
 * The guest badge.
 *
 * A view-only visitor holding a share link used to be indistinguishable from a
 * signed-in one — they got a crewmate and an assigned colour and nothing said
 * they had no account (known issue 15). This is that marker. Styled inline
 * rather than in `LawhaTopBar.scss` because it is nine declarations attached to
 * one element and it belongs next to the condition that renders it.
 */
const GUEST_BADGE_STYLE: React.CSSProperties = {
  position: "absolute",
  insetBlockEnd: "-1px",
  insetInlineEnd: "-1px",
  width: "12px",
  height: "12px",
  borderRadius: "50%",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--lw-surface)",
  color: "var(--lw-text2)",
  border: "1px solid var(--lw-border)",
  fontSize: "8px",
  fontWeight: 700,
  lineHeight: 1,
  pointerEvents: "none",
};

const Avatar = ({
  user,
  picture,
  isFollowed,
  onSelect,
  onOpenAccount,
}: {
  user: LawhaPresenceUser;
  /** Profile picture, when one is known for this person. */
  picture: string | null;
  /** Whether this viewport is currently following this person. */
  isFollowed: boolean;
  onSelect: (user: LawhaPresenceUser) => void;
  /** Only your own avatar uses this; a peer's opens follow mode instead. */
  onOpenAccount?: () => void;
}) => {
  // The guest status goes in the label, not only in the badge: a badge is
  // invisible to a screen reader, and "who am I sharing this board with" is
  // exactly the sort of thing that must not be visual-only.
  //
  // The follow verb tracks the state rather than being fixed at "Follow".
  // Clicking used to re-set an identical `userToFollow`, so the same control
  // said "Follow X" whether or not you were already following X — and there
  // was no way out of follow mode from this stack at all.
  const label = user.isCurrentUser
    ? `${user.name} (you)`
    : `${isFollowed ? "Stop following" : "Follow"} ${user.name}${
        user.isGuest ? " (guest, no account)" : ""
      }`;

  const inner = picture ? (
    <img className="lw-avatar__img" src={picture} alt="" draggable={false} />
  ) : (
    user.initials
  );

  // Your own avatar OPENS YOUR ACCOUNT, and the history here is worth keeping.
  //
  // It was first a `<button>` whose handler returned immediately — "the worst
  // of both: it takes focus, invites a click, and answers with nothing" — and
  // the fix was to make it a `<span>`. That addressed the focus half and left
  // the affordance untouched: it still looks exactly like the collaborator
  // avatars beside it, which ARE clickable. People kept clicking their own
  // picture and getting silence, and reported it as a bug, which it was.
  //
  // A span that looks like a control is the same defect wearing a different
  // tag. Making it look less clickable was never really available — it is a
  // picture of you, in a bar made of controls — so it does the obvious thing
  // instead, and the obvious thing already existed one component away.
  //
  // Falls back to the old inert span when no handler is given, so a caller
  // that has nowhere to send you does not render a button that lies.
  if (user.isCurrentUser) {
    return (
      <span
        className="lw-presence__slot"
        style={{ position: "relative", display: "inline-flex" }}
      >
        {onOpenAccount ? (
          <button
            type="button"
            className="lw-avatar"
            style={{ background: user.color, opacity: user.isIdle ? 0.45 : 1 }}
            title={`${label} — open your account`}
            aria-label={label}
            onClick={onOpenAccount}
          >
            {inner}
          </button>
        ) : (
          <span
            className="lw-avatar"
            style={{ background: user.color, opacity: user.isIdle ? 0.45 : 1 }}
            title={label}
            aria-label={label}
          >
            {inner}
          </span>
        )}
      </span>
    );
  }

  return (
    <span
      className="lw-presence__slot"
      style={{ position: "relative", display: "inline-flex" }}
    >
      <button
        type="button"
        className={`lw-avatar${isFollowed ? " lw-avatar--following" : ""}`}
        style={{ background: user.color, opacity: user.isIdle ? 0.45 : 1 }}
        onClick={() => onSelect(user)}
        title={label}
        aria-label={label}
        // `aria-pressed`, because this is a toggle and a screen reader has no
        // other way to know the state — the ring that shows it visually is a
        // box-shadow.
        aria-pressed={isFollowed}
      >
        {inner}
      </button>
      {user.isGuest ? (
        <span
          className="lw-presence__guest"
          style={GUEST_BADGE_STYLE}
          aria-hidden="true"
        >
          G
        </span>
      ) : null}
    </span>
  );
};

/**
 * Who else is on this board.
 *
 * Replaces the package's built-in `UserList` (hidden via CSS in
 * lawha-editor.scss, since LayerUI renders it unconditionally with no prop to
 * disable it). Clicking an avatar still enters follow mode, so no capability is
 * lost in the swap.
 */
export const LawhaPresenceStack = ({
  compact,
  currentUsername,
  onOpenAccount,
}: LawhaPresenceStackProps) => {
  const excalidrawAPI = useExcalidrawAPI();
  const users = useLawhaPresence(currentUsername);

  // Read, not just written. The stack set `userToFollow` and never looked at
  // it, so nothing in Lawha's chrome could say you were following anybody —
  // and `followedBy` was never read at all, so "three people are watching your
  // screen" was invisible from the surface that lists those three people.
  //
  // Both are per-viewer and excluded from browser, export and server
  // persistence (`appState.ts`), so reading them here alters nothing anyone
  // else sees.
  const userToFollow = useExcalidrawStateValue("userToFollow");
  const followedBy = useExcalidrawStateValue("followedBy");
  const { user: account } = useLawhaSession();

  // Peers carry their own picture now: the server announces each socket's
  // account id and — only when that account opted in — its avatar id, and
  // Collab turns the pair into `LawhaPresenceUser.avatarUrl`.
  //
  // Your own is still read from the session as well, because it is the one
  // picture that should be visible whether or not you opted in to putting it on
  // your cursor, and because it is available before the first identity
  // announcement lands. Note this is a DOM surface, so the colours behind these
  // avatars come from `hex`, never `hexDark` — nothing here is filtered.
  const ownPicture = account ? avatarUrl(account.id, account.avatarId) : null;

  if (users.length === 0) {
    return null;
  }

  // A TOGGLE, not a setter. This only ever *set* `userToFollow`, so clicking
  // the same avatar again re-set an identical value and there was no way to
  // leave follow mode from Lawha's own chrome at all — you had to pan the
  // canvas, which cancels it as a side effect. Upstream's
  // `actionGoToCollaborator` has always toggled; the Lawha stack does not use
  // that action, so it needed its own.
  const follow = (user: LawhaPresenceUser) => {
    if (user.isCurrentUser) {
      return;
    }
    excalidrawAPI?.updateScene({
      appState: {
        userToFollow:
          userToFollow?.socketId === user.socketId
            ? null
            : { socketId: user.socketId, username: user.name },
      },
    });
  };

  const visible = users.slice(0, MAX_VISIBLE);
  const overflow = users.length - visible.length;

  if (compact) {
    return (
      <div className="lw-pill lw-presence lw-presence--compact">
        <span
          className="lw-dot lw-dot--pulse"
          style={{ background: users[0].color }}
        />
        <span className="lw-mono">{users.length}</span>
        <span className="lw-visually-hidden">
          {users.length} people on this board
        </span>
      </div>
    );
  }

  const followedName = userToFollow
    ? users.find((user) => user.socketId === userToFollow.socketId)?.name ??
      userToFollow.username
    : null;
  const watcherCount = followedBy?.size ?? 0;

  return (
    <div className="lw-pill lw-presence">
      <div className="lw-presence__avatars">
        {visible.map((user) => (
          <Avatar
            key={user.socketId}
            user={user}
            picture={user.avatarUrl ?? (user.isCurrentUser ? ownPicture : null)}
            isFollowed={userToFollow?.socketId === user.socketId}
            onSelect={follow}
            onOpenAccount={user.isCurrentUser ? onOpenAccount : undefined}
          />
        ))}
        {overflow > 0 ? (
          <span className="lw-avatar lw-avatar--overflow">+{overflow}</span>
        ) : null}
      </div>

      {/*
        The count slot says what is happening, in priority order: following
        somebody, then being followed, then the plain head count.

        Following wins because it is the state that changes what YOUR canvas
        does — your viewport is not yours while it is on — and a viewer who
        cannot tell why the board keeps moving has no way to guess. Being
        followed changes nothing you see, so it yields.

        `aria-live="polite"` was already here for the head count and now
        carries these too, which is what makes entering and leaving follow mode
        audible rather than purely visual.
      */}
      <span className="lw-mono lw-presence__count" aria-live="polite">
        {followedName ? (
          <button
            type="button"
            className="lw-presence__following"
            onClick={() =>
              excalidrawAPI?.updateScene({ appState: { userToFollow: null } })
            }
            title={`Stop following ${followedName}`}
          >
            following {followedName} ✕
          </button>
        ) : watcherCount > 0 ? (
          `${watcherCount} following you`
        ) : (
          `${users.length} here`
        )}
      </span>
    </div>
  );
};
