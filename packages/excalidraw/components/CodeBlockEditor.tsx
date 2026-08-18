import { useEffect, useRef } from "react";

import {
  FONT_FAMILY,
  getFontFamilyString,
  sceneCoordsToViewportCoords,
} from "@excalidraw/common";
import { pointFrom, pointRotateRads } from "@excalidraw/math";
import {
  CODE_FONT_SIZE,
  CODE_HEADER_HEIGHT,
  CODE_LINE_HEIGHT,
  CODE_PAD_X,
  CODE_PAD_Y,
  CODE_THEME,
} from "@excalidraw/element";

import type { Radians } from "@excalidraw/math";
import type { ExcalidrawCodeElement } from "@excalidraw/element/types";

import type { AppState } from "../types";

/**
 * LAWHA: edit a code block's source in place.
 *
 * Double-clicking a code block used to enter image-crop mode, because a code
 * block used to *be* an image. Now that it is its own type, a double-click can
 * mean the only thing it should ever have meant.
 *
 * The textarea is styled to match the rendered block exactly — same palette,
 * same monospace face, same metrics — so editing looks like typing on the
 * block rather than like a dialog opening over it. Syntax colour is the one
 * thing that drops away while editing; re-highlighting per keystroke would
 * cost more than it is worth, and the colours return the moment you leave.
 */

interface CodeBlockEditorProps {
  element: ExcalidrawCodeElement;
  appState: AppState;
  onChange: (element: ExcalidrawCodeElement, source: string) => void;
  onClose: () => void;
}

export const CodeBlockEditor = ({
  element,
  appState,
  onChange,
  onClose,
}: CodeBlockEditorProps) => {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    // Caret at the end rather than selecting the whole snippet: you almost
    // always mean to add a line, not to replace the file.
    const length = ref.current?.value.length ?? 0;
    ref.current?.setSelectionRange(length, length);
  }, []);

  const zoom = appState.zoom.value;
  const centre = pointRotateRads(
    pointFrom(
      element.x + element.width / 2,
      element.y + (CODE_HEADER_HEIGHT + element.height) / 2,
    ),
    pointFrom(element.x + element.width / 2, element.y + element.height / 2),
    element.angle as Radians,
  );
  const { x: viewX, y: viewY } = sceneCoordsToViewportCoords(
    { sceneX: centre[0], sceneY: centre[1] },
    appState,
  );

  return (
    <textarea
      ref={ref}
      className="excalidraw-code-editor"
      value={element.source}
      aria-label={`Code block source, ${
        element.language === "auto"
          ? "language detected automatically"
          : element.language
      }`}
      onChange={(event) => onChange(element, event.target.value)}
      onBlur={onClose}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        // Tab indents rather than leaving the field. Without this a code
        // editor is unusable, and the escape hatch is Escape, which is right
        // above it on every keyboard.
        if (event.key === "Tab") {
          event.preventDefault();
          const node = event.currentTarget;
          const { selectionStart, selectionEnd, value } = node;
          onChange(
            element,
            `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`,
          );
          requestAnimationFrame(() => {
            node.setSelectionRange(selectionStart + 2, selectionStart + 2);
          });
        }
      }}
      style={{
        position: "absolute",
        left: `${viewX - appState.offsetLeft}px`,
        top: `${viewY - appState.offsetTop}px`,
        width: `${element.width * zoom}px`,
        height: `${(element.height - CODE_HEADER_HEIGHT) * zoom}px`,
        transform: `translate(-50%, -50%) rotate(${element.angle}rad)`,
        margin: 0,
        padding: `${CODE_PAD_Y * zoom}px ${CODE_PAD_X * zoom}px`,
        border: "none",
        outline: `${Math.max(1, zoom)}px solid var(--color-primary)`,
        borderRadius: 0,
        resize: "none",
        boxSizing: "border-box",
        background: CODE_THEME.background,
        color: CODE_THEME.text,
        caretColor: CODE_THEME.text,
        fontFamily: getFontFamilyString({ fontFamily: FONT_FAMILY.Cascadia }),
        fontSize: `${CODE_FONT_SIZE * zoom}px`,
        lineHeight: `${CODE_LINE_HEIGHT * zoom}px`,
        whiteSpace: "pre",
        overflow: "auto",
        zIndex: 2,
      }}
      dir="ltr"
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
    />
  );
};
