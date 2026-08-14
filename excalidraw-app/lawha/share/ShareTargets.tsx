import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { useCopyStatus } from "@excalidraw/excalidraw/hooks/useCopiedIndicator";

import { useTunnelLiveness } from "./useTunnelLiveness";

import type { ShareTarget, ShareTargetKind } from "./shareOrigins";
import type { TunnelLiveness } from "./useTunnelLiveness";

/**
 * One link per route, labelled by where it goes.
 *
 * Shared by the board link and the invite code because they are the same
 * question asked about two paths — `/b/<id>` and `/join/<code>` — and the
 * defect was identical in both: the URL was built from
 * `window.location.origin`, so **whoever did the sharing decided everyone
 * else's route**. Somebody two desks away was sent out through the tunnel and
 * back in; somebody off-network was handed an mDNS name that resolves to
 * nothing for them.
 *
 * This component renders nothing at all when there are no targets — the caller
 * checks the array and keeps its existing single link. That is not a
 * degradation path: this deployment runs today with neither origin configured,
 * so "no targets" is the live case and has to look exactly like it did before
 * this feature existed.
 */

/**
 * The label a person reads, per route.
 *
 * Not the origin. A hostname is what the link says; "On our network" is what
 * the reader is actually choosing between, and it is the same choice whether
 * this deployment's LAN name is `lawha.local` or something else entirely.
 */
const ROUTE_LABEL: Record<ShareTargetKind, string> = {
  lan: "On our network",
  // Rendered inside the disclosure, whose summary already says "by IP" — this
  // is here so a screen reader announcing the row out of context still knows
  // which of two LAN addresses it landed on.
  "lan-fallback": "Also on our network",
  public: "Anywhere",
};

/**
 * What choosing that route costs, in one line.
 */
const ROUTE_HINT: Record<ShareTargetKind, string | null> = {
  lan: "Fastest. Office network only.",
  "lan-fallback": null,
  public: "Works from outside. Slower, and it uses the tunnel's monthly quota.",
};

/**
 * The words beside the dot, per state.
 *
 * Words and not colour alone, for the reason `SharePeopleList` already states
 * about presence: `prefers-reduced-motion` and colour-blindness both take the
 * visual cue away, and this one is the difference between a link that works and
 * a link that does not.
 *
 * `checking` reads as `checking…` and never as anything hopeful. Somebody looks
 * at this dot in the seconds before handing the link to another person, so
 * "I do not know yet" must not be mistakable for "alive" — an optimistic
 * placeholder here would rebuild the exact defect the dot exists to close.
 */
const LIVENESS_LABEL: Record<Exclude<TunnelLiveness, "not-checked">, string> = {
  checking: "checking…",
  up: "answering",
  down: "not answering",
  here: "you're on it",
};

/** The same fact at length, for a hover and for the accessible description. */
const LIVENESS_TITLE: Record<Exclude<TunnelLiveness, "not-checked">, string> = {
  checking: "Asking this address whether it is up.",
  up: "This address answered just now.",
  down: "Nothing answered at this address. The link will not open.",
  here: "You are reading this page through this address, so it is up.",
};

const RouteStatus = ({ state }: { state: TunnelLiveness }) => {
  if (state === "not-checked") {
    return null;
  }

  return (
    <span
      className={`lw-share__route-status lw-share__route-status--${state}`}
      // Mirrors `LawhaSaveStatus`: the transition from `checking…` to an answer
      // happens after the panel has been read, so it has to be announced rather
      // than merely rendered.
      role="status"
      aria-live="polite"
      title={LIVENESS_TITLE[state]}
    >
      <span
        className={`lw-dot${state === "checking" ? " lw-dot--pulse" : ""}`}
        aria-hidden="true"
      />
      {LIVENESS_LABEL[state]}
    </span>
  );
};

/**
 * The row's accessible name, and the only thing that distinguishes two rows.
 *
 * The origin rather than the label, because a deployment may configure several
 * LAN addresses and "Also on our network" three times over is three controls
 * a screen reader cannot tell apart. `subject` keeps the board link and an
 * invite link separable in the same panel, where both are rendered at once.
 */
const nameFor = (subject: string, target: ShareTarget) =>
  `${subject} at ${target.origin}`;

/**
 * The Copy button's accessible name, which is a sentence rather than a noun.
 *
 * Lower-cased because it lands mid-sentence after "Copy" — three of these are
 * read out in a row when a deployment has three addresses, and "Copy Board
 * link at …" three times is harder to follow than the instruction it is meant
 * to be. Both callers pass a common noun, so this is safe.
 */
const copyNameFor = (subject: string, target: ShareTarget) =>
  `Copy ${subject.toLowerCase()} at ${target.origin}`;

const ShareTargetRow = ({
  target,
  subject,
  pageOrigin,
  onCopyError,
}: {
  target: ShareTarget;
  subject: string;
  /** The origin this tab is on. See `ShareTargets` for why it is a prop. */
  pageOrigin: string;
  /**
   * Reported when the clipboard refuses. Optional: the field beside the button
   * is selectable, so a denial is always recoverable by hand, and only the
   * code panel has somewhere to put a sentence.
   */
  onCopyError?: (message: string) => void;
}) => {
  const { onCopy, copyStatus } = useCopyStatus();
  const liveness = useTunnelLiveness(target, pageOrigin);
  const name = nameFor(subject, target);
  const hint = ROUTE_HINT[target.kind];

  return (
    <div className="lw-share__route">
      <div className="lw-share__route-head">
        <span className="lw-share__route-label">
          {ROUTE_LABEL[target.kind]}
        </span>
        <RouteStatus state={liveness} />
      </div>
      {hint ? <span className="lw-share__route-hint">{hint}</span> : null}

      {/*
       * Above the field, not below it, and not on the button.
       *
       * The Copy button stays enabled on purpose. The tunnel being down is not
       * the server refusing (invariant 24 is about that, and this is not it) —
       * it is a machine that has not been told to start yet, and the person
       * reading this is usually the person who can start it. Disabling the
       * control would leave them with a panel that has stopped talking to them
       * about a link they are about to make valid. So: say it loudly, in the
       * reading order that puts it before the button, and let them decide.
       */}
      {liveness === "down" ? (
        <p className="lw-share__route-dead">
          Nothing answered at {target.origin}, so this link will not open for
          anyone you send it to. Start the tunnel with{" "}
          <code>./run.sh public</code> on the machine that hosts Lawha, then
          reopen this panel.
        </p>
      ) : null}

      <div className="lw-share__url-row">
        <input
          className="lw-input lw-mono lw-share__url"
          value={target.url}
          readOnly
          aria-label={name}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="lw-btn lw-btn--primary lw-share__copy"
          aria-label={copyNameFor(subject, target)}
          onClick={async () => {
            try {
              await copyTextToSystemClipboard(target.url);
              onCopy();
            } catch {
              // `navigator.clipboard` is absent on a plain-HTTP origin
              // (ADR 0018 measured exactly this), so a refusal here is
              // ordinary rather than exceptional. The field above is
              // selectable and holds the same string, which is why this is
              // recoverable rather than fatal.
              onCopyError?.("Could not copy. Select the link and copy it.");
            }
          }}
        >
          {copyStatus === "success" ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
};

export const ShareTargets = ({
  targets,
  subject,
  onCopyError,
}: {
  /** From `buildShareTargets`: `lan`, then any fallbacks, then `public`. */
  targets: readonly ShareTarget[];
  /** The noun in each row's accessible name — "Board link", "Invite link". */
  subject: string;
  onCopyError?: (message: string) => void;
}) => {
  const fallbacks = targets.filter((target) => target.kind === "lan-fallback");

  /**
   * Read here, once, and passed down.
   *
   * `shareOrigins.ts` refuses to touch a global at all, and for a good reason —
   * a `window.location` read in the link BUILDER is how "whoever shared decided
   * everyone else's route" got in. This read is a different question: not
   * "which address should they use" but "which address am *I* on", which is the
   * one thing the ambient origin genuinely answers. It is kept at this single
   * site rather than pushed into the hook so the rule stays easy to check —
   * one file in this directory reads `window`, and it is this line.
   */
  const pageOrigin = window.location.origin;

  const publicTarget = targets.find((target) => target.kind === "public");
  const hasLan = targets.some((target) => target.kind !== "public");
  // Only when both are on screen AND the public one is actually being probed:
  // a note explaining an asymmetry that is not visible is noise.
  const showsAsymmetry =
    hasLan && publicTarget !== undefined && publicTarget.origin !== pageOrigin;

  return (
    <div className="lw-share__routes">
      {targets
        .filter((target) => target.kind === "lan")
        .map((target) => (
          <ShareTargetRow
            key={target.origin}
            target={target}
            subject={subject}
            pageOrigin={pageOrigin}
            onCopyError={onCopyError}
          />
        ))}

      {/*
       * Collapsed, and directly under the address it is a fallback for.
       *
       * `lawha.local` is mDNS: it fails on some phones, on Windows without
       * Bonjour, and over a tailnet, and Chrome pins HTTPS upgrades on
       * `.local` names — both failures were hit on this deployment on
       * 2026-08-05. So the raw address has to be reachable. It is still not
       * the one to hand out first: an IP goes stale when the DHCP lease moves,
       * and a link that worked last week and 404s today is worse than one that
       * never resolved.
       */}
      {fallbacks.length > 0 ? (
        <details className="lw-share__routes-more">
          <summary>…or by IP, if that doesn&apos;t open</summary>
          {fallbacks.map((target) => (
            <ShareTargetRow
              key={target.origin}
              target={target}
              subject={subject}
              pageOrigin={pageOrigin}
              onCopyError={onCopyError}
            />
          ))}
        </details>
      ) : null}

      {targets
        .filter((target) => target.kind === "public")
        .map((target) => (
          <ShareTargetRow
            key={target.origin}
            target={target}
            subject={subject}
            pageOrigin={pageOrigin}
            onCopyError={onCopyError}
          />
        ))}

      {/*
       * The asymmetry, said out loud rather than left to be inferred.
       *
       * One route carries a dot and the others do not, and an unexplained
       * missing dot reads as "checked, and fine" — which is the failure this
       * whole feature exists to prevent, moved one row up. The reason is real:
       * whether a LAN address reaches the person being sent the link is a fact
       * about THEIR machine, and no probe run in this tab can answer it.
       */}
      {showsAsymmetry ? (
        <p className="lw-mono lw-share__note">
          only the outside address is checked — whether a network address
          reaches somebody depends on their machine, not this one
        </p>
      ) : null}
    </div>
  );
};
