import React from "react";

import { KEYS } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  newCodeElement,
  newTableElement,
  newTensorElement,
} from "@excalidraw/element";

import type {
  ExcalidrawCodeElement,
  ExcalidrawTableElement,
  ExcalidrawTensorElement,
} from "@excalidraw/element/types";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard, Pointer } from "./helpers/ui";
import {
  fireEvent,
  GlobalTestState,
  render,
  unmountComponent,
} from "./test-utils";

const { h } = window;

const mouse = new Pointer("mouse");

/**
 * LAWHA: the three defects that motivated the native rewrite, pinned as tests.
 *
 * Each of these was reported against the old composed objects: cells that
 * overlapped when resized, anchors that could not be dragged, and a code block
 * that entered image cropping on double-click. Unit tests cover the maths
 * underneath; these cover the wiring, which is where the bugs actually were.
 */

const table = () => h.elements[0] as ExcalidrawTableElement;

type TableOverrides = Partial<Parameters<typeof newTableElement>[0]>;

const placeTable = (overrides: TableOverrides = {}): ExcalidrawTableElement => {
  const element = newTableElement({
    x: 100,
    y: 100,
    width: 300,
    height: 150,
    rows: 3,
    cols: 3,
    ...overrides,
  });
  // Through the store rather than `setElements`, so the snapshot knows about
  // the table and an undo of a later edit is an edit rather than a deletion.
  API.updateScene({
    elements: [element],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  API.setSelectedElements([element]);
  return element;
};

describe("lawha grid objects", () => {
  beforeEach(async () => {
    unmountComponent();
    mouse.reset();
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  describe("column resizing", () => {
    it("moves weight between neighbours without changing the outer width", () => {
      placeTable();
      const before = [...table().colWidths];

      // The divider between columns 0 and 1 sits at x = 100 + 300/3 = 200.
      mouse.downAt(200, 175);
      mouse.moveTo(240, 175);
      mouse.upAt(240, 175);

      const after = table().colWidths;
      expect(after[0]).toBeGreaterThan(before[0]!);
      expect(after[1]).toBeLessThan(before[1]!);
      // Untouched columns keep their share, and the total is still the width.
      expect(after[2]).toBeCloseTo(before[2]!, 10);
      expect(after.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      expect(table().width).toBe(300);
    });

    it("cannot drag a column past its neighbour into an overlap", () => {
      placeTable();

      // Far past column 1's right edge — twice the table's width.
      mouse.downAt(200, 175);
      mouse.moveTo(800, 175);
      mouse.upAt(800, 175);

      const after = table().colWidths;
      expect(after.every((fraction) => fraction > 0)).toBe(true);
      expect(after.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    });

    it("resizes rows through the horizontal dividers too", () => {
      placeTable();
      const before = [...table().rowHeights];

      // The divider between rows 0 and 1 sits at y = 100 + 150/3 = 150.
      mouse.downAt(250, 150);
      mouse.moveTo(250, 180);
      mouse.upAt(250, 180);

      expect(table().rowHeights[0]).toBeGreaterThan(before[0]!);
      expect(table().rowHeights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      expect(table().height).toBe(150);
    });

    it("leaves one undo step for the whole drag", () => {
      placeTable();
      const before = [...table().colWidths];

      mouse.downAt(200, 175);
      mouse.moveTo(220, 175);
      mouse.moveTo(240, 175);
      mouse.upAt(240, 175);

      expect(table().colWidths[0]).toBeGreaterThan(before[0]!);

      Keyboard.withModifierKeys({ ctrl: true }, () => {
        Keyboard.keyPress(KEYS.Z);
      });

      expect(table().colWidths[0]).toBeCloseTo(before[0]!, 10);
    });
  });

  describe("row and column anchors", () => {
    it("selects a whole column when its anchor is clicked", () => {
      placeTable();

      // The column anchor strip sits just above the table.
      mouse.downAt(150, 92);
      mouse.upAt(150, 92);

      expect(h.state.editingTableElement?.selection).toEqual({
        axis: "col",
        indices: [0],
      });
    });

    it("selects a whole row when its anchor is clicked", () => {
      placeTable();

      // The row anchor strip sits just left of the table.
      mouse.downAt(92, 125);
      mouse.upAt(92, 125);

      expect(h.state.editingTableElement?.selection).toEqual({
        axis: "row",
        indices: [0],
      });
    });

    it("reorders a column when its anchor is dragged onto another", () => {
      placeTable({
        cells: [
          [
            { text: "a", fill: null },
            { text: "b", fill: null },
            { text: "c", fill: null },
          ],
        ],
        rows: 1,
      });

      mouse.downAt(150, 92);
      mouse.moveTo(350, 92);
      mouse.upAt(350, 92);

      expect(table().cells[0]!.map((cell) => cell.text)).toEqual([
        "b",
        "c",
        "a",
      ]);
    });
  });

  describe("cell text editing", () => {
    it("opens an editor on the cell under a double-click", () => {
      placeTable();

      mouse.doubleClickAt(150, 125);

      expect(h.state.editingTableElement?.activeCell).toEqual({
        row: 0,
        col: 0,
      });
      expect(
        document.querySelector(".excalidraw-table-cell-editor"),
      ).not.toBeNull();
    });

    it("writes what is typed into that cell and no other", () => {
      placeTable();
      mouse.doubleClickAt(250, 175);

      const editor = document.querySelector<HTMLTextAreaElement>(
        ".excalidraw-table-cell-editor",
      )!;

      fireEvent.change(editor, { target: { value: "42" } });

      expect(table().cells[1]![1]!.text).toBe("42");
      expect(table().cells[0]![0]!.text).toBe("");
    });

    it("closes the editor when the table is deselected", () => {
      placeTable();
      mouse.doubleClickAt(150, 125);
      expect(
        document.querySelector(".excalidraw-table-cell-editor"),
      ).not.toBeNull();

      API.setSelectedElements([]);

      expect(
        document.querySelector(".excalidraw-table-cell-editor"),
      ).toBeNull();
    });
  });

  describe("tensors", () => {
    const placeTensor = () => {
      const element = newTensorElement({
        x: 100,
        y: 100,
        width: 240,
        height: 180,
        dims: [64, 32, 32],
      });
      API.updateScene({
        elements: [element],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      API.setSelectedElements([element]);
      return element;
    };

    it("edits its shape on double-click rather than stapling on a text label", () => {
      placeTensor();

      mouse.doubleClickAt(220, 190);

      expect(h.state.editingLawhaElementId).toBe(h.elements[0].id);
      expect(
        document.querySelector(".excalidraw-tensor-dims-editor"),
      ).not.toBeNull();
      // no loose text element was created alongside it
      expect(h.elements.filter((el) => el.type === "text")).toHaveLength(0);
    });

    it("writes a typed shape back onto the one element", () => {
      placeTensor();
      mouse.doubleClickAt(220, 190);

      const editor = document.querySelector<HTMLInputElement>(
        ".excalidraw-tensor-dims-editor",
      )!;
      fireEvent.change(editor, { target: { value: "128 x 16 x 8" } });
      fireEvent.keyDown(editor, { key: "Enter" });

      expect((h.elements[0] as ExcalidrawTensorElement).dims).toEqual([
        128, 16, 8,
      ]);
      expect(h.elements).toHaveLength(1);
    });
  });

  describe("code blocks", () => {
    const placeCode = () => {
      const element = newCodeElement({
        x: 100,
        y: 100,
        width: 300,
        height: 200,
        source: "print(1)",
        language: "python",
      });
      API.updateScene({
        elements: [element],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      API.setSelectedElements([element]);
      return element;
    };

    it("edits the source on double-click instead of cropping", () => {
      placeCode();

      mouse.doubleClickAt(200, 200);

      expect(h.state.croppingElementId).toBeNull();
      expect(h.state.editingLawhaElementId).toBe(h.elements[0].id);
      expect(document.querySelector(".excalidraw-code-editor")).not.toBeNull();
    });

    it("writes edits straight onto the element", () => {
      placeCode();
      mouse.doubleClickAt(200, 200);

      const editor = document.querySelector<HTMLTextAreaElement>(
        ".excalidraw-code-editor",
      )!;

      fireEvent.change(editor, { target: { value: "print(2)" } });

      expect((h.elements[0] as ExcalidrawCodeElement).source).toBe("print(2)");
    });

    it("selects from inside the block, not only from its outline", () => {
      placeCode();
      API.setSelectedElements([]);

      mouse.clickAt(200, 200);

      expect(Object.keys(h.state.selectedElementIds)).toEqual([
        h.elements[0].id,
      ]);
    });

    it("leaves the editor on Escape", () => {
      placeCode();
      mouse.doubleClickAt(200, 200);

      Keyboard.keyPress(KEYS.ESCAPE, GlobalTestState.interactiveCanvas);

      expect(h.state.editingLawhaElementId).toBeNull();
    });
  });
});
