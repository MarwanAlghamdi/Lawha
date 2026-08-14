import {
  COLLABORATOR_PALETTE,
  COLOR_VOICE_CALL,
  COLOR_WHITE,
  THEME,
  UserIdleState,
  getCollaboratorPaletteEntry,
} from "@excalidraw/common";

import { roundRect } from "./renderer/roundRect";

import type { InteractiveCanvasRenderConfig } from "./scene/types";
import type {
  Collaborator,
  InteractiveCanvasAppState,
  SocketId,
} from "./types";

/**
 * LAWHA: collaborator colours come from a shared five-value palette rather than
 * a hashed hue.
 *
 * The canvas cursor and the DOM avatar stack are rendered by entirely separate
 * code paths, and a user showing up as two different colours in the same
 * session reads as a bug. A shared palette index is the only way to keep them
 * in agreement, and there is no render hook that would let a host supply the
 * cursor colour from outside — hence the change here rather than in app code.
 *
 * @param theme required because the interactive canvas is colour-filtered in
 * dark mode; see COLLABORATOR_PALETTE.hexDark.
 */
export const getClientColor = (
  socketId: SocketId,
  collaborator: Collaborator | undefined,
  theme?: InteractiveCanvasAppState["theme"],
) => {
  // An explicit choice wins over the hash; the hash is only the default for
  // everyone who has not picked one.
  const chosen =
    typeof collaborator?.colorIndex === "number"
      ? COLLABORATOR_PALETTE[collaborator.colorIndex]
      : undefined;
  const entry =
    chosen ?? getCollaboratorPaletteEntry(collaborator?.id || socketId);

  return theme === THEME.DARK ? entry.hexDark : entry.hex;
};

/**
 * LAWHA: the lightest ink the interactive canvas can actually produce.
 *
 * In dark mode that canvas is filtered with `invert(93%) hue-rotate(180deg)`,
 * so `COLOR_WHITE` is painted and then arrives on screen as `#121212` — a
 * near-black. Every "white outline" and white label in here was therefore
 * invisible-to-wrong in dark mode, and the name chip's white-on-colour contrast
 * (which ADR 0001 claimed cleared 4.5:1) was in fact between 3.58:1 and 4.10:1
 * for four of the five palette entries.
 *
 * `#000000` is the pre-image of the brightest colour the filter can emit:
 * drawing black in dark mode lands on `#ededed`. Pure white has no pre-image
 * at all — it would need a negative channel — so `#ededed` is the ceiling, and
 * the palette is built to clear 4.5:1 against it.
 */
const cursorInk = (theme?: InteractiveCanvasAppState["theme"]) =>
  theme === THEME.DARK ? "#000000" : COLOR_WHITE;

/** Visor glass. Same pre-image trick: both spellings land on `#bcd8ec`. */
const cursorVisor = (theme?: InteractiveCanvasAppState["theme"]) =>
  theme === THEME.DARK ? "#03233a" : "#bcd8ec";

/**
 * LAWHA: the crewmate cursor.
 *
 * Traces the silhouette — backpack, domed body, two feet — into the current
 * path in a `width` x `height` box whose top-left corner is the pointer
 * position, exactly where the arrow's tip used to be. Left as a path rather
 * than painted so callers can stroke a halo and fill a body from the same
 * trace, and so the speaking halo hugs the glyph instead of the old arrow.
 */
const traceCrewmate = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
) => {
  const h = (u: number) => x + u * width;
  const v = (u: number) => y + u * height;

  context.beginPath();
  // Feet, with the notch between them.
  context.moveTo(h(0.24), v(1.0));
  context.lineTo(h(0.52), v(1.0));
  context.lineTo(h(0.52), v(0.87));
  context.lineTo(h(0.7), v(0.87));
  context.lineTo(h(0.7), v(1.0));
  context.lineTo(h(0.96), v(1.0));
  // Up the front and over the dome.
  context.lineTo(h(1.0), v(0.42));
  context.bezierCurveTo(h(1.0), v(0.04), h(0.28), v(0.04), h(0.24), v(0.42));
  // Backpack.
  context.lineTo(h(0.24), v(0.46));
  context.lineTo(h(0.06), v(0.52));
  context.lineTo(h(0.02), v(0.58));
  context.lineTo(h(0.02), v(0.76));
  context.lineTo(h(0.08), v(0.82));
  context.lineTo(h(0.24), v(0.82));
  context.closePath();
};

// ---------------------------------------------------------------------------
// LAWHA: profile pictures on the canvas cursor.
//
// ADR 0003 rejected this, and one of its two reasons was real: "a photograph put
// through invert(93%) hue-rotate(180deg) is not a photograph". The other — that
// there is no account id on the collaborator map to fetch a picture by — is what
// the server-authoritative `lawha-identities` event fixed.
//
// The filter objection is answerable rather than fatal, because both halves of
// that filter are invertible. So the bitmap is *pre-imaged*: decoded once,
// transformed by the exact inverse of the CSS filter, and cached. What the
// filtered canvas then shows is the original photograph.
//
// Everything below is on the hot path (`renderRemoteCursors` runs per frame, per
// peer), so the rule is absolute: the render path only ever reads a cache. It
// never decodes, never awaits, and never throws.
// ---------------------------------------------------------------------------

/** `filter: invert(93%)` on `.excalidraw__canvas.interactive` in dark mode. */
const INVERT_AMOUNT = 0.93;

/**
 * `hue-rotate(180deg)` from the Filter Effects spec, with cos = -1 and sin = 0.
 *
 * It is its own inverse — rotating by 180 degrees twice is 360 — so the same
 * matrix appears on the forward and the reverse path. That is worth knowing
 * before anyone tries to derive a second one.
 */
const HUE_ROTATE_180 = [
  [-0.574, 1.43, 0.144],
  [0.426, 0.43, 0.144],
  [0.426, 1.43, -0.856],
] as const;

const clampChannel = (value: number) => Math.max(0, Math.min(255, value));

/**
 * LAWHA: what to paint so that the dark interactive canvas *shows* this pixel.
 *
 * The forward transform is `hueRotate180(invert93(painted))`. `invert(a)` is the
 * affine map `c' = c(1 - 2a) + a`, invertible for a = 0.93 as `c = (a - c')/(2a - 1)`;
 * the hue rotation is an involutive 3x3 matrix. So the pre-image is the matrix
 * applied to the target, then the inverse invert, per channel.
 *
 * Out-of-gamut channels are clamped rather than rejected. The reachable range is
 * roughly 0.07-0.93 per channel after the rotation, so a saturated red has no
 * exact pre-image; clamping costs accuracy on the most extreme pixels of a
 * photograph and keeps every other pixel true. `clients.test.ts` proves the
 * round trip by reimplementing the CSS filter, in the same way it proves the
 * palette's light/dark pairing (ADR 0003 §3).
 */
export const preimageDarkCanvasPixel = (
  red: number,
  green: number,
  blue: number,
): [number, number, number] => {
  const target = [red / 255, green / 255, blue / 255];

  return HUE_ROTATE_180.map((row) => {
    const rotated =
      row[0] * target[0] + row[1] * target[1] + row[2] * target[2];
    // The inverse of invert(a): c = (a - c') / (2a - 1).
    const uninverted = (INVERT_AMOUNT - rotated) / (2 * INVERT_AMOUNT - 1);
    return Math.round(clampChannel(uninverted * 255));
  }) as [number, number, number];
};

/**
 * The same transform over an ImageData buffer, in place.
 *
 * Mutating rather than copying is deliberate here and only here: this is a
 * pixel buffer being handed straight back to `putImageData`, and a second
 * allocation of ~1KB per avatar buys nothing. Alpha is left untouched, so the
 * circular clip's antialiased edge survives.
 */
const preimageDarkCanvasImage = (data: Uint8ClampedArray) => {
  for (let offset = 0; offset < data.length; offset += 4) {
    const [red, green, blue] = preimageDarkCanvasPixel(
      data[offset],
      data[offset + 1],
      data[offset + 2],
    );
    data[offset] = red;
    data[offset + 1] = green;
    data[offset + 2] = blue;
  }
};

/**
 * Decoded, cropped, circle-clipped, theme-corrected avatars, by
 * (url, theme, pixel size).
 *
 * A `null` value means "this one failed and must not be retried" — without it a
 * 404 avatar would start a fresh request on every frame. The key carries the
 * theme because the pre-image differs between them, and the pixel size because
 * the bitmap is rasterised once at its final resolution.
 */
const avatarBitmaps = new Map<string, HTMLCanvasElement | null>();
/** In-flight keys, so N frames during a decode start one request, not N. */
const avatarsLoading = new Set<string>();
const avatarListeners = new Set<() => void>();

/**
 * LAWHA: called when an avatar bitmap becomes available.
 *
 * The interactive canvas is not on a continuous render loop, so a peer who is
 * idle when their picture finishes decoding would keep their crewmate until
 * they next moved the mouse — which is precisely the objection ADR 0003 raised.
 * The host (Collab) subscribes and republishes its collaborator map, which is
 * one repaint per decoded image and none thereafter.
 */
export const onCollaboratorAvatarReady = (
  listener: () => void,
): (() => void) => {
  avatarListeners.add(listener);
  return () => {
    avatarListeners.delete(listener);
  };
};

/** Test seam: forgets every decoded avatar, including the failures. */
export const resetCollaboratorAvatars = () => {
  avatarBitmaps.clear();
  avatarsLoading.clear();
};

/**
 * Rasterises a decoded image into the square, circular bitmap the cursor draws.
 *
 * Order matters: crop and clip first, then read the pixels back and pre-image
 * them. `putImageData` replaces rather than composites, so the alpha written by
 * the clip is preserved exactly while the colour underneath it is transformed.
 */
const buildAvatarBitmap = (
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  pixelSize: number,
  theme: InteractiveCanvasAppState["theme"],
): HTMLCanvasElement | null => {
  if (!sourceWidth || !sourceHeight || pixelSize < 1) {
    return null;
  }

  const bitmap = document.createElement("canvas");
  bitmap.width = pixelSize;
  bitmap.height = pixelSize;

  const context = bitmap.getContext("2d");
  if (!context) {
    return null;
  }

  const half = pixelSize / 2;
  context.beginPath();
  context.arc(half, half, half, 0, 2 * Math.PI);
  context.clip();

  // Centre-cropped to a square before scaling, so a portrait photograph is not
  // squashed into the circle.
  const side = Math.min(sourceWidth, sourceHeight);
  context.drawImage(
    source,
    (sourceWidth - side) / 2,
    (sourceHeight - side) / 2,
    side,
    side,
    0,
    0,
    pixelSize,
    pixelSize,
  );

  if (theme === THEME.DARK) {
    const pixels = context.getImageData(0, 0, pixelSize, pixelSize);
    preimageDarkCanvasImage(pixels.data);
    context.putImageData(pixels, 0, 0);
  }

  return bitmap;
};

const loadCollaboratorAvatar = (
  key: string,
  url: string,
  pixelSize: number,
  theme: InteractiveCanvasAppState["theme"],
) => {
  avatarsLoading.add(key);

  const finish = (bitmap: HTMLCanvasElement | null) => {
    avatarsLoading.delete(key);
    avatarBitmaps.set(key, bitmap);
    if (bitmap) {
      for (const listener of avatarListeners) {
        listener();
      }
    }
  };

  try {
    const image = new Image();
    image.decoding = "async";

    image.onload = () => {
      try {
        finish(
          buildAvatarBitmap(
            image,
            // A canvas source reports `width`; a real image reports its
            // intrinsic size as `naturalWidth`, which is the one to crop from.
            (image as HTMLImageElement).naturalWidth || image.width,
            (image as HTMLImageElement).naturalHeight || image.height,
            pixelSize,
            theme,
          ),
        );
      } catch {
        // A tainted canvas, a zero-byte image, a browser without
        // getImageData — all of them are "this person keeps their crewmate",
        // and none of them may reach the render loop as an exception.
        finish(null);
      }
    };
    image.onerror = () => finish(null);
    image.src = url;
  } catch {
    finish(null);
  }
};

/**
 * The cached bitmap for a collaborator's picture, or null while it is not ready.
 *
 * Never blocks and never throws: a miss starts one background decode and
 * answers null, and the caller draws the crewmate for this frame.
 */
const getCollaboratorAvatar = (
  url: string,
  theme: InteractiveCanvasAppState["theme"],
  size: number,
): HTMLCanvasElement | null => {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return null;
  }

  // The interactive canvas is drawn in CSS pixels (the context is pre-scaled by
  // the device pixel ratio), so the bitmap has to be rasterised larger than its
  // box or it lands soft on a retina display.
  const ratio = Math.min(
    3,
    Math.max(
      1,
      (typeof window !== "undefined" && window.devicePixelRatio) || 1,
    ),
  );
  const pixelSize = Math.ceil(size * ratio);
  const key = `${url}|${theme}|${pixelSize}`;

  const cached = avatarBitmaps.get(key);
  if (cached !== undefined) {
    return cached;
  }

  if (!avatarsLoading.has(key)) {
    loadCollaboratorAvatar(key, url, pixelSize, theme);
  }

  return null;
};

/** The circle the avatar occupies, in the same box the crewmate advertises. */
const AVATAR_RING_WIDTH = 2;
const AVATAR_HALO_WIDTH = 1.5;

const avatarGeometry = (
  x: number,
  y: number,
  width: number,
  height: number,
) => ({
  centerX: x + width / 2,
  centerY: y + height / 2,
  // Inset by half the halo so nothing spills past `width`/`height`. Those two
  // numbers are also read by the out-of-bounds test, the edge clamp and the
  // name-chip anchor, so a glyph that overhangs them would clip at the viewport
  // edge and sit under its own label.
  radius: width / 2 - AVATAR_HALO_WIDTH / 2,
});

const traceAvatarCircle = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
) => {
  const { centerX, centerY, radius } = avatarGeometry(x, y, width, height);
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, 2 * Math.PI);
};

/**
 * LAWHA: the avatar cursor.
 *
 * Ringed in the collaborator's palette colour, always. A photograph carries no
 * reliable identity on a canvas — it can be dark, busy, or a picture of a cat —
 * and the ring is the same colour the DOM avatar, the name chip and the laser
 * already use, so who this is stays legible whatever the picture is of.
 */
const drawCollaboratorAvatar = (
  context: CanvasRenderingContext2D,
  bitmap: HTMLCanvasElement,
  x: number,
  y: number,
  width: number,
  height: number,
  background: string,
  ink: string,
) => {
  const { centerX, centerY, radius } = avatarGeometry(x, y, width, height);

  context.drawImage(
    bitmap,
    centerX - radius,
    centerY - radius,
    radius * 2,
    radius * 2,
  );

  // Inset by half its width so it covers the bitmap's own antialiased edge.
  context.beginPath();
  context.arc(centerX, centerY, radius - AVATAR_RING_WIDTH / 2, 0, 2 * Math.PI);
  context.lineWidth = AVATAR_RING_WIDTH;
  context.strokeStyle = background;
  context.stroke();

  // The separator the crewmate gets from its halo: a mid-lightness ring on a
  // dark canvas needs a light edge, and "light" here is theme-dependent for
  // exactly the reason `cursorInk` exists.
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  context.lineWidth = AVATAR_HALO_WIDTH;
  context.strokeStyle = ink;
  context.stroke();
};

/**
 * LAWHA: the cursor for a peer who shares no picture — their initial, on their
 * assigned colour, in the same disc a picture would occupy.
 *
 * This replaces the crewmate for anyone the server has named. The crewmate was
 * the fallback for *everybody* without a picture, which meant a room of
 * signed-in people who had simply not uploaded one was a row of identical
 * spacemen distinguishable only by colour — and colour alone stops working at
 * the point there are more people than the eye separates comfortably.
 *
 * Guests keep the crewmate, deliberately: they have no account and no name of
 * their own, so an initial would be inventing an identity for somebody who has
 * not got one. `renderRemoteCursors` decides which, from the server-announced
 * `isGuest` — never from a pointer payload, which is client-written (ADR 0006).
 *
 * The ink, the ring and the geometry are shared with `drawCollaboratorAvatar`
 * so the two cannot drift: a picture and an initial are the same disc with
 * different contents. Text is drawn AFTER the rings for the same reason the
 * bitmap is — the inset ring covers its own antialiased edge, and a glyph
 * underneath it would be clipped.
 */
const drawCollaboratorInitials = (
  context: CanvasRenderingContext2D,
  initial: string,
  x: number,
  y: number,
  width: number,
  height: number,
  background: string,
  ink: string,
) => {
  const { centerX, centerY, radius } = avatarGeometry(x, y, width, height);

  context.beginPath();
  context.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  context.fillStyle = background;
  context.fill();

  context.beginPath();
  context.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  context.lineWidth = AVATAR_HALO_WIDTH;
  context.strokeStyle = ink;
  context.stroke();

  // The ink is already theme-corrected, so the letter inherits the same
  // pre-imaging the halo gets and stays legible under the dark-mode filter.
  context.save();
  context.fillStyle = ink;
  context.font = `600 ${Math.round(radius * 1.15)}px ${
    // The canvas has no cascade, so this is a literal stack rather than a
    // `--lw-*` token; it mirrors the DOM avatar's family so one person's
    // initial is the same shape in the stack and on the board.
    "Assistant, Helvetica, Arial, sans-serif"
  }`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(initial, centerX, centerY + radius * 0.04);
  context.restore();
};

/**
 * returns first char, capitalized
 */
export const getNameInitial = (name?: string | null) => {
  // first char can be a surrogate pair, hence using codePointAt
  const firstCodePoint = name?.trim()?.codePointAt(0);
  return (
    firstCodePoint ? String.fromCodePoint(firstCodePoint) : "?"
  ).toUpperCase();
};

export const renderRemoteCursors = ({
  context,
  renderConfig,
  appState,
  normalizedWidth,
  normalizedHeight,
}: {
  context: CanvasRenderingContext2D;
  renderConfig: InteractiveCanvasRenderConfig;
  appState: InteractiveCanvasAppState;
  normalizedWidth: number;
  normalizedHeight: number;
}) => {
  // Paint remote pointers
  for (const [socketId, pointer] of renderConfig.remotePointerViewportCoords) {
    let { x, y } = pointer;

    const collaborator = appState.collaborators.get(socketId);

    x -= appState.offsetLeft;
    y -= appState.offsetTop;

    // LAWHA: the crewmate needs more room than the 11x14 arrow it replaced.
    const width = 18;
    const height = 22;

    const isOutOfBounds =
      x < 0 ||
      x > normalizedWidth - width ||
      y < 0 ||
      y > normalizedHeight - height;

    x = Math.max(x, 0);
    x = Math.min(x, normalizedWidth - width);
    y = Math.max(y, 0);
    y = Math.min(y, normalizedHeight - height);

    const background = getClientColor(socketId, collaborator, appState.theme);

    // LAWHA: a peer who set a picture *and* opted in to showing it gets it here
    // instead of the crewmate. Null until the bitmap is decoded and pre-imaged,
    // and null forever if it fails — so a link guest, who has no account and
    // therefore no `avatarUrl`, gets the crewmate for free with no special
    // case, and so does everyone else on the frame where the picture is still
    // loading.
    const avatar = collaborator?.avatarUrl
      ? getCollaboratorAvatar(
          collaborator.avatarUrl,
          appState.theme,
          avatarGeometry(x, y, width, height).radius * 2,
        )
      : null;

    context.save();
    context.strokeStyle = background;
    context.fillStyle = background;

    const userState = renderConfig.remotePointerUserStates.get(socketId);
    const isInactive =
      isOutOfBounds ||
      userState === UserIdleState.IDLE ||
      userState === UserIdleState.AWAY;

    if (isInactive) {
      context.globalAlpha = 0.3;
    }

    if (renderConfig.remotePointerButton.get(socketId) === "down") {
      context.beginPath();
      context.arc(x, y, 15, 0, 2 * Math.PI, false);
      context.lineWidth = 3;
      context.strokeStyle = "#ffffff88";
      context.stroke();
      context.closePath();

      context.beginPath();
      context.arc(x, y, 15, 0, 2 * Math.PI, false);
      context.lineWidth = 1;
      context.strokeStyle = background;
      context.stroke();
      context.closePath();
    }

    // TODO remove the dark theme color after we stop inverting canvas colors
    const IS_SPEAKING_COLOR =
      appState.theme === THEME.DARK ? "#2f6330" : COLOR_VOICE_CALL;

    const isSpeaking = collaborator?.isSpeaking;

    if (isSpeaking) {
      // cursor outline for currently speaking user
      // LAWHA: traces the crewmate rather than the arrow it replaced, so the
      // halo hugs the glyph instead of poking out from behind it — and the
      // avatar's circle for the same reason.
      context.fillStyle = IS_SPEAKING_COLOR;
      context.strokeStyle = IS_SPEAKING_COLOR;
      context.lineWidth = 10;
      context.lineJoin = "round";
      // The halo has to hug whichever glyph is about to be drawn, so this
      // asks the same question the draw below does. An initial occupies the
      // avatar's disc, not the crewmate's silhouette.
      if (avatar || (collaborator && collaborator.isGuest !== true)) {
        traceAvatarCircle(context, x, y, width, height);
      } else {
        traceCrewmate(context, x, y, width, height);
      }
      context.stroke();
      context.fill();
    }

    // LAWHA: the glyph itself — a picture if this peer shares one, the crewmate
    // otherwise. Alternatives, not layers: a photograph with transparency in it
    // would otherwise have a crewmate showing through.
    //
    // Both are separated from the canvas by the same theme-correct light ink:
    // the crewmate's halo, the avatar's outer ring. That ink is not a literal
    // COLOR_WHITE, because white painted on the filtered canvas arrives as a
    // near-black — see `cursorInk`.
    const ink = cursorInk(appState.theme);

    context.lineJoin = "round";
    context.lineCap = "round";

    if (avatar) {
      drawCollaboratorAvatar(
        context,
        avatar,
        x,
        y,
        width,
        height,
        background,
        ink,
      );
    } else if (collaborator && collaborator.isGuest !== true) {
      // Named by the server, no picture: their initial. See
      // `drawCollaboratorInitials` for why a guest is not given one.
      drawCollaboratorInitials(
        context,
        getNameInitial(collaborator.username),
        x,
        y,
        width,
        height,
        background,
        ink,
      );
    } else {
      traceCrewmate(context, x, y, width, height);
      context.strokeStyle = ink;
      context.lineWidth = 3;
      context.stroke();
      context.fillStyle = background;
      context.fill();

      // Visor.
      const visorX = x + width * 0.62;
      const visorY = y + height * 0.31;
      context.beginPath();
      context.ellipse(
        visorX,
        visorY,
        width * 0.28,
        height * 0.155,
        -0.18,
        0,
        2 * Math.PI,
      );
      context.fillStyle = cursorVisor(appState.theme);
      context.fill();

      // A single highlight on the glass. Small, but it is what makes the shape
      // read as a visor rather than a hole.
      context.beginPath();
      context.ellipse(
        visorX - width * 0.12,
        visorY - height * 0.04,
        width * 0.075,
        height * 0.045,
        -0.18,
        0,
        2 * Math.PI,
      );
      context.fillStyle = ink;
      context.fill();
    }

    const username = renderConfig.remotePointerUsernames.get(socketId) || "";

    if (!isOutOfBounds && username) {
      context.font = "600 12px sans-serif"; // font has to be set before context.measureText()

      const offsetX = (isSpeaking ? x + 0 : x) + width / 2;
      const offsetY = (isSpeaking ? y + 0 : y) + height + 2;
      const paddingHorizontal = 5;
      const paddingVertical = 3;
      const measure = context.measureText(username);
      const measureHeight =
        measure.actualBoundingBoxDescent + measure.actualBoundingBoxAscent;
      const finalHeight = Math.max(measureHeight, 12);

      const boxX = offsetX - 1;
      const boxY = offsetY - 1;
      const boxWidth = measure.width + 2 + paddingHorizontal * 2 + 2;
      const boxHeight = finalHeight + 2 + paddingVertical * 2 + 2;
      // LAWHA: r4 rather than r8, matching the mockup's cursor label chip.
      const LABEL_RADIUS = 4;

      if (context.roundRect) {
        context.beginPath();
        context.roundRect(boxX, boxY, boxWidth, boxHeight, LABEL_RADIUS);
        context.fillStyle = background;
        context.fill();
        context.strokeStyle = ink;
        context.stroke();

        if (isSpeaking) {
          context.beginPath();
          context.roundRect(
            boxX - 2,
            boxY - 2,
            boxWidth + 4,
            boxHeight + 4,
            LABEL_RADIUS,
          );
          context.strokeStyle = IS_SPEAKING_COLOR;
          context.stroke();
        }
      } else {
        roundRect(
          context,
          boxX,
          boxY,
          boxWidth,
          boxHeight,
          LABEL_RADIUS,
          background,
        );
      }
      // LAWHA: the lightest label the surface can show, per theme. Writing
      // COLOR_WHITE unconditionally — as this did — put #121212 text on the
      // chip in dark mode, which is where the contrast failures were.
      context.fillStyle = ink;

      context.fillText(
        username,
        offsetX + paddingHorizontal + 1,
        offsetY +
          paddingVertical +
          measure.actualBoundingBoxAscent +
          Math.floor((finalHeight - measureHeight) / 2) +
          2,
      );

      // draw three vertical bars signalling someone is speaking
      if (isSpeaking) {
        context.fillStyle = IS_SPEAKING_COLOR;
        const barheight = 8;
        const margin = 8;
        const gap = 5;
        context.fillRect(
          boxX + boxWidth + margin,
          boxY + (boxHeight / 2 - barheight / 2),
          2,
          barheight,
        );
        context.fillRect(
          boxX + boxWidth + margin + gap,
          boxY + (boxHeight / 2 - (barheight * 2) / 2),
          2,
          barheight * 2,
        );
        context.fillRect(
          boxX + boxWidth + margin + gap * 2,
          boxY + (boxHeight / 2 - barheight / 2),
          2,
          barheight,
        );
      }
    }

    context.restore();
    context.closePath();
  }
};
