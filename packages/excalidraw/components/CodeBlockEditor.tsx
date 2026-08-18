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
  CODE_GUTTER_GAP,
  CODE_THEME,
  codeFontString,
  codeGutterWidth,
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
  // Indent by the gutter, so the code sits at the same x whether it is being
  // drawn or typed. Without this the whole snippet jumps sideways the moment
  // you double-click it, which reads as the block having moved.
  const gutter = measureGutter(element.source, element.showLineNumbers);
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

  const lineCount = element.source.split("\n").length;
  const boxStyle = {
    left: `${viewX - appState.offsetLeft}px`,
    top: `${viewY - appState.offsetTop}px`,
    width: `${element.width * zoom}px`,
    height: `${(element.height - CODE_HEADER_HEIGHT) * zoom}px`,
    transform: `translate(-50%, -50%) rotate(${element.angle}rad)`,
    fontFamily: getFontFamilyString({ fontFamily: FONT_FAMILY.Cascadia }),
    fontSize: `${element.fontSize * zoom}px`,
    lineHeight: `${
      CODE_LINE_HEIGHT * (element.fontSize / CODE_FONT_SIZE) * zoom
    }px`,
  } as const;

  return (
    <>
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
          ...boxStyle,
          padding: `${CODE_PAD_Y * zoom}px ${CODE_PAD_X * zoom}px ${
            CODE_PAD_Y * zoom
          }px ${(CODE_PAD_X + gutter) * zoom}px`,
          background: CODE_THEME.background,
          color: CODE_THEME.text,
          caretColor: CODE_THEME.text,
        }}
        dir="ltr"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {element.showLineNumbers && (
        // The gutter is drawn on the canvas, which the textarea covers. Without
        // a DOM copy the line numbers vanished the moment you started typing
        // and came back when you stopped, which reads as the block flickering.
        <div
          className="excalidraw-code-editor-gutter"
          aria-hidden="true"
          style={{
            ...boxStyle,
            padding: `${CODE_PAD_Y * zoom}px ${CODE_GUTTER_GAP * zoom}px 0 0`,
            width: `${(CODE_PAD_X + gutter) * zoom}px`,
            // Both boxes are centred on the same point, so shifting the
            // gutter left by half the difference in width lines its left edge
            // up with the textarea's.
            transform: `translate(calc(-50% - ${
              ((element.width - CODE_PAD_X - gutter) / 2) * zoom
            }px), -50%) rotate(${element.angle}rad)`,
            color: CODE_THEME.gutter,
            background: CODE_THEME.background,
          }}
        >
          {Array.from({ length: lineCount }, (_, index) => (
            <div key={index}>{index + 1}</div>
          ))}
        </div>
      )}
    </>
  );
};

/**
 * The gutter width, measured with the real font rather than an assumed
 * character width — the same measurement the canvas renderer makes, so the two
 * agree on any machine.
 */
let measuringContext: CanvasRenderingContext2D | null = null;

const measureGutter = (source: string, showLineNumbers: boolean): number => {
  if (!showLineNumbers) {
    return 0;
  }
  if (!measuringContext) {
    measuringContext = document.createElement("canvas").getContext("2d");
  }
  if (!measuringContext) {
    return 0;
  }
  measuringContext.font = codeFontString();
  return codeGutterWidth(
    source.split("\n").length,
    showLineNumbers,
    measuringContext,
  );
};
