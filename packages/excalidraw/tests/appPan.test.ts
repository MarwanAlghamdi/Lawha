import { describe, expect, it } from "vitest";

import { computeLaunchVelocity } from "../components/App.pan";

import type { PanSample } from "../components/App.pan";

/**
 * The launch velocity that decides whether a released pan glides, and how
 * far. See ADR 0013.
 *
 * These are pinned as a pure function rather than through the class because
 * the class's other half is a `requestAnimationFrame` loop over real time,
 * and a test that fakes both the clock and rAF pins the fakes rather than the
 * feel. What is worth pinning is the arithmetic: the sign convention, the
 * trailing window, and the clamp.
 */

const drag = (points: Array<[x: number, y: number, t: number]>): PanSample[] =>
  points.map(([x, y, t]) => ({ x, y, t }));

describe("launch velocity", () => {
  it("is zero for a gesture that never moved", () => {
    expect(computeLaunchVelocity([])).toEqual({ x: 0, y: 0 });
    expect(computeLaunchVelocity(drag([[10, 10, 0]]))).toEqual({ x: 0, y: 0 });
  });

  it("is zero when every sample shares a timestamp", () => {
    // jsdom hands every synthetic event a `timeStamp` of 0, and a real
    // gesture can land two samples in one millisecond. Either way the
    // division is undefined, and returning Infinity would fling the viewport
    // to the end of the coordinate space.
    expect(
      computeLaunchVelocity(
        drag([
          [0, 0, 5],
          [100, 100, 5],
        ]),
      ),
    ).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("points the way the pointer went", () => {
    // Positive x means the pointer moved right, which scrolls the scene
    // right — the sign convention of the pan handler, where `scrollX` grows
    // with `clientX`. Getting this backwards is the bug that would make the
    // canvas fly away from the throw.
    const velocity = computeLaunchVelocity(
      drag([
        [0, 0, 0],
        [60, -30, 60],
      ]),
    );

    expect(velocity.x).toBeCloseTo(1);
    expect(velocity.y).toBeCloseTo(-0.5);
  });

  it("measures the flick a long slow drag ended on, not its average", () => {
    // Someone drags slowly across the board for a second, then flicks. The
    // gesture average is nearly zero; the flick is what they meant.
    const velocity = computeLaunchVelocity(
      drag([
        [0, 0, 0],
        [10, 0, 500],
        [20, 0, 1000],
        [120, 0, 1050],
      ]),
    );

    // The 90ms window covers the last two samples only: 100px in 50ms.
    expect(velocity.x).toBeCloseTo(2);
  });

  it("stops when the drag paused before release", () => {
    // The mirror image, and the reason the window is short: a fast drag that
    // came to rest before the pointer lifted was being placed, not thrown.
    const velocity = computeLaunchVelocity(
      drag([
        [0, 0, 0],
        [400, 0, 100],
        [400, 0, 180],
        [400, 0, 260],
      ]),
    );

    expect(velocity.x).toBe(0);
  });

  it("clamps a fling without turning it", () => {
    // A dropped frame can produce one enormous delta. Cap the speed, keep
    // the direction — a clamp per axis would bend the throw off course.
    const velocity = computeLaunchVelocity(
      drag([
        [0, 0, 0],
        [3000, 3000, 10],
      ]),
    );

    expect(Math.hypot(velocity.x, velocity.y)).toBeCloseTo(4);
    expect(velocity.x).toBeCloseTo(velocity.y);
  });

  it("ignores samples older than the window even when they are the only ones", () => {
    // Both samples predate the window relative to the last. The walk-back
    // always keeps at least the final sample, so this must not divide by a
    // zero-length window or reach past the array.
    const velocity = computeLaunchVelocity(
      drag([
        [0, 0, 0],
        [50, 0, 1000],
      ]),
    );

    expect(velocity).toEqual({ x: 0, y: 0 });
  });
});

/**
 * Momentum is off, and that is a decision rather than an accident.
 *
 * `computeLaunchVelocity` above still computes a real velocity — the
 * overscroll rubber-band reads the same samples — so nothing in this file
 * would notice the glide being switched off. Without this test, flipping
 * `MOMENTUM_ENABLED` back on, or deleting the guard while refactoring, is a
 * change to how the canvas feels that no assertion anywhere objects to.
 *
 * Pinned through `release()`'s return value, which is the whole contract: it
 * answers "is the viewport still moving?", and that is what decides who owns
 * the overscroll snap-back. See ADR 0013 and the note on `MOMENTUM_ENABLED`.
 */
describe("momentum", () => {
  const flick = (): PanSample[] =>
    drag([
      [0, 0, 0],
      [40, 0, 16],
      [90, 0, 32],
      [150, 0, 48],
    ]);

  it("is a real throw by the arithmetic, so this test is not vacuous", () => {
    const velocity = computeLaunchVelocity(flick());

    // Comfortably past MIN_LAUNCH_VELOCITY (0.12 px/ms): without the guard in
    // `release` this gesture would glide.
    expect(velocity.x).toBeGreaterThan(1);
  });

  it("does not glide after release", async () => {
    const { AppPan } = await import("../components/App.pan");
    const pan = new AppPan({
      viewport: { translate: () => {} },
    } as never);

    pan.begin();
    for (const sample of flick()) {
      pan.sample(sample.x, sample.y, sample.t);
    }

    expect(pan.release()).toBe(false);
    expect(pan.isGliding).toBe(false);
  });
});
