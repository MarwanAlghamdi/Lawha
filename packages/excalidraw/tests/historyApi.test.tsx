import { act, queryByTestId } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppStateDelta, Delta, ElementsDelta } from "@excalidraw/element";

import { HistoryDelta } from "../history";
import { Excalidraw } from "../index";

import { render } from "./test-utils";

import type { ExcalidrawImperativeAPI } from "../types";

const aDelta = () =>
  HistoryDelta.create(
    // `version` is required on both sides: `ElementsDelta.create`'s dev-only
    // invariant check (delta.ts `satisfiesCommmonInvariants`) rejects a
    // partial without it, since deltas without distinct versions can't be
    // ordered against the scene.
    ElementsDelta.create(
      {},
      {},
      { el1: Delta.create({ x: 1, version: 1 }, { x: 2, version: 2 }) },
    ),
    AppStateDelta.empty(),
  ) as HistoryDelta;

describe("the history API", () => {
  it("hands back the undo stack and takes one back", async () => {
    let api: ExcalidrawImperativeAPI | null = null;
    await render(<Excalidraw onExcalidrawAPI={(a) => (api = a)} />);

    expect(api!.history.getUndoStack()).toEqual([]);

    act(() => {
      api!.history.restoreUndoStack([aDelta()]);
    });

    expect(api!.history.getUndoStack()).toHaveLength(1);
  });

  it("replaces rather than appends, so a second restore does not double up", async () => {
    let api: ExcalidrawImperativeAPI | null = null;
    await render(<Excalidraw onExcalidrawAPI={(a) => (api = a)} />);

    act(() => {
      api!.history.restoreUndoStack([aDelta()]);
      api!.history.restoreUndoStack([aDelta()]);
    });

    expect(api!.history.getUndoStack()).toHaveLength(1);
  });

  it("keeps the undo button's enabled state in sync after a restore", async () => {
    // The undo button's disabled state comes from `history.onHistoryChangedEmitter`
    // (see actions/actionHistory.tsx), not from reading the stack directly. A
    // restore that mutates `undoStack` in place without also triggering that
    // emitter would leave the button reading "disabled" forever, even though
    // there is now history to undo — a restored history the UI shows as empty
    // is indistinguishable from a broken feature.
    let api: ExcalidrawImperativeAPI | null = null;
    const { container } = await render(
      <Excalidraw onExcalidrawAPI={(a) => (api = a)} />,
    );

    expect(queryByTestId(container, "button-undo")).toBeDisabled();

    // wrapped in act(): the restore triggers `onHistoryChangedEmitter`,
    // which flows into a React state update in the undo button's
    // subscription (see hooks/useEmitter.ts) that must flush before the
    // assertion below reads the DOM.
    act(() => {
      api!.history.restoreUndoStack([aDelta()]);
    });

    expect(queryByTestId(container, "button-undo")).not.toBeDisabled();
  });
});
