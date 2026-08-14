import { useCallback, useEffect, useRef, useState } from "react";

import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Dragging boards onto folders.
 *
 * Built on pointer events rather than HTML5 drag and drop, which is what this
 * used to be. Four things were wrong with the native API here, and none of them
 * is fixable from inside it:
 *
 *  1. **`dragstart` does not fire from a touch.** Not "fires oddly" — does not
 *     exist. Half the ways into this product are a tablet, and on all of them
 *     the feature was simply absent, with nothing on screen admitting it.
 *  2. **There is no auto-scroll.** The browser will not scroll a list while a
 *     native drag is in progress, so a folder below the fold is unreachable:
 *     you can pick a board up and have nowhere to put it.
 *  3. **The drag image is the browser's.** A half-transparent snapshot of a
 *     220px card, cropped by the viewport, is not a useful thing to be holding
 *     when the question is "which folder am I over".
 *  4. **A drag starting inside a `<button>`** — which the card's whole preview
 *     is — is honoured by some browsers and swallowed by others.
 *
 * Pointer events cost more code and answer all four. They also make the
 * jsdom-shaped scar tissue unnecessary: the old version wrapped every
 * `dataTransfer` write in try/catch because `effectAllowed` is a read-only
 * accessor there and assigning to it threw, aborting the drag.
 *
 * **Drag is still an accelerator, never the mechanism.** There is no keyboard
 * gesture for this and there is not going to be one, so every move it enables is
 * also reachable from "Move to folder…" in the selection bar. If the two ever
 * diverge, the pointer-only path is the one that is wrong.
 */

/**
 * Where a drop can land: a folder id, or `null` for the top level.
 *
 * `null` is reachable only by a *folder* drag, onto the tail of the sidebar —
 * un-nesting a folder has no other gesture. There is no board target for it:
 * taking a board out of a folder is "Remove from folder" in the selection bar,
 * which is the path a keyboard can reach.
 */
export type DropTarget = string | null;

/** What is being dragged. Targets accept one kind or the other, never both. */
export type DragKind = "board" | "folder";

/** Sentinel for the top level, which needs a key no folder id can collide with. */
const TOP_LEVEL_KEY = " top-level";

const keyOf = (target: DropTarget): string =>
  target === null ? TOP_LEVEL_KEY : target;

/**
 * How far the pointer must travel before this becomes a drag.
 *
 * Without it, every click on a card is a zero-distance drag that swallows the
 * click, and the board never opens. Five pixels is below the threshold of a
 * deliberate movement and above the jitter of a firm tap.
 */
const DRAG_THRESHOLD_PX = 5;

/**
 * How long a touch must rest before it becomes a drag.
 *
 * A touch that moves immediately is a scroll — the page is taller than the
 * screen and flicking it is the commonest thing anyone does here. Waiting
 * distinguishes the two without asking the user to aim at a handle.
 */
const TOUCH_HOLD_MS = 400;

/** Movement that cancels a pending touch-hold, because it is a scroll. */
const TOUCH_HOLD_SLOP_PX = 8;

/** How close to an edge of the scroller before it starts moving. */
const AUTOSCROLL_EDGE_PX = 72;

/** Pixels per frame at the very edge; scaled down with distance. */
const AUTOSCROLL_MAX_PX = 16;

/** Marks a drop target in the DOM, so hit-testing needs no ref registry. */
const DROP_ATTR = "data-lw-drop";

/**
 * Which kinds of drag a target can take, space-separated.
 *
 * A *static* description of the target, deliberately, and this took one attempt
 * to get wrong. It was a boolean the caller computed from the live drag — and
 * the first `pointermove` both starts the drag and hit-tests, so React had not
 * re-rendered yet and every target still carried the value it had while nothing
 * was dragging. A flick that picked up and dropped in one movement landed
 * nowhere, silently.
 *
 * Anything that depends on *which* board or folder is in the air — the cycle
 * rule, mostly — goes through `canDrop`, which is called with live values at
 * hit-test time rather than read off the DOM.
 */
const KINDS_ATTR = "data-lw-drop-kinds";

export interface BoardDrag {
  /** The boards or folders being dragged right now. Empty when nothing is. */
  ids: readonly string[];
  /** Which of the two is in the air, or `null` when nothing is. */
  kind: DragKind | null;
  isDragging: boolean;
  /** Props for a draggable board card or row. */
  boardProps: (boardId: string) => {
    onPointerDown: (event: ReactPointerEvent) => void;
  };
  /**
   * Props for a draggable folder row.
   *
   * A folder drags alone, never with the board selection: the two live in
   * different columns and picking three boards then dragging a folder plainly
   * means the folder.
   */
  folderProps: (folderId: string) => {
    onPointerDown: (event: ReactPointerEvent) => void;
  };
  /**
   * Props for anything a drag can be dropped onto.
   *
   * `kinds` says what this surface is for, once, and does not change with the
   * drag in flight: a folder row takes both, the sidebar's top-level tail takes
   * only folders, and the crumb for the folder you are already standing in
   * takes neither. An empty list still marks the element, so a drop over it is
   * refused here rather than falling through to whatever is behind it.
   */
  targetProps: (
    target: DropTarget,
    kinds?: readonly DragKind[],
  ) => Record<string, string>;
  /** True while the pointer is over this target with a droppable drag. */
  isOver: (target: DropTarget) => boolean;
  /**
   * Attach to the floating ghost element.
   *
   * The ghost is moved by writing `transform` on this node directly, sixty
   * times a second, rather than by putting the coordinates in React state.
   * A grid of two hundred cards re-rendering on every pointer move is the
   * difference between a drag that glides and one that stutters, and none of
   * those cards has anything to say about where the pointer is.
   */
  ghostRef: (node: HTMLElement | null) => void;
}

export interface UseBoardDragOptions {
  /**
   * The current selection.
   *
   * Dragging a card that is *inside* a selection drags the whole selection —
   * picking three boards and then dragging one of them obviously means all
   * three, and moving only the one under the cursor would silently discard the
   * other two choices. Dragging a card outside the selection drags just it, and
   * leaves the selection alone.
   */
  selected: ReadonlySet<string>;
  onDrop: (kind: DragKind, target: DropTarget, ids: readonly string[]) => void;
  /**
   * The refusals that depend on what is in the air, checked at hit-test time.
   *
   * Only one rule needs this today — a folder cannot be dropped into itself or
   * its own subtree — but it is the rule that cannot be a static attribute, and
   * invariant 24 says the client must know what the server will refuse: a drop
   * that is going to come back 409 must never light up as a target.
   */
  canDrop?: (
    kind: DragKind,
    target: DropTarget,
    ids: readonly string[],
  ) => boolean;
}

interface LiveDrag {
  pointerId: number;
  kind: DragKind;
  startX: number;
  startY: number;
  /** Cleared once the threshold (or the hold) is passed. */
  pending: boolean;
  holdTimer: ReturnType<typeof setTimeout> | null;
  ids: readonly string[];
  /** The *key* of the target under the pointer, or null for none. */
  over: string | null;
  frame: number | null;
  scrollBy: number;
  scroller: Element | null;
}

/** The nearest ancestor that can actually scroll vertically, or the page. */
const scrollerFor = (node: Element | null): Element | null => {
  let current: Element | null = node;

  while (current && current !== document.body) {
    const { overflowY } = window.getComputedStyle(current);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }

  return document.scrollingElement;
};

export const useBoardDrag = ({
  selected,
  onDrop,
  canDrop,
}: UseBoardDragOptions): BoardDrag => {
  const [ids, setIds] = useState<readonly string[]>([]);
  const [kind, setKind] = useState<DragKind | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // Read inside the pointer handlers without making every card's props change
  // identity whenever the selection does — a grid of two hundred cards
  // re-rendering on every checkbox is a real cost for no benefit.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const canDropRef = useRef(canDrop);
  canDropRef.current = canDrop;

  const live = useRef<LiveDrag | null>(null);
  const ghost = useRef<HTMLElement | null>(null);

  const moveGhost = useCallback((x: number, y: number) => {
    if (ghost.current) {
      // `translate3d` so the ghost gets its own layer and the browser is not
      // repainting the grid underneath it on every frame.
      ghost.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
  }, []);

  const stop = useCallback(() => {
    const drag = live.current;
    live.current = null;

    if (drag?.holdTimer) {
      clearTimeout(drag.holdTimer);
    }
    if (drag?.frame !== null && drag?.frame !== undefined) {
      cancelAnimationFrame(drag.frame);
    }

    document.body.classList.remove("lw-dragging");
    setIds([]);
    setKind(null);
    setOver(null);
  }, []);

  /**
   * Scrolls while the pointer is held near an edge.
   *
   * Runs off `requestAnimationFrame` rather than the pointer stream on purpose:
   * holding still at the edge of the list has to keep scrolling, and pointer
   * events stop arriving the moment the pointer stops moving.
   */
  const tick = useCallback(() => {
    const drag = live.current;
    if (!drag) {
      return;
    }
    if (drag.scrollBy !== 0 && drag.scroller) {
      drag.scroller.scrollTop += drag.scrollBy;
    }
    drag.frame = requestAnimationFrame(tick);
  }, []);

  const begin = useCallback(
    (drag: LiveDrag, x: number, y: number) => {
      drag.pending = false;
      // The class exists for one reason: `touch-action: none` has to be in
      // force *before* the browser decides a touch is a scroll, and by the time
      // a drag has started it very nearly has. The `touchmove` listener below
      // is the belt to this braces.
      document.body.classList.add("lw-dragging");
      moveGhost(x, y);
      setIds(drag.ids);
      setKind(drag.kind);
      drag.frame = requestAnimationFrame(tick);
    },
    [moveGhost, tick],
  );

  useEffect(() => {
    const hitTest = (drag: LiveDrag, x: number, y: number): string | null => {
      const under = document.elementFromPoint(x, y);
      const zone = under?.closest(`[${DROP_ATTR}]`);

      if (!zone) {
        return null;
      }

      const kinds = (zone.getAttribute(KINDS_ATTR) ?? "").split(" ");
      if (!kinds.includes(drag.kind)) {
        return null;
      }

      const key = zone.getAttribute(DROP_ATTR);
      if (key === null) {
        return null;
      }

      const target = key === TOP_LEVEL_KEY ? null : key;
      return canDropRef.current?.(drag.kind, target, drag.ids) === false
        ? null
        : key;
    };

    const onMove = (event: PointerEvent) => {
      const drag = live.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;

      if (drag.pending) {
        const far = Math.hypot(dx, dy);

        // A touch that moves before the hold expires is a scroll, and taking it
        // for a drag would make the page impossible to move with a finger.
        if (drag.holdTimer) {
          if (far > TOUCH_HOLD_SLOP_PX) {
            stop();
          }
          return;
        }
        if (far < DRAG_THRESHOLD_PX) {
          return;
        }
        begin(drag, event.clientX, event.clientY);
      }

      moveGhost(event.clientX, event.clientY);

      const target = hitTest(drag, event.clientX, event.clientY);
      if (target !== drag.over) {
        drag.over = target;
        setOver(target);
      }

      // Auto-scroll. Measured against the scroller under the pointer rather
      // than a remembered one, because the sidebar and the grid scroll
      // separately and the drag crosses between them.
      const scroller = scrollerFor(
        document.elementFromPoint(event.clientX, event.clientY),
      );
      drag.scroller = scroller;

      // A plain pair rather than a `DOMRect`: the viewport case has no element
      // to measure, and constructing one only to read two numbers off it drags
      // in a class jsdom has been known not to expose.
      const box =
        scroller && scroller !== document.scrollingElement
          ? scroller.getBoundingClientRect()
          : { top: 0, bottom: window.innerHeight };

      const fromTop = event.clientY - box.top;
      const fromBottom = box.bottom - event.clientY;

      if (fromTop < AUTOSCROLL_EDGE_PX) {
        drag.scrollBy =
          -AUTOSCROLL_MAX_PX * (1 - Math.max(0, fromTop) / AUTOSCROLL_EDGE_PX);
      } else if (fromBottom < AUTOSCROLL_EDGE_PX) {
        drag.scrollBy =
          AUTOSCROLL_MAX_PX *
          (1 - Math.max(0, fromBottom) / AUTOSCROLL_EDGE_PX);
      } else {
        drag.scrollBy = 0;
      }
    };

    const onUp = (event: PointerEvent) => {
      const drag = live.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }

      // Never moved far enough to be a drag: this was a click, and the card's
      // own handlers are about to deal with it. Bail without touching anything.
      if (drag.pending) {
        stop();
        return;
      }

      const key = drag.over;
      const dragged = drag.ids;
      const dragKind = drag.kind;
      stop();

      if (key !== null) {
        onDropRef.current(
          dragKind,
          key === TOP_LEVEL_KEY ? null : key,
          dragged,
        );
      }
    };

    const onCancel = () => {
      if (live.current) {
        stop();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && live.current) {
        stop();
      }
    };

    // Non-passive so it can actually refuse. A passive listener may not call
    // `preventDefault`, and without it the browser scrolls the page under a
    // finger that is dragging a board.
    const onTouchMove = (event: TouchEvent) => {
      if (live.current && !live.current.pending) {
        event.preventDefault();
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("touchmove", onTouchMove, { passive: false });

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("touchmove", onTouchMove);
    };
  }, [begin, moveGhost, stop]);

  // Nothing is dragging once this hook goes away, and a left-behind body class
  // would freeze touch scrolling for the whole app.
  useEffect(() => () => document.body.classList.remove("lw-dragging"), []);

  const arm = useCallback(
    (dragKind: DragKind, ids: readonly string[], event: ReactPointerEvent) => {
      // Left button only, and never from a control that has its own meaning:
      // the select checkbox, a rename field, a role picker. Those are targets
      // in their own right and stealing their pointer would make them unusable.
      if (event.button !== 0 || live.current) {
        return;
      }
      if (
        (event.target as HTMLElement).closest(
          "input, textarea, select, [data-lw-no-drag]",
        )
      ) {
        return;
      }

      const drag: LiveDrag = {
        pointerId: event.pointerId,
        kind: dragKind,
        startX: event.clientX,
        startY: event.clientY,
        pending: true,
        holdTimer: null,
        ids,
        over: null,
        frame: null,
        scrollBy: 0,
        scroller: null,
      };

      if (event.pointerType === "touch") {
        const { clientX, clientY } = event;
        drag.holdTimer = setTimeout(() => {
          if (live.current === drag) {
            drag.holdTimer = null;
            begin(drag, clientX, clientY);
          }
        }, TOUCH_HOLD_MS);
      }

      live.current = drag;
    },
    [begin],
  );

  const boardProps = useCallback(
    (boardId: string) => ({
      onPointerDown: (event: ReactPointerEvent) => {
        const current = selectedRef.current;
        arm("board", current.has(boardId) ? [...current] : [boardId], event);
      },
    }),
    [arm],
  );

  const folderProps = useCallback(
    (folderId: string) => ({
      onPointerDown: (event: ReactPointerEvent) =>
        arm("folder", [folderId], event),
    }),
    [arm],
  );

  const targetProps = useCallback(
    (target: DropTarget, kinds: readonly DragKind[] = ["board"]) => ({
      [DROP_ATTR]: keyOf(target),
      [KINDS_ATTR]: kinds.join(" "),
    }),
    [],
  );

  const isOver = useCallback(
    (target: DropTarget) => over === keyOf(target),
    [over],
  );

  const ghostRef = useCallback((node: HTMLElement | null) => {
    ghost.current = node;
  }, []);

  return {
    ids,
    kind,
    isDragging: ids.length > 0,
    boardProps,
    folderProps,
    targetProps,
    isOver,
    ghostRef,
  };
};
