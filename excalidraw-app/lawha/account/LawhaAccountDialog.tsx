import { useEffect, useRef } from "react";

import { LawhaAccountPanel } from "./LawhaAccountPanel";

import "./LawhaAccount.scss";

interface LawhaAccountDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Mirrors `home/LawhaModal.tsx`'s `FOCUSABLE` — the elements Tab may land on. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Account settings, inside the canvas.
 *
 * The brief puts account settings in the consolidated UI rather than an
 * external page, so this renders as a child of `<Excalidraw>` — already inside
 * `.excalidraw-container` — and is positioned over it. No portal is needed and
 * none is wanted: portalling to document.body is exactly the "external panel"
 * the consolidation rules out.
 */
export const LawhaAccountDialog = ({
  open,
  onClose,
}: LawhaAccountDialogProps) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const focusables = (): HTMLElement[] => {
      const surface = surfaceRef.current;
      return surface
        ? Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
            (node) =>
              node.offsetParent !== null || node === document.activeElement,
          )
        : [];
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The editor listens for keys on the document (handleKeyboardGlobally),
        // so an un-stopped Escape here would also deselect on the canvas behind.
        event.stopPropagation();
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      // Trapped in this same capture-phase document listener rather than a
      // local onKeyDown like `home/LawhaModal.tsx` uses: this dialog floats
      // over the canvas, not the dashboard, and an untrapped Tab was free to
      // walk out into the editor's own toolbar and panels behind the scrim —
      // `aria-modal` claims they are inert, and nothing made that true.
      const nodes = focusables();
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }

      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement;

      if (
        event.shiftKey &&
        (active === first || active === surfaceRef.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Capture phase: the editor's own listeners are attached to document too,
    // and bubbling would let them run first.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // Whatever had focus before the dialog opened — ordinarily the account
    // button in the top bar — so it can have focus back on close. Without
    // this, closing dropped focus onto `<body>` and a keyboard user restarted
    // their tab journey from the top of the canvas.
    returnTo.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    surfaceRef.current?.focus();

    return () => {
      returnTo.current?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className="lw-account-dialog-scrim"
        aria-label="Close account settings"
        onClick={onClose}
      />
      <div className="lw-account-dialog">
        <div
          className="lw-account-dialog__surface"
          role="dialog"
          aria-modal="true"
          aria-label="Account settings"
          tabIndex={-1}
          ref={surfaceRef}
        >
          <div className="lw-account-dialog__header">
            <h2>Account</h2>
            <div className="lw-account-dialog__spacer" />
            <button
              type="button"
              className="lw-btn lw-btn--icon"
              onClick={onClose}
              aria-label="Close account settings"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>

          <LawhaAccountPanel onSignedOut={onClose} />
        </div>
      </div>
    </>
  );
};
