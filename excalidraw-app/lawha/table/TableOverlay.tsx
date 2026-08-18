import { sceneCoordsToViewportCoords } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { CELL_BACKGROUND, HEADER_BACKGROUND } from "./tableBuild";
import {
  cellKey,
  columnElementIds,
  findTableIds,
  readCellTag,
  readTable,
  rowElementIds,
} from "./tableModel";
import {
  addColumn,
  addRow,
  deleteColumn,
  deleteRow,
  deleteTable,
  setCellFill,
  setHeaderRow,
} from "./tableOps";
import { snapAllTables, translateTable } from "./tableSnap";
import { CELL_FILLS, tableText } from "./tableText";

import "./TableOverlay.scss";

import type { TableModel } from "./tableModel";

interface TableOverlayProps {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  /**
   * The overlay is chrome, not enforcement. A viewer must not be offered a
   * handle whose action the server would refuse — invariant 24 asks us to guard
   * the funnel rather than let the refusal surface as a broken-looking product.
   */
  canEdit: boolean;
}

/** Only the parts of appState the overlay's geometry depends on. */
interface Viewport {
  zoom: { value: number };
  offsetLeft: number;
  offsetTop: number;
  scrollX: number;
  scrollY: number;
}

interface Snapshot {
  elements: readonly ExcalidrawElement[];
  viewport: Viewport;
  selectedIds: string[];
  /** Suppress the overlay while a drag or an edit is in flight. */
  busy: boolean;
}

const HANDLE = 14;

export const TableOverlay = ({ excalidrawAPI, canEdit }: TableOverlayProps) => {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const frame = useRef<number | null>(null);
  /** Pointer origin and last applied delta while the move bar is held. */
  const drag = useRef<{ x: number; y: number; tableId: string } | null>(null);

  /**
   * One subscription covers everything the overlay cares about: `onChange`
   * fires for appState too, so scroll and zoom arrive here as well as element
   * edits. Coalesced onto an animation frame — a pan fires this per pointer
   * move, and re-rendering a strip of handles that often is what makes an
   * overlay feel like it is dragging behind the canvas.
   */
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const unsubscribe = excalidrawAPI.onChange((elements, appState) => {
      if (frame.current !== null) {
        return;
      }
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setSnapshot({
          elements,
          viewport: {
            zoom: appState.zoom,
            offsetLeft: appState.offsetLeft,
            offsetTop: appState.offsetTop,
            scrollX: appState.scrollX,
            scrollY: appState.scrollY,
          },
          selectedIds: Object.keys(appState.selectedElementIds ?? {}),
          busy:
            appState.selectedElementsAreBeingDragged ||
            appState.isResizing ||
            appState.isRotating ||
            !!appState.editingTextElement ||
            !!appState.newElement,
        });
      });
    });
    return () => {
      unsubscribe();
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [excalidrawAPI]);

  /** The grid the selection is currently inside, if any. */
  const model: TableModel | null = useMemo(() => {
    if (!snapshot || snapshot.selectedIds.length === 0) {
      return null;
    }
    const selected = new Set(snapshot.selectedIds);
    for (const element of snapshot.elements) {
      if (!selected.has(element.id)) {
        continue;
      }
      const tag = readCellTag(element);
      if (tag) {
        return readTable(snapshot.elements, tag.tableId);
      }
    }
    return null;
  }, [snapshot]);

  /**
   * Scene coordinates to a position inside the editor container.
   *
   * `sceneCoordsToViewportCoords` returns page coordinates because it adds the
   * container's own offsets; the overlay is absolutely positioned *within* that
   * container, so those offsets come straight back off. Going through the
   * editor's own helper rather than reimplementing `(x + scrollX) * zoom` means
   * the overlay keeps following the canvas if upstream ever changes the formula.
   */
  const toLocal = useCallback(
    (sceneX: number, sceneY: number) => {
      const viewport = snapshot!.viewport;
      const { x, y } = sceneCoordsToViewportCoords(
        { sceneX, sceneY },
        viewport as Parameters<typeof sceneCoordsToViewportCoords>[1],
      );
      return { x: x - viewport.offsetLeft, y: y - viewport.offsetTop };
    },
    [snapshot],
  );

  /**
   * Every overlay action is one undo step.
   *
   * `captureUpdate` defaults to `CaptureUpdateAction.EVENTUALLY`, which folds
   * the change into some later increment — so adding a row and then pressing
   * Ctrl+Z undid whatever came next instead, and the row stayed. Anything a
   * person did on purpose has to be undoable on purpose.
   */
  const apply = useCallback(
    (next: ExcalidrawElement[]) => {
      excalidrawAPI?.updateScene({
        elements: next,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
    [excalidrawAPI],
  );

  /**
   * Select a row or column.
   *
   * Deliberately clears `selectedGroupIds`: selecting one column *within* a
   * table is the one case where the user does not mean the whole object, and
   * leaving the group selected would silently widen every following action back
   * out to all of it.
   */
  const select = useCallback(
    (ids: readonly string[]) => {
      excalidrawAPI?.updateScene({
        appState: {
          selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])),
          selectedGroupIds: {},
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
    [excalidrawAPI],
  );

  /**
   * Put a strayed cell back when a drag settles.
   *
   * Cells are ungrouped, so the editor will happily let one be dragged out of
   * its table. Rather than forbid that (which would mean fighting the editor's
   * own drag handling), the grid is restored the moment the pointer comes up —
   * one scene write, one undo step, and only when something actually moved.
   */
  useEffect(() => {
    if (!excalidrawAPI || !canEdit) {
      return;
    }
    return excalidrawAPI.onPointerUp(() => {
      const current = excalidrawAPI.getSceneElements();
      const snapped = snapAllTables(current);
      if (snapped !== current) {
        excalidrawAPI.updateScene({
          elements: snapped as ExcalidrawElement[],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      }
    });
  }, [excalidrawAPI, canEdit]);

  if (!snapshot || !model || !canEdit || snapshot.busy) {
    return null;
  }

  const zoom = snapshot.viewport.zoom.value;
  const origin = toLocal(model.bounds.x, model.bounds.y);
  const elements = snapshot.elements;
  const { tableId } = model;

  const selectedCells = snapshot.selectedIds
    .map((id) => elements.find((el) => el.id === id))
    .map((el) => (el ? readCellTag(el) : null))
    .filter(
      (tag): tag is NonNullable<typeof tag> => !!tag && tag.tableId === tableId,
    )
    .map((tag) => ({ row: tag.row, col: tag.col }));

  const headerOn = model.cells.get(cellKey(0, 0))?.tag.header === true;

  const columnHandles = [];
  for (let col = 0; col < model.cols; col++) {
    const cell = model.cells.get(cellKey(0, col));
    if (!cell) {
      continue;
    }
    const at = toLocal(cell.element.x, model.bounds.y);
    columnHandles.push(
      <button
        key={`col-${col}`}
        type="button"
        className="lw-table__handle lw-table__handle--col"
        style={{
          left: `${at.x}px`,
          top: `${origin.y - HANDLE - 2}px`,
          width: `${cell.element.width * zoom}px`,
          height: `${HANDLE}px`,
        }}
        title={tableText.selectColumn(col)}
        aria-label={tableText.selectColumn(col)}
        onClick={() => select(columnElementIds(model, col))}
      />,
    );
  }

  const rowHandles = [];
  for (let row = 0; row < model.rows; row++) {
    const cell = model.cells.get(cellKey(row, 0));
    if (!cell) {
      continue;
    }
    const at = toLocal(model.bounds.x, cell.element.y);
    rowHandles.push(
      <button
        key={`row-${row}`}
        type="button"
        className="lw-table__handle lw-table__handle--row"
        style={{
          left: `${origin.x - HANDLE - 2}px`,
          top: `${at.y}px`,
          width: `${HANDLE}px`,
          height: `${cell.element.height * zoom}px`,
        }}
        title={tableText.selectRow(row)}
        aria-label={tableText.selectRow(row)}
        onClick={() => select(rowElementIds(model, row))}
      />,
    );
  }

  /** Where an insert or delete lands, taken from the selection. */
  const focusRow = selectedCells.length ? selectedCells[0].row : model.rows - 1;
  const focusCol = selectedCells.length ? selectedCells[0].col : model.cols - 1;

  /**
   * Drag the whole table.
   *
   * This is what replaces grouping. Pointer deltas are viewport pixels, so they
   * are divided by the zoom to become scene units — otherwise the table would
   * lag behind the cursor at any zoom but 100%.
   *
   * Pointer capture rather than document listeners: the bar keeps receiving
   * moves even when the cursor outruns it, and the browser releases capture for
   * us if the pointer is cancelled.
   */
  const onBarPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, tableId };
  };

  const onBarPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || !excalidrawAPI) {
      return;
    }
    const dx = (event.clientX - state.x) / zoom;
    const dy = (event.clientY - state.y) / zoom;
    if (dx === 0 && dy === 0) {
      return;
    }
    drag.current = { ...state, x: event.clientX, y: event.clientY };
    excalidrawAPI.updateScene({
      elements: translateTable(
        excalidrawAPI.getSceneElements(),
        state.tableId,
        dx,
        dy,
      ),
      // Mid-drag frames are not individually undoable — one drag is one step,
      // captured when the pointer comes up.
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    });
  };

  const endBarDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) {
      return;
    }
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    excalidrawAPI?.updateScene({
      elements: excalidrawAPI.getSceneElements() as ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  return (
    <div className="lw-table" aria-label={tableText.overlayLabel}>
      {/*
        The move bar. Cells are ungrouped so the editor has no notion that they
        belong together — this is where "the table is one thing" actually lives.
      */}
      <div
        className="lw-table__move"
        style={{
          left: `${origin.x}px`,
          top: `${origin.y - HANDLE - 22}px`,
          width: `${model.bounds.width * zoom}px`,
        }}
        role="button"
        tabIndex={0}
        aria-label={tableText.moveTable}
        title={tableText.moveTable}
        data-testid="lawha-table-move"
        onPointerDown={onBarPointerDown}
        onPointerMove={onBarPointerMove}
        onPointerUp={endBarDrag}
        onPointerCancel={endBarDrag}
      />
      {columnHandles}
      {rowHandles}

      <div
        className="lw-table__bar"
        style={{
          left: `${origin.x}px`,
          top: `${origin.y + model.bounds.height * zoom + 10}px`,
        }}
      >
        <div
          className="lw-table__fills"
          role="group"
          aria-label={tableText.fill}
        >
          {CELL_FILLS.map((fill) => (
            <button
              key={fill.value}
              type="button"
              className="lw-table__fill"
              style={{
                background:
                  fill.value === "transparent" ? undefined : fill.value,
              }}
              data-clear={fill.value === "transparent" || undefined}
              title={fill.label}
              aria-label={fill.label}
              disabled={selectedCells.length === 0}
              onClick={() =>
                apply(setCellFill(elements, tableId, selectedCells, fill.value))
              }
            />
          ))}
        </div>

        <span className="lw-table__sep" aria-hidden="true" />

        <button
          type="button"
          onClick={() => apply(addRow(elements, tableId, focusRow))}
        >
          {tableText.addRowAbove}
        </button>
        <button
          type="button"
          onClick={() => apply(addRow(elements, tableId, focusRow + 1))}
        >
          {tableText.addRowBelow}
        </button>
        <button
          type="button"
          onClick={() => apply(addColumn(elements, tableId, focusCol))}
        >
          {tableText.addColumnBefore}
        </button>
        <button
          type="button"
          onClick={() => apply(addColumn(elements, tableId, focusCol + 1))}
        >
          {tableText.addColumnAfter}
        </button>

        <span className="lw-table__sep" aria-hidden="true" />

        <button
          type="button"
          disabled={model.rows <= 1}
          title={model.rows <= 1 ? tableText.lastRow : undefined}
          onClick={() => apply(deleteRow(elements, tableId, focusRow))}
        >
          {tableText.deleteRow}
        </button>
        <button
          type="button"
          disabled={model.cols <= 1}
          title={model.cols <= 1 ? tableText.lastColumn : undefined}
          onClick={() => apply(deleteColumn(elements, tableId, focusCol))}
        >
          {tableText.deleteColumn}
        </button>

        <span className="lw-table__sep" aria-hidden="true" />

        <label className="lw-table__toggle">
          <input
            type="checkbox"
            checked={headerOn}
            onChange={(event) =>
              apply(
                setHeaderRow(
                  elements,
                  tableId,
                  event.target.checked,
                  HEADER_BACKGROUND,
                  CELL_BACKGROUND,
                ),
              )
            }
          />
          {tableText.toggleHeader}
        </label>

        <button
          type="button"
          className="lw-table__danger"
          onClick={() => apply(deleteTable(elements, tableId))}
        >
          {tableText.deleteTable}
        </button>
      </div>
    </div>
  );
};

/** Whether the scene contains any grid at all — for cheap conditional mounting. */
export const hasTables = (elements: readonly ExcalidrawElement[]) =>
  findTableIds(elements).length > 0;
