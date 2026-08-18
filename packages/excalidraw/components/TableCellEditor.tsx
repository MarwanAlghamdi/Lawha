import { useEffect, useRef } from "react";

import {
  FONT_FAMILY,
  getFontFamilyString,
  isTransparent,
  sceneCoordsToViewportCoords,
} from "@excalidraw/common";
import { pointFrom, pointRotateRads } from "@excalidraw/math";
import {
  CELL_PADDING,
  DEFAULT_CELL_FONT_SIZE,
  getCell,
  getCellRect,
  nextCell,
  tableColCount,
  tableRowCount,
  withCell,
} from "@excalidraw/element";

import type { Radians } from "@excalidraw/math";
import type { ExcalidrawTableElement } from "@excalidraw/element/types";

import type { AppState } from "../types";

/**
 * LAWHA: the text editor for one table cell.
 *
 * Modelled on frame-name editing rather than on `textWysiwyg`: a real DOM
 * input in the App tree, positioned over the cell and writing straight into
 * the table element on every keystroke. `textWysiwyg` is built around a bound
 * *text element*, and cell text is not one — `getBoundTextElementId` uses
 * `.find()`, so a container can hold exactly one label, and a nine-cell table
 * would need nine containers. Plain strings on the element sidestep that
 * entirely, and survive collab and export for free.
 */

interface TableCellEditorProps {
  element: ExcalidrawTableElement;
  appState: AppState;
  onChange: (element: ExcalidrawTableElement, text: string) => void;
  /** Move the caret to another cell, or leave the editor when null. */
  onNavigate: (next: { row: number; col: number } | null) => void;
}

export const TableCellEditor = ({
  element,
  appState,
  onChange,
  onNavigate,
}: TableCellEditorProps) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const cell = appState.editingTableElement?.activeCell ?? null;

  useEffect(() => {
    // Re-focus when the caret moves between cells, not only on mount — Tab
    // unmounts nothing, it just points the editor at a different cell.
    const node = ref.current;
    if (node) {
      node.focus();
      node.select();
    }
  }, [cell?.row, cell?.col]);

  if (!cell) {
    return null;
  }

  const rows = tableRowCount(element);
  const cols = tableColCount(element);

  if (cell.row >= rows || cell.col >= cols) {
    return null;
  }

  const rect = getCellRect(element, cell.row, cell.col);
  const zoom = appState.zoom.value;

  // The cell's centre in scene space, rotated with the element so the editor
  // sits on the cell rather than beside it on a rotated table.
  const centre = pointRotateRads(
    pointFrom(
      element.x + rect.x + rect.width / 2,
      element.y + rect.y + rect.height / 2,
    ),
    pointFrom(element.x + element.width / 2, element.y + element.height / 2),
    element.angle as Radians,
  );
  const { x: viewX, y: viewY } = sceneCoordsToViewportCoords(
    { sceneX: centre[0], sceneY: centre[1] },
    appState,
  );

  const isMatrix = element.variant === "matrix";
  const isHeader = element.headerRow && cell.row === 0;
  const value = getCell(element, cell.row, cell.col)?.text ?? "";
  const fill = getCell(element, cell.row, cell.col)?.fill;
  const background =
    fill && !isTransparent(fill)
      ? fill
      : isHeader && !isTransparent(element.backgroundColor)
      ? element.backgroundColor
      : appState.viewBackgroundColor;

  return (
    <textarea
      ref={ref}
      className="excalidraw-table-cell-editor"
      value={value}
      aria-label={`Cell, row ${cell.row + 1}, column ${cell.col + 1}`}
      onChange={(event) => onChange(element, event.target.value)}
      onBlur={() => onNavigate(null)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onNavigate(null);
          return;
        }
        // Enter commits and drops down a row, as a spreadsheet does;
        // Shift+Enter is the way to get an actual newline into a cell.
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onNavigate(
            cell.row + 1 < rows ? { row: cell.row + 1, col: cell.col } : null,
          );
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          onNavigate(
            nextCell(element, cell, event.shiftKey ? "ShiftTab" : "Tab"),
          );
        }
      }}
      style={{
        position: "absolute",
        left: `${viewX - appState.offsetLeft}px`,
        top: `${viewY - appState.offsetTop}px`,
        width: `${rect.width * zoom}px`,
        height: `${rect.height * zoom}px`,
        transform: `translate(-50%, -50%) rotate(${element.angle}rad)`,
        margin: 0,
        padding: `${CELL_PADDING * zoom}px`,
        border: "none",
        outline: "2px solid var(--color-primary)",
        outlineOffset: "-1px",
        borderRadius: 0,
        resize: "none",
        overflow: "hidden",
        boxSizing: "border-box",
        background,
        color: element.strokeColor,
        fontFamily: getFontFamilyString({
          fontFamily: isMatrix ? FONT_FAMILY.Cascadia : FONT_FAMILY.Excalifont,
        }),
        fontSize: `${DEFAULT_CELL_FONT_SIZE * zoom}px`,
        fontWeight: isHeader ? "bold" : "normal",
        lineHeight: 1.25,
        textAlign: isMatrix ? "right" : "left",
        zIndex: 2,
      }}
      dir="auto"
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
    />
  );
};

/** The scene-level edit: replace one cell's text, leaving its fill alone. */
export const setCellText = (
  element: ExcalidrawTableElement,
  cell: { row: number; col: number },
  text: string,
) => withCell(element, cell.row, cell.col, { text });
