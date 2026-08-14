import { useEffect, useState } from "react";

export type LawhaSaveState =
  | "saved"
  | "saving"
  | "offline"
  | "error"
  /**
   * Nothing of yours is being saved, because you cannot write to this board.
   *
   * A viewer, a link visitor, and — since ADR 0012 — anyone on a board whose
   * scene could not be read all saw a green "Saved". It was true in the narrow
   * sense that no write had failed, and false in the sense a person reads it:
   * that their work is safe on a board they are not writing to. On the
   * unreadable board it was worse than useless, since the thing being reported
   * as saved was a canvas that had failed to load.
   */
  | "read-only";

interface LawhaSaveStatusProps {
  state: LawhaSaveState;
  /** When the last successful save landed. */
  savedAt: number | null;
  compact?: boolean;
}

const relativeTime = (from: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 5) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  return `${Math.round(minutes / 60)}h ago`;
};

const LABELS: Record<LawhaSaveState, string> = {
  saved: "Saved",
  saving: "Saving",
  offline: "Offline",
  error: "Not saved",
  "read-only": "Read-only",
};

const COLORS: Record<LawhaSaveState, string> = {
  saved: "var(--lw-presence-1)",
  saving: "var(--lw-presence-4)",
  offline: "var(--lw-muted3)",
  error: "var(--lw-danger)",
  // Muted rather than green or red: read-only is a statement of fact, not a
  // success and not a fault.
  "read-only": "var(--lw-muted3)",
};

/**
 * Whether the user's work is safe, and when it last was.
 *
 * Worth stating plainly rather than hiding: while collaborating, local storage
 * is paused, so the server copy is the only durable one. The relative timestamp
 * is the user's evidence of that.
 */
export const LawhaSaveStatus = ({
  state,
  savedAt,
  compact,
}: LawhaSaveStatusProps) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (state !== "saved" || savedAt === null) {
      return;
    }
    // Only the label needs to age; a slow tick is enough and keeps this off
    // the render-hot path.
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [state, savedAt]);

  const detail =
    state === "saved" && savedAt !== null
      ? ` · ${relativeTime(savedAt, now)}`
      : "";

  return (
    <div
      className="lw-pill lw-save-status"
      role="status"
      aria-live="polite"
      title={`${LABELS[state]}${detail}`}
    >
      <span
        className={`lw-dot${state === "saving" ? " lw-dot--pulse" : ""}`}
        style={{ background: COLORS[state] }}
      />
      {compact ? (
        <span className="lw-visually-hidden">{LABELS[state]}</span>
      ) : (
        <span className="lw-mono">
          {LABELS[state]}
          {detail}
        </span>
      )}
    </div>
  );
};
