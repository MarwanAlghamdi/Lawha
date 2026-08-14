import { useState } from "react";

import { getInitials } from "../hooks/useLawhaPresence";

import { ROLE_LABEL, sortPeople } from "./shareModel";

import type { BoardRole } from "../../data/boards";
import type { SharePeople } from "./shareModel";

interface SharePeopleListProps {
  people: SharePeople;
  /** Only an owner may change a role or remove anyone. */
  isOwner: boolean;
  busy: boolean;
  onChangeRole: (userId: string, role: BoardRole) => void;
  onRemove: (userId: string) => void;
}

/**
 * Everyone who can open this board, and which of them is here right now.
 *
 * One list where there used to be two. "Who has access" listed members with
 * roles; "Here now", four sections further down, listed the same people again
 * as coloured avatars — so a person in the room appeared twice with nothing
 * tying the two rows together, and the answer to "is sara looking at this?"
 * meant scrolling between them.
 *
 * The dot is the join. It is a dot *and* a word in the accessible name, never
 * colour alone: `prefers-reduced-motion` and colour-blindness both take the
 * visual cue away, and "who is watching my board" is not a decoration.
 *
 * Removing someone is behind `⋯` rather than sitting on the row, and it expands
 * **in place** rather than opening a menu. A popover inside a popover inside a
 * phone bottom sheet is precisely the shape invariant 11 was written about, and
 * an inline row costs nothing and traps no focus.
 */
export const SharePeopleList = ({
  people,
  isOwner,
  busy,
  onChangeRole,
  onRemove,
}: SharePeopleListProps) => {
  const [openRow, setOpenRow] = useState<string | null>(null);
  const rows = sortPeople(people.people);
  const hereCount =
    rows.filter((person) => person.isHere).length + people.guests.length;

  return (
    <section className="lw-share__section">
      <div className="lw-share__section-head">
        <h3 className="lw-share__label">People</h3>
        {rows.length > 0 ? (
          <span className="lw-share__count">{rows.length}</span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="lw-share__blurb lw-share__blurb--muted">
          Nobody has been added by name yet — access comes from the link below.
        </p>
      ) : (
        <ul className="lw-share__members">
          {rows.map(({ member, isHere, isYou }) => {
            // The owner's own row has no controls: demoting yourself out of a
            // board you own is not a thing this panel offers, and the server
            // would refuse it anyway.
            const isManageable = isOwner && member.role !== "owner";
            const isOpen = openRow === member.userId;

            return (
              <li key={member.userId} className="lw-share__member">
                <div className="lw-share__member-head">
                  <span
                    className={`lw-share__here${
                      isHere ? " lw-share__here--on" : ""
                    }`}
                    // The word, not just the dot. Colour alone says nothing to
                    // a screen reader and little to a colour-blind reader.
                    aria-label={isHere ? "here now" : undefined}
                    role={isHere ? "img" : undefined}
                    aria-hidden={isHere ? undefined : true}
                  />
                  {/*
                   * Deliberately not tinted with a collaborator colour. The
                   * roster carries no colour index — only a username — so any
                   * colour picked here would be one this person is not, and
                   * would disagree with their canvas cursor the moment they
                   * joined. ADR 0001 exists because those two surfaces drifted
                   * apart once already.
                   */}
                  <span
                    className="lw-avatar lw-avatar--sm lw-share__member-avatar"
                    aria-hidden="true"
                  >
                    {getInitials(member.username)}
                  </span>
                  <span className="lw-share__member-id">
                    <span className="lw-share__member-name">
                      {member.username}
                      {isYou ? " (you)" : ""}
                    </span>
                  </span>

                  {isManageable ? (
                    <>
                      <select
                        className="lw-select lw-share__role"
                        aria-label={`Permission for ${member.username}`}
                        value={member.role}
                        disabled={busy}
                        onChange={(event) =>
                          onChangeRole(
                            member.userId,
                            event.target.value as BoardRole,
                          )
                        }
                      >
                        <option value="viewer">Can view</option>
                        <option value="editor">Can edit</option>
                        <option value="owner">Owner</option>
                      </select>
                      <button
                        type="button"
                        className="lw-btn lw-share__more"
                        aria-expanded={isOpen}
                        aria-label={`More for ${member.username}`}
                        onClick={() =>
                          setOpenRow(isOpen ? null : member.userId)
                        }
                      >
                        ⋯
                      </button>
                    </>
                  ) : (
                    <span className="lw-share__member-role">
                      {ROLE_LABEL[member.role]}
                    </span>
                  )}
                </div>

                {isManageable && isOpen ? (
                  <div className="lw-share__member-more">
                    {/*
                     * "Remove from board", not "×". The bare glyph was the only
                     * thing in this panel that destroyed access, and it was
                     * also the smallest and least explained control on the row.
                     */}
                    <button
                      type="button"
                      className="lw-btn lw-btn--danger lw-share__remove"
                      aria-label={`Remove ${member.username} from this board`}
                      disabled={busy}
                      onClick={() => {
                        setOpenRow(null);
                        onRemove(member.userId);
                      }}
                    >
                      Remove from board
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {people.guests.length > 0 ? (
        <p className="lw-mono lw-share__note">
          {people.guests.length === 1
            ? "1 visitor is here on the link"
            : `${people.guests.length} visitors are here on the link`}
          {" · "}
          they have no account here and can only watch
        </p>
      ) : hereCount > 0 ? (
        <p className="lw-mono lw-share__note">
          {hereCount === 1
            ? "1 person here now"
            : `${hereCount} people here now`}
        </p>
      ) : null}
    </section>
  );
};
