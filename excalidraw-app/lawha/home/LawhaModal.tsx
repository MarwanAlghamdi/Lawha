import { useCallback, useEffect, useId, useRef } from "react";

import type { ReactNode } from "react";

interface LawhaModalProps {
  /** Rendered as the heading, and used as the dialog's accessible name. */
  title: string;
  /** One sentence under the heading. Becomes the accessible description. */
  description?: string;
  onClose: () => void;
  children: ReactNode;
  /** Widens the card for the import list. Default is the narrow one. */
  wide?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The dashboard's modal: a scrim and a centred card.
 *
 * Lawha's house rule is that surfaces live inside the app's own chrome, and on
 * the *canvas* that still holds — nothing here changes the editor. The
 * dashboard is a page rather than a canvas, and Import, Export and Tags are all
 * transient tasks with no place on it to live: each is a short form that is
 * finished and dismissed, and giving each one a permanent strip in the column
 * would push the boards themselves off the first screen. ADR 0007 records the
 * reversal so it is not discoverable only by reading a deleted comment.
 *
 * It is emphatically **not** a native dialog (invariant 19). `window.confirm`
 * blocks the renderer until dismissed, and everything below runs in the page.
 *
 * The keyboard contract, which is the part people skip:
 *
 *  - Escape closes, from anywhere inside.
 *  - Focus moves in on open and **returns to whatever opened it** on close.
 *    Without that, dismissing a modal drops focus onto `<body>` and a keyboard
 *    user restarts their tab journey at the top of the page.
 *  - Tab is trapped. `aria-modal` tells a screen reader the rest of the page is
 *    inert, and a trap is what makes that claim true for everyone else.
 */
export const LawhaModal = ({
  title,
  description,
  onClose,
  children,
  wide,
}: LawhaModalProps) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;

  const focusables = useCallback((): HTMLElement[] => {
    const card = cardRef.current;
    return card
      ? Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (node) =>
            node.offsetParent !== null || node === document.activeElement,
        )
      : [];
  }, []);

  useEffect(() => {
    returnTo.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // The first control, or the card itself when the modal opens onto a drop
    // zone with nothing tabbable ahead of it.
    const first = focusables()[0];
    (first ?? cardRef.current)?.focus();

    return () => {
      returnTo.current?.focus();
    };
  }, [focusables]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const nodes = focusables();
    if (nodes.length === 0) {
      event.preventDefault();
      return;
    }

    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === cardRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    // The scrim is a plain div with a click handler rather than a button: it
    // wraps the dialog, and a button cannot contain interactive content. The
    // keyboard route out is Escape, handled above, which is the one a keyboard
    // user reaches for anyway.
    <div
      className="lw-modal__scrim"
      onMouseDown={(event) => {
        // mousedown, not click: a click fires after a drag that *started*
        // inside the card and ended on the scrim — selecting text in the
        // dialog and releasing outside it would dismiss the dialog.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={cardRef}
        className={`lw-modal${wide ? " lw-modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="lw-modal__head">
          <h2 className="lw-modal__title" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className="lw-modal__description" id={descriptionId}>
              {description}
            </p>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
};
