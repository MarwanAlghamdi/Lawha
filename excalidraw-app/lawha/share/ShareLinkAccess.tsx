import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { useCopyStatus } from "@excalidraw/excalidraw/hooks/useCopiedIndicator";
import { useId, useMemo, useState } from "react";

import { LINK_OPTIONS, linkOptionOf } from "./shareModel";
import { buildShareTargets } from "./shareOrigins";
import { ShareTargets } from "./ShareTargets";

import type { LinkAccess } from "../../data/boards";
import type { ShareOrigins } from "./shareOrigins";

/**
 * One link setting, as a full row.
 *
 * The label is the accessible name and the consequence is the accessible
 * description, wired by id rather than left to the default name computation. If
 * the sentence were part of the name, "Can edit" would be announced — and
 * queried by tests — as the whole paragraph, and the three options would stop
 * being distinguishable at a glance in a screen reader's list of controls.
 */
const LinkOption = ({
  option,
  selected,
  idPrefix,
  onSelect,
  disabled,
}: {
  option: typeof LINK_OPTIONS[number];
  selected: boolean;
  idPrefix: string;
  /** Omitted for a reader who may not change the setting; the row goes inert. */
  onSelect?: () => void;
  disabled?: boolean;
}) => {
  const labelId = `${idPrefix}-${option.value}-label`;
  const hintId = `${idPrefix}-${option.value}-hint`;

  const body = (
    <>
      <span className="lw-share__option-mark" aria-hidden="true" />
      <span className="lw-share__option-text">
        <span className="lw-share__option-label" id={labelId}>
          {option.label}
        </span>
        <span className="lw-share__option-hint" id={hintId}>
          {option.hint}
        </span>
      </span>
    </>
  );

  const className = `lw-share__option${
    selected ? " lw-share__option--on" : ""
  }`;

  if (!onSelect) {
    return (
      <div className={`${className} lw-share__option--static`}>{body}</div>
    );
  }

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-labelledby={labelId}
      aria-describedby={hintId}
      className={className}
      disabled={disabled}
      onClick={onSelect}
    >
      {body}
    </button>
  );
};

interface ShareLinkAccessProps {
  link: string | null;
  /**
   * The board these links point at, already resolved by the panel.
   *
   * Taken as a prop rather than re-parsed out of `link`, because the panel
   * above has the answer and `resolveBoardId` prefers the route to the link
   * anyway. Critically this is NOT a licence to rebuild `link` itself: it
   * comes from `getCollaborationLink`, whose other caller feeds it to
   * `window.history.pushState`, where a cross-origin URL throws `SecurityError`
   * inside a `try` — silently breaking room-joining for every tunnel visitor.
   */
  boardId: string | null;
  /** Where else this deployment answers. Empty means "offer only `link`". */
  origins: ShareOrigins;
  linkAccess: LinkAccess;
  /** Whether the "edit" link also reaches visitors with no account (ADR 0024). */
  guestEdit: boolean;
  isOwner: boolean;
  busy: boolean;
  onSetAccess: (access: LinkAccess, guestEdit: boolean) => void;
  onStopSharing: () => void;
}

/**
 * General access: what the link does, the link itself, and turning it off.
 *
 * These were three separate sections — "Link access", "The link", and a "Stop
 * sharing" button buried in a "Session" block below the roster. Three places to
 * look for one question, and the one that could switch it off was the furthest
 * from the one that said whether it was on.
 *
 * Last in the panel rather than first, which is the reversal that matters:
 * naming a person is the specific, deliberate act, and the link is the blanket
 * one. Putting the blanket act at the top made it the default answer to
 * "share this".
 */
export const ShareLinkAccess = ({
  link,
  boardId,
  origins,
  linkAccess,
  guestEdit,
  isOwner,
  busy,
  onSetAccess,
  onStopSharing,
}: ShareLinkAccessProps) => {
  const { onCopy, copyStatus } = useCopyStatus();
  const [isConfirmingStop, setIsConfirmingStop] = useState(false);
  /**
   * What to say when the clipboard refuses.
   *
   * Both copy paths below used to swallow the rejection — the `ShareTargets`
   * call site by not passing `onCopyError`, the single-link fallback in an
   * empty catch — on the reasoning that the field beside the button is
   * selectable so a denial is recoverable by hand. It is recoverable, and that
   * is exactly what has to be *said*: a click that produces no message and
   * leaves the button reading "Copy" is indistinguishable from one that worked,
   * so somebody walks away believing they have the link. The invite row one
   * section above has always answered the identical rejection with a sentence.
   *
   * Held here rather than reported upwards. `LawhaSharePopover` owns a
   * panel-level `role="alert"` under the header and would be the better home
   * for it — pinned there, an alert cannot be scrolled out of sight — but this
   * component takes no error sink today, and inventing a prop with no caller is
   * how `canEdit` sat unused for months (invariant 21). One call site, one
   * place to look.
   */
  const [copyError, setCopyError] = useState<string | null>(null);
  const idPrefix = useId();

  const targets = useMemo(
    () => (boardId ? buildShareTargets(origins, `/b/${boardId}`) : []),
    [origins, boardId],
  );

  // The defect this closes: a board created from the dashboard has
  // `link_access = "none"`, so the link this panel offered to copy was one that
  // 403s for everyone who follows it.
  const isLinkLive = linkAccess !== "none" && !!link;
  const currentOption = linkOptionOf(linkAccess, guestEdit);

  return (
    <section className="lw-share__section">
      <div className="lw-share__section-head">
        <h3 className="lw-share__label">General access</h3>
      </div>

      {isOwner ? (
        <div
          className="lw-share__options"
          role="radiogroup"
          aria-label="Link access"
        >
          {LINK_OPTIONS.map((option) => (
            <LinkOption
              key={option.value}
              option={option}
              selected={currentOption.value === option.value}
              idPrefix={idPrefix}
              disabled={busy}
              onSelect={() => onSetAccess(option.linkAccess, option.guestEdit)}
            />
          ))}
        </div>
      ) : (
        // A reader who cannot change the setting sees the same sentence the
        // owner sees, on the same row, rather than a paraphrase of it.
        <LinkOption
          option={currentOption}
          selected={true}
          idPrefix={idPrefix}
        />
      )}

      {/*
       * Invariant 22, as amended by ADR 0024, said out loud.
       *
       * The old sentence here — "people without an account can only watch,
       * whatever the link says" — was unconditional, and one of the four
       * options above now makes it false. Rather than delete the note, it says
       * the part that is still true and still surprising: a visitor is a
       * narrower principal either way, scoped to this one board and carrying no
       * account. What changed is the role, never the scope.
       */}
      <p className="lw-mono lw-share__note">
        {currentOption.guestEdit
          ? "visitors stay anonymous, and reach only this board"
          : "people without an account can only watch, whatever the link says"}
      </p>

      {isLinkLive ? (
        targets.length > 0 ? (
          // One row per route, replacing the single field rather than sitting
          // above it. `link` is built from `window.location.origin`, so
          // offering it alongside two labelled addresses would put the very
          // link this feature exists to stop handing out at the top of the
          // list — and it would be the one a hurried reader copies.
          <ShareTargets
            targets={targets}
            subject="Board link"
            onCopyError={setCopyError}
          />
        ) : (
          <div className="lw-share__url-row">
            <input
              className="lw-input lw-mono lw-share__url"
              value={link ?? ""}
              readOnly
              aria-label="Board link"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              className="lw-btn lw-btn--primary lw-share__copy"
              onClick={async () => {
                setCopyError(null);
                try {
                  await copyTextToSystemClipboard(link ?? "");
                  onCopy();
                } catch {
                  // Recoverable, and therefore worth a sentence rather than a
                  // shrug: the input above is selectable and holds the same
                  // string, so the way out is a keystroke — but only for
                  // somebody who has been told the copy did not happen.
                  setCopyError("Could not copy. Select the link and copy it.");
                }
              }}
            >
              {copyStatus === "success" ? "Copied" : "Copy"}
            </button>
          </div>
        )
      ) : (
        // Deliberately no field and no Copy button, not a disabled one: a board
        // created from the dashboard has `link_access = "none"`, and the link
        // this panel used to offer 403s for everyone who follows it. Offering
        // it disabled would still say "there is a link".
        <p className="lw-share__blurb lw-share__blurb--muted">
          The link is off, so there is nothing to copy: following it would be
          refused.
          {isOwner ? " Turn it on above to hand this board out." : ""}
        </p>
      )}

      {/*
       * Under the row that failed, and announced.
       *
       * `role="alert"` rather than a plain paragraph because the sentence
       * appears after the panel has been read: somebody presses Copy, looks at
       * the clipboard, and never looks back at this section. Announcing it is
       * the difference between a message and a message somebody receives.
       */}
      {copyError ? (
        <p className="lw-share__error" role="alert">
          {copyError}
        </p>
      ) : null}

      {isOwner && linkAccess !== "none" ? (
        isConfirmingStop ? (
          /*
           * In-app, not `window.confirm`. A native dialog blocks the renderer's
           * main thread until it is dismissed (invariant 19), and the one that
           * used to be here sat in the middle of `stopCollaboration` — where it
           * also conflated un-sharing a board with walking away from one.
           */
          <div className="lw-share__confirm" role="alertdialog">
            <p className="lw-share__blurb">
              Turn the link off? Anyone who joined by link loses access at once.
              The people listed above keep theirs.
            </p>
            <div className="lw-share__confirm-actions">
              <button
                type="button"
                className="lw-btn"
                onClick={() => setIsConfirmingStop(false)}
              >
                Keep sharing
              </button>
              <button
                type="button"
                className="lw-btn lw-btn--danger"
                disabled={busy}
                onClick={() => {
                  onStopSharing();
                  setIsConfirmingStop(false);
                }}
              >
                Turn it off
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="lw-btn lw-share__stop"
            onClick={() => setIsConfirmingStop(true)}
          >
            Turn off sharing
          </button>
        )
      ) : null}
    </section>
  );
};
