import type App from "./App";

/**
 * Momentum for canvas panning — the part that makes a drag feel like holding
 * the canvas rather than dragging a scrollbar. See ADR 0013.
 *
 * All of it lives here rather than in `App.tsx` on purpose: a new file is the
 * cheapest kind of `packages/` divergence because upstream will never touch a
 * path it does not have, and invariant 10 is about keeping merges tractable.
 * `App.tsx` gets five single-line hooks, enumerated in the ADR.
 *
 * The glide writes through `app.viewport.translate`, never `setState` — that
 * is what keeps scroll constraints, the follow-mode cancel and the zoom cache
 * correct while the viewport is still travelling after release.
 */

/**
 * Momentum is OFF on this deployment. **This amends ADR 0013.**
 *
 * 0013 gave panning weight: a thrown canvas keeps gliding after release. The
 * glide is the thing being switched off here, and only the glide — the canvas
 * still follows the pointer exactly, and the right-button drag-to-pan that
 * arrived in the same ADR is untouched.
 *
 * Why off: the viewport carries on moving after the hand has stopped, which
 * reads as drift rather than as weight, and it fights placing a shape at a
 * precise spot — you aim, release, and the target has moved.
 *
 * Switched rather than deleted, and switched HERE rather than at the five call
 * sites in `App.tsx`. `computeLaunchVelocity` stays live and stays tested: the
 * overscroll rubber-band reads the same samples, and `appPan.test.ts` pins the
 * arithmetic. Deleting the module would take both with it and make ADR 0013
 * unrecoverable; flipping this to `true` restores the glide exactly.
 *
 * Annotated `: boolean` on purpose. Without it TypeScript narrows the constant
 * to the literal `false`, marks the rest of `release` unreachable, and the
 * momentum code stops being type-checked at all — which is how a switch that
 * is meant to be reversible quietly becomes one that is not.
 */
const MOMENTUM_ENABLED: boolean = false;

/**
 * How far back the launch velocity is measured. Long enough to smooth a
 * jittery frame, short enough that a pause before release reads as "stop"
 * rather than "throw" — averaging the whole gesture would get both wrong.
 */
const VELOCITY_WINDOW_MS = 90;

/**
 * Exponential decay constant: the glide loses 1/e of its speed every this
 * many milliseconds, and travels `v0 * GLIDE_TAU_MS` in total. At the
 * clamped maximum launch speed that is a little under a screen and a half.
 */
const GLIDE_TAU_MS = 320;

/** Below this a release was a placement, not a throw. Viewport px/ms. */
const MIN_LAUNCH_VELOCITY = 0.12;

/** Below this the glide has arrived. Viewport px/ms. */
const MIN_GLIDE_VELOCITY = 0.015;

/**
 * Faster than this is a slip of the hand rather than an intention — usually
 * a single huge pointer delta after the compositor drops frames.
 */
const MAX_LAUNCH_VELOCITY = 4;

/**
 * A backgrounded tab resumes with a multi-second frame delta. Unclamped, the
 * first frame after returning would teleport the viewport across the scene.
 */
const MAX_FRAME_MS = 32;

/**
 * How far a right-button press must travel before it counts as a pan rather
 * than a click. Below it the press was a right-click and its context menu is
 * owed — see ADR 0013 on why that decision cannot be made at pointer-down.
 */
export const PAN_INTENT_THRESHOLD_PX = 4;

export type PanSample = { x: number; y: number; t: number };

export type PanVelocity = { x: number; y: number };

const ZERO_VELOCITY: PanVelocity = { x: 0, y: 0 };

/**
 * Velocity of the pointer, in viewport px/ms, over the trailing
 * {@link VELOCITY_WINDOW_MS} of the gesture.
 *
 * Positive x means the pointer moved right, which scrolls the scene right —
 * the sign convention of the pan handler this feeds, where `scrollX` grows
 * with `clientX`.
 */
export const computeLaunchVelocity = (
  samples: readonly PanSample[],
): PanVelocity => {
  if (samples.length < 2) {
    return ZERO_VELOCITY;
  }

  const last = samples[samples.length - 1];

  // Walk back from the end so a long drag that finished in a flick reports
  // the flick. The first sample inside the window wins; there is always at
  // least one, because the loop starts at `last` itself.
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.t - samples[i].t > VELOCITY_WINDOW_MS) {
      break;
    }
    first = samples[i];
  }

  const elapsed = last.t - first.t;
  if (elapsed <= 0) {
    return ZERO_VELOCITY;
  }

  return clampVelocity({
    x: (last.x - first.x) / elapsed,
    y: (last.y - first.y) / elapsed,
  });
};

/** Caps speed while preserving direction. */
const clampVelocity = (velocity: PanVelocity): PanVelocity => {
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed <= MAX_LAUNCH_VELOCITY) {
    return velocity;
  }
  const scale = MAX_LAUNCH_VELOCITY / speed;
  return { x: velocity.x * scale, y: velocity.y * scale };
};

export class AppPan {
  private samples: PanSample[] = [];
  private velocity: PanVelocity = ZERO_VELOCITY;
  private frame: number | null = null;
  private lastFrameTime = 0;

  constructor(private app: App) {}

  /** Whether a glide is currently moving the viewport. */
  get isGliding() {
    return this.frame !== null;
  }

  /**
   * Starts a fresh gesture, cancelling any glide still in flight. Called on
   * every pan start, which is what stops momentum from surviving into the
   * next interaction and moving the canvas under a stroke.
   */
  begin = () => {
    this.cancel();
    this.samples = [];
  };

  sample = (x: number, y: number, t: number = performance.now()) => {
    this.samples.push({ x, y, t });

    // Only the tail can influence the launch. Keep one sample beyond the
    // window so a gesture whose last frames all landed inside it still has
    // something to measure against.
    while (
      this.samples.length > 2 &&
      t - this.samples[1].t > VELOCITY_WINDOW_MS
    ) {
      this.samples.shift();
    }
  };

  /**
   * Ends the gesture, launching a glide if it was thrown rather than placed.
   *
   * Returns whether a glide started, because that decides who owns the
   * overscroll snap-back: a glide is still moving the viewport, so the
   * rubber-band has to start from where the glide stops, not from where the
   * pointer left off.
   */
  release = (): boolean => {
    // Momentum off: clear the gesture and report no glide. Deliberately the
    // same contract as the too-slow release below rather than a second one —
    // `false` already means "nothing is still moving the viewport, so the
    // caller owns the overscroll snap-back from where the pointer left off",
    // which is exactly true here. A new branch would be a second answer to a
    // question that already has one.
    if (!MOMENTUM_ENABLED) {
      this.samples = [];
      return false;
    }

    const velocity = computeLaunchVelocity(this.samples);
    this.samples = [];

    if (Math.hypot(velocity.x, velocity.y) < MIN_LAUNCH_VELOCITY) {
      return false;
    }

    this.velocity = velocity;
    this.lastFrameTime = performance.now();
    this.frame = requestAnimationFrame(this.step);
    return true;
  };

  /** Stops a glide where it is, leaving the viewport untouched. */
  cancel = () => {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.velocity = ZERO_VELOCITY;
  };

  destroy = () => {
    this.cancel();
    this.samples = [];
  };

  private step = (now: number) => {
    this.frame = null;

    if (this.app.unmounted) {
      return;
    }

    const elapsed = Math.min(
      Math.max(now - this.lastFrameTime, 0),
      MAX_FRAME_MS,
    );
    this.lastFrameTime = now;

    const zoom = this.app.state.zoom.value;
    const moved = this.app.viewport.translate({
      scrollX: this.app.state.scrollX + (this.velocity.x * elapsed) / zoom,
      scrollY: this.app.state.scrollY + (this.velocity.y * elapsed) / zoom,
    });

    const decay = Math.exp(-elapsed / GLIDE_TAU_MS);
    this.velocity = {
      x: this.velocity.x * decay,
      y: this.velocity.y * decay,
    };

    // `translate` refuses while a locked transition owns the viewport. That
    // is not a frame to skip — something else is driving, so the glide is
    // over.
    if (
      !moved ||
      Math.hypot(this.velocity.x, this.velocity.y) < MIN_GLIDE_VELOCITY
    ) {
      this.stop();
      return;
    }

    this.frame = requestAnimationFrame(this.step);
  };

  /** Ends a glide and hands the overscroll snap-back back to the viewport. */
  private stop = () => {
    this.cancel();
    this.app.viewport.releaseOverscroll();
  };
}
