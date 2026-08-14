import { useCallback, useEffect, useState } from "react";

import {
  createBoardInvite,
  listBoardInvites,
  revokeBoardInvite,
} from "../../data/invites";

import { buildShareTargets } from "./shareOrigins";
import { ShareTargets } from "./ShareTargets";

import type { BoardInvite, InviteRole } from "../../data/invites";
import type { ShareOrigins } from "./shareOrigins";

interface ShareCodesProps {
  boardId: string;
  busy: boolean;
  onError: (message: string) => void;
  /**
   * The addresses this deployment answers to. Empty on both counts is the
   * ordinary state — nothing configured — and means the single Copy button
   * below, unchanged.
   */
  origins: ShareOrigins;
}

/**
 * Invite codes, in the share panel. See ADR 0014.
 *
 * This sits between "add people" and the link setting because that is where it
 * belongs in the argument the panel makes. Naming somebody is the most
 * deliberate act and needs to know their account exists; the link is the
 * blanket one and grants nothing durable. A code is the middle: as easy to
 * hand over as a link, and it leaves the person a member, so the board is
 * still on their dashboard next week.
 *
 * The code is rendered large and spaced, because its whole reason to exist is
 * being read out loud.
 */

const EXPIRY_CHOICES: { label: string; hours: number }[] = [
  { label: "1 hour", hours: 1 },
  { label: "1 day", hours: 24 },
  { label: "1 week", hours: 24 * 7 },
];

/**
 * Short labels on purpose.
 *
 * "Anyone who has it" said it better and did not fit: three selects share a
 * 380px panel, so it rendered clipped to "Anyone wh…" — a control whose whole
 * job is stating a choice, truncated on the word that carries it. The hint
 * under the heading already explains what a code does.
 */
const USE_CHOICES: { label: string; maxUses: number | null }[] = [
  { label: "One person", maxUses: 1 },
  { label: "Anyone", maxUses: null },
];

/**
 * A code's remaining life, in the register a person would use out loud.
 *
 * Deliberately coarse. "Expires in 6 days 4 hours" reads as precision nobody
 * asked for, and the decision it informs — "will this still work when they
 * get to their desk" — needs nothing finer.
 */
const expiryLabel = (expiresAt: number | null, now: number): string => {
  if (expiresAt === null) {
    return "never expires";
  }
  const remaining = expiresAt - now;
  if (remaining <= 0) {
    return "expired";
  }
  const hours = Math.round(remaining / 3_600_000);
  if (hours < 1) {
    return "expires within the hour";
  }
  if (hours < 24) {
    return `expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `expires in ${days} day${days === 1 ? "" : "s"}`;
};

const STATUS_LABEL: Record<BoardInvite["status"], string> = {
  live: "",
  revoked: "turned off",
  expired: "expired",
  exhausted: "all used up",
};

const usesLabel = (invite: BoardInvite): string => {
  const used = invite.redeemedBy.length;
  if (invite.maxUses === null) {
    return used === 0 ? "nobody has used it yet" : `used by ${used}`;
  }
  return `${used} of ${invite.maxUses} used`;
};

export const ShareCodes = ({
  boardId,
  busy,
  onError,
  origins,
}: ShareCodesProps) => {
  const [invites, setInvites] = useState<BoardInvite[]>([]);
  const [role, setRole] = useState<InviteRole>("editor");
  const [expiresInHours, setExpiresInHours] = useState(24 * 7);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInvites(await listBoardInvites(boardId));
    } catch {
      // Not fatal. The rest of the panel — people, the link — still works
      // without the code list, and an owner who cannot see their codes is
      // better served by the panel opening than by it refusing to.
      setInvites([]);
    }
  }, [boardId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mint = async () => {
    setMinting(true);
    try {
      const result = await createBoardInvite(boardId, {
        role,
        expiresInHours,
        maxUses,
      });
      setInvites(result.invites);
    } catch (caught: any) {
      onError(caught?.message ?? "Could not make a code.");
    } finally {
      setMinting(false);
    }
  };

  const revoke = async (code: string) => {
    try {
      setInvites(await revokeBoardInvite(boardId, code));
    } catch (caught: any) {
      onError(caught?.message ?? "Could not turn that code off.");
    }
  };

  /**
   * The one-button copy, for a deployment that has told us nothing.
   *
   * Still `window.location.origin`, and deliberately: with no configured
   * origin there is no better answer than the address this tab is already on,
   * and inventing one would be a guess. Where the operator HAS said what this
   * deployment answers to, this button is replaced — not supplemented — by the
   * labelled rows below, because leaving it would put the origin-bound link
   * first in a panel whose whole point is that the reader picks the route.
   */
  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/join/${code}`,
      );
      setCopied(code);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard access can be refused, and there is nothing to do about it —
      // the code is on screen and can be read out, which is the point of it.
      onError("Could not copy. The code is on screen — read it out.");
    }
  };

  const now = Date.now();
  const live = invites.filter((invite) => invite.status === "live");
  const spent = invites.filter((invite) => invite.status !== "live");

  return (
    <section className="lw-share__section lw-codes">
      <div className="lw-codes__head">
        <span className="lw-field__label">Invite with a code</span>
        <p className="lw-share__blurb lw-share__blurb--muted">
          Three words somebody can type or you can read out. Whoever uses one
          joins this board properly — it stays on their dashboard, and you can
          remove them later like anyone else.
        </p>
      </div>

      <div className="lw-codes__mint">
        <label className="lw-field">
          {/*
            "Role", not "They join as", which is what the picker in the Add
            people row above already says. Two identical labels in one panel
            controlling different things is a panel you have to read twice.
          */}
          <span className="lw-field__label">Role</span>
          <select
            className="lw-select"
            value={role}
            disabled={busy || minting}
            onChange={(event) => setRole(event.target.value as InviteRole)}
          >
            <option value="viewer">Can view</option>
            <option value="editor">Can edit</option>
          </select>
        </label>

        <label className="lw-field">
          <span className="lw-field__label">Good for</span>
          <select
            className="lw-select"
            value={expiresInHours}
            disabled={busy || minting}
            onChange={(event) => setExpiresInHours(Number(event.target.value))}
          >
            {EXPIRY_CHOICES.map((choice) => (
              <option key={choice.hours} value={choice.hours}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>

        <label className="lw-field">
          <span className="lw-field__label">Usable by</span>
          <select
            className="lw-select"
            value={maxUses === null ? "any" : "one"}
            disabled={busy || minting}
            onChange={(event) =>
              setMaxUses(event.target.value === "one" ? 1 : null)
            }
          >
            {USE_CHOICES.map((choice) => (
              <option
                key={choice.label}
                value={choice.maxUses === null ? "any" : "one"}
              >
                {choice.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="lw-btn lw-btn--primary lw-codes__mint-btn"
          disabled={busy || minting}
          onClick={() => void mint()}
        >
          {minting ? "Making…" : "Make a code"}
        </button>
      </div>

      {live.length > 0 ? (
        <ul className="lw-codes__list">
          {live.map((invite) => {
            // Per code, because the path carries the code. Cheap and pure —
            // `buildShareTargets` reads no globals, which is the property that
            // stops this file re-deriving the bug it is fixing.
            const targets = buildShareTargets(origins, `/join/${invite.code}`);
            return (
              <li key={invite.code} className="lw-codes__item">
                {/*
                  The code is the content of this row, not a label on it, so it
                  is the thing that is large. `lw-codes__code` spaces the words
                  out; reading three run-together words aloud is where a
                  mis-hearing comes from.
                */}
                <span className="lw-codes__code">
                  {invite.code.split("-").join(" · ")}
                </span>

                <span className="lw-codes__meta">
                  {invite.role === "editor" ? "Can edit" : "Can view"} ·{" "}
                  {expiryLabel(invite.expiresAt, now)} · {usesLabel(invite)}
                </span>

                {invite.redeemedBy.length > 0 ? (
                  <span className="lw-codes__who">
                    Used by{" "}
                    {invite.redeemedBy.map((r) => r.username).join(", ")}
                  </span>
                ) : null}

                <div className="lw-codes__actions">
                  {targets.length === 0 ? (
                    <button
                      type="button"
                      className="lw-btn"
                      disabled={busy}
                      onClick={() => void copy(invite.code)}
                    >
                      {copied === invite.code ? "Copied" : "Copy link"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="lw-btn lw-codes__revoke"
                    disabled={busy}
                    onClick={() => void revoke(invite.code)}
                  >
                    Turn off
                  </button>
                </div>

                {targets.length > 0 ? (
                  <ShareTargets
                    targets={targets}
                    subject="Invite link"
                    // The code's own fallback, kept: it is on screen and can be
                    // read out, which is the entire reason a code is three words
                    // rather than a board id.
                    onCopyError={() =>
                      onError(
                        "Could not copy. The code is on screen — read it out.",
                      )
                    }
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="lw-mono lw-share__note">no codes right now</p>
      )}

      {spent.length > 0 ? (
        <details className="lw-codes__spent">
          <summary>
            {spent.length} older code{spent.length === 1 ? "" : "s"}
          </summary>
          <ul className="lw-codes__list">
            {spent.map((invite) => (
              <li
                key={invite.code}
                className="lw-codes__item lw-codes__item--dead"
              >
                <span className="lw-codes__code">
                  {invite.code.split("-").join(" · ")}
                </span>
                <span className="lw-codes__meta">
                  {STATUS_LABEL[invite.status]}
                  {invite.redeemedBy.length > 0
                    ? ` · let in ${invite.redeemedBy
                        .map((r) => r.username)
                        .join(", ")}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
          {/*
            Kept rather than cleared, because this is the record of who a code
            let in. Turning a code off does not remove the people it already
            added — they are ordinary members now — and an owner deciding
            whether to remove one of them needs to see how they got here.
          */}
          <p className="lw-mono lw-share__note">
            turning a code off does not remove anyone it already let in
          </p>
        </details>
      ) : null}
    </section>
  );
};
