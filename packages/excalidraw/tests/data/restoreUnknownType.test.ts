import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { describe, expect, it } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

/**
 * Forward-compatibility: an element type this build does not know must be
 * KEPT, not dropped.
 *
 * Upstream returns null for an unrecognised type and `restoreElements` filters
 * it out. That is not merely "we cannot draw it" — `restoreElements` runs on
 * every ingest path, including remote elements before reconciliation, and the
 * client saves the scene back afterwards. So an out-of-date client deletes the
 * newer element and persists the deletion to the server, for everybody.
 *
 * These tests pin the fix. If one fails, a Lawha build older than the element
 * it is looking at will start eating boards.
 */
const asElement = (partial: Record<string, unknown>) =>
  partial as unknown as ExcalidrawElement;

const futureElement = (overrides: Record<string, unknown> = {}) =>
  asElement({
    id: "future-1",
    type: "definitely-not-a-real-type",
    x: 10,
    y: 20,
    width: 300,
    height: 120,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    seed: 1,
    version: 5,
    versionNonce: 7,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    index: "a1",
    ...overrides,
  });

describe("restoring an element of an unknown type", () => {
  it("keeps it instead of dropping it", () => {
    const restored = restoreElements([futureElement()], null);

    expect(restored).toHaveLength(1);
    expect(restored[0]!.type).toBe("definitely-not-a-real-type");
  });

  it("preserves the fields that make it that type", () => {
    // The whole point: we cannot know what a future type stores, so whatever
    // we do not understand has to travel through untouched.
    const restored = restoreElements(
      [
        futureElement({
          cells: [["a", "b"]],
          colWidths: [0.5, 0.5],
          nested: { deep: { value: 42 } },
        }),
      ],
      null,
    );

    const element = restored[0] as unknown as Record<string, unknown>;
    expect(element.cells).toEqual([["a", "b"]]);
    expect(element.colWidths).toEqual([0.5, 0.5]);
    expect(element.nested).toEqual({ deep: { value: 42 } });
  });

  it("still normalises the fields every element shares", () => {
    const restored = restoreElements(
      [futureElement({ x: 10.5, y: 20.5, width: 100.4, height: 50.6 })],
      null,
    );

    expect(restored[0]!.width).toBeGreaterThan(0);
    expect(restored[0]!.height).toBeGreaterThan(0);
    expect(typeof restored[0]!.versionNonce).toBe("number");
  });

  it("preserves customData, which is how the composed objects survived", () => {
    const restored = restoreElements(
      [futureElement({ customData: { lawha: { kind: "table" } } })],
      null,
    );

    expect(restored[0]!.customData).toEqual({ lawha: { kind: "table" } });
  });

  it("does not disturb elements it does know", () => {
    const rectangle = asElement({
      ...futureElement(),
      type: "rectangle",
      id: "rect-1",
    });
    const restored = restoreElements([rectangle, futureElement()], null);

    expect(restored.map((el) => el.type).sort()).toEqual([
      "definitely-not-a-real-type",
      "rectangle",
    ]);
  });

  it("survives repeated round trips, the way a board reopened many times does", () => {
    let current = restoreElements(
      [futureElement({ payload: "keep me" })],
      null,
    );
    for (let i = 0; i < 5; i++) {
      current = restoreElements(
        JSON.parse(JSON.stringify(current)) as ExcalidrawElement[],
        null,
      );
    }

    expect(current).toHaveLength(1);
    expect((current[0] as unknown as Record<string, unknown>).payload).toBe(
      "keep me",
    );
  });
});
