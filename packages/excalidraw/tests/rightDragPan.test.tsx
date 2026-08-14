import React from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { Excalidraw } from "../index";

import { UI } from "./helpers/ui";
import {
  GlobalTestState,
  fireEvent,
  render,
  unmountComponent,
} from "./test-utils";

/**
 * The right-button drag that pans, and what it costs the context menu.
 * See ADR 0013.
 *
 * The interesting part is not the panning — it enters the same
 * `handleCanvasPanUsingWheelOrSpaceDrag` every other pan does. It is that a
 * right press cannot be classified at pointer-down, which is where some
 * platforms fire `contextmenu`. So the menu is suppressed for the length of
 * the session and replayed at pointer-up if the press never travelled, and
 * both halves of that need pinning: a drag must not leave a menu behind, and
 * a click must still get one.
 */

const { h } = window;

const CANVAS = () => GlobalTestState.interactiveCanvas;

const rightPointerDown = (clientX: number, clientY: number) =>
  fireEvent.pointerDown(CANVAS(), {
    button: 2,
    pointerId: 1,
    clientX,
    clientY,
  });

const pointerMove = (clientX: number, clientY: number) =>
  fireEvent.pointerMove(window, { button: 2, pointerId: 1, clientX, clientY });

const pointerUp = (clientX: number, clientY: number) =>
  fireEvent.pointerUp(window, { button: 2, pointerId: 1, clientX, clientY });

beforeEach(async () => {
  unmountComponent();
  localStorage.clear();
  await render(<Excalidraw />);
});

describe("a right-button drag pans", () => {
  it("moves the viewport by the distance dragged", async () => {
    const { scrollX, scrollY } = h.state;

    rightPointerDown(300, 300);
    pointerMove(380, 250);
    pointerUp(380, 250);

    // The pointer went right and up, so the scene follows it: `scrollX`
    // grows with `clientX`. A sign error here is the bug where the canvas
    // flies the opposite way from the hand.
    expect(h.state.scrollX).toBeCloseTo(scrollX + 80);
    expect(h.state.scrollY).toBeCloseTo(scrollY - 50);
  });

  it("does not draw or select while doing it", () => {
    rightPointerDown(300, 300);
    pointerMove(380, 250);
    pointerUp(380, 250);

    expect(h.elements).toHaveLength(0);
    expect(h.state.selectionElement).toBeNull();
  });

  it("leaves no context menu behind", () => {
    rightPointerDown(300, 300);
    pointerMove(380, 250);
    pointerUp(380, 250);

    expect(UI.queryContextMenu()).toBeNull();
  });
});

describe("a right-click still opens the menu", () => {
  it("opens it at pointer-up when the press never travelled", () => {
    rightPointerDown(300, 300);
    pointerUp(300, 300);

    expect(UI.queryContextMenu()).not.toBeNull();
  });

  it("tolerates the wobble of a real click", () => {
    // A press that shifts two pixels is a click with a shaky hand, not a
    // pan. Below the threshold it must still produce a menu, or right-click
    // becomes unreliable rather than merely late.
    rightPointerDown(300, 300);
    pointerMove(302, 301);
    pointerUp(302, 301);

    expect(UI.queryContextMenu()).not.toBeNull();
  });

  it("opens for a bare contextmenu event with no pointer session", () => {
    // The compatibility guarantee. Every context-menu test in this suite
    // reaches the menu this way — through `fireEvent.contextMenu` or
    // `mouse.rightClickAt`, neither of which fires a right-button
    // pointerdown. The suppression must stay gated on a session existing.
    fireEvent.contextMenu(CANVAS(), { button: 2, clientX: 1, clientY: 1 });

    expect(UI.queryContextMenu()).not.toBeNull();
  });

  it("does not suppress the next one after a drag has ended", () => {
    // The suppression is a flag, and a flag that outlives its session would
    // silently disable right-click for the rest of the page.
    rightPointerDown(300, 300);
    pointerMove(380, 250);
    pointerUp(380, 250);
    expect(UI.queryContextMenu()).toBeNull();

    fireEvent.contextMenu(CANVAS(), { button: 2, clientX: 1, clientY: 1 });

    expect(UI.queryContextMenu()).not.toBeNull();
  });
});
