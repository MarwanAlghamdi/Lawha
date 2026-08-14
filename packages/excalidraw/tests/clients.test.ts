import {
  COLLABORATOR_PALETTE,
  getCollaboratorPaletteIndex,
  THEME,
} from "@excalidraw/common";

import { afterEach, vi } from "vitest";

import {
  getClientColor,
  getNameInitial,
  onCollaboratorAvatarReady,
  preimageDarkCanvasPixel,
  renderRemoteCursors,
  resetCollaboratorAvatars,
} from "../clients";

import type { Collaborator, SocketId } from "../types";

const socket = (id: string) => id as SocketId;

const collaborator = (id: string): Collaborator =>
  ({ id } as unknown as Collaborator);

describe("getClientColor", () => {
  it("only ever returns a colour from the shared palette", () => {
    const lightHexes = COLLABORATOR_PALETTE.map((entry) => entry.hex);

    for (let i = 0; i < 200; i++) {
      expect(lightHexes).toContain(
        getClientColor(socket(`user-${i}`), undefined),
      );
    }
  });

  it("is stable for the same id", () => {
    expect(getClientColor(socket("abc"), undefined)).toBe(
      getClientColor(socket("abc"), undefined),
    );
  });

  it("prefers the collaborator id over the socket id", () => {
    // A user must keep their colour across a reconnect, where the socket id
    // changes but the collaborator id does not.
    expect(
      getClientColor(socket("socket-2"), collaborator("stable-user")),
    ).toBe(getClientColor(socket("socket-1"), collaborator("stable-user")));
  });

  it("spreads ids across every palette entry", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(getClientColor(socket(`user-${i}`), undefined));
    }

    expect(seen.size).toBe(COLLABORATOR_PALETTE.length);
  });

  it("returns the pre-inverted colour in dark mode", () => {
    // The interactive canvas is colour-filtered in dark mode, so drawing the
    // light hex there would render as its inverse and stop matching the DOM
    // avatar, which is not filtered.
    const entry = COLLABORATOR_PALETTE[getCollaboratorPaletteIndex("abc")];

    expect(getClientColor(socket("abc"), undefined, THEME.LIGHT)).toBe(
      entry.hex,
    );
    expect(getClientColor(socket("abc"), undefined, THEME.DARK)).toBe(
      entry.hexDark,
    );
  });

  it("defaults to the unfiltered colour when no theme is given", () => {
    // Callers rendering into the DOM (avatar list) or the SVG laser layer are
    // not filtered, and deliberately omit the argument.
    const entry = COLLABORATOR_PALETTE[getCollaboratorPaletteIndex("abc")];

    expect(getClientColor(socket("abc"), undefined)).toBe(entry.hex);
  });
});

// ---------------------------------------------------------------------------
// The dark-mode filter, reimplemented so the palette's pairing can be *proved*
// rather than transcribed.
//
// css/styles.scss puts `filter: invert(93%) hue-rotate(180deg)` on
// `.excalidraw__canvas.interactive`. CSS shorthand filters operate in sRGB, so
// this is the whole transform: invert each channel by 93%, then apply the
// hue-rotation matrix from the Filter Effects spec at 180deg (cos = -1,
// sin = 0), then clamp.
// ---------------------------------------------------------------------------
const INVERT = 0.93;
const HUE_ROTATE_180 = [
  [-0.574, 1.43, 0.144],
  [0.426, 0.43, 0.144],
  [0.426, 1.43, -0.856],
];

const toRgb = (hex: string) =>
  [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);

const toHex = (rgb: number[]) =>
  `#${rgb
    .map((channel) =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** What the screen shows for a colour painted on the dark interactive canvas. */
const throughDarkFilter = (hex: string) => {
  const inverted = toRgb(hex).map(
    (channel) => channel * (1 - INVERT) + (1 - channel) * INVERT,
  );

  return toHex(
    HUE_ROTATE_180.map((row) =>
      row.reduce((sum, weight, index) => sum + weight * inverted[index], 0),
    ),
  );
};

const relativeLuminance = (hex: string) =>
  toRgb(hex)
    .map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    )
    .reduce(
      (sum, channel, index) => sum + [0.2126, 0.7152, 0.0722][index] * channel,
      0,
    );

const contrastRatio = (a: string, b: string) => {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (high + 0.05) / (low + 0.05);
};

/**
 * The lightest ink the dark interactive canvas can produce.
 *
 * Pure white has no pre-image under the filter — it would need a negative
 * channel — so this is the ceiling, reached by painting #000000. It is also
 * why every "white" label in clients.ts is theme-dependent.
 */
const LIGHTEST_INK_IN_DARK = throughDarkFilter("#000000");

describe("COLLABORATOR_PALETTE", () => {
  it("has twelve distinct entries, one per wheel position", () => {
    // The server duplicates this number as COLLABORATOR_PALETTE_SIZE in
    // lawha-server/src/lib/validation.ts, where it bounds the colorIndex and
    // laserColorIndex a PATCH may carry.
    //
    // This comment used to claim that copy was "asserted from here". It was
    // not — nothing on this side can see the server's constant, so the two sat
    // at 12 and 5 for a whole phase and seven swatches quietly answered 400.
    // The bound is now pinned where it is enforced, by "accepts every index the
    // twelve-colour wheel can produce" in lawha-server/tests/integration/
    // account.test.ts. Change the length here and that test fails there.
    expect(COLLABORATOR_PALETTE).toHaveLength(12);
    expect(new Set(COLLABORATOR_PALETTE.map((e) => e.hex)).size).toBe(12);
    expect(new Set(COLLABORATOR_PALETTE.map((e) => e.name)).size).toBe(12);
  });

  it("keeps the original five at their original indices", () => {
    // `users.color_index` rows hold these indices. Reordering the array would
    // silently repaint every existing account.
    expect(COLLABORATOR_PALETTE.slice(0, 5).map((e) => e.name)).toEqual([
      "blue",
      "green",
      "red",
      "purple",
      "amber",
    ]);
  });

  it("ships every colour in all the forms the app needs", () => {
    for (const entry of COLLABORATOR_PALETTE) {
      // oklch for CSS; hex for canvas fillStyle, which cannot be relied on to
      // parse oklch() in older Safari and embedded WebViews.
      expect(entry.oklch).toMatch(/^oklch\(/);
      expect(entry.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(entry.hexDark).toMatch(/^#[0-9a-f]{6}$/);
      // The wheel picker places swatches by hue rather than by index.
      expect(entry.hue).toBeGreaterThanOrEqual(0);
      expect(entry.hue).toBeLessThan(360);
    }
  });

  it("pairs each hex with its true pre-image under the dark-mode filter", () => {
    // This is the invariant the pairing exists for: painting `hexDark` on the
    // filtered canvas must land on `hex`, the value the unfiltered DOM avatar
    // uses. Anything else and the same person is two colours at once.
    for (const entry of COLLABORATOR_PALETTE) {
      const landed = toRgb(throughDarkFilter(entry.hexDark));
      const wanted = toRgb(entry.hex);

      for (let channel = 0; channel < 3; channel++) {
        // One 8-bit step of rounding slack, and no more. Three of the original
        // five entries were out of gamut and missed by far more than this.
        expect(
          Math.abs(landed[channel] - wanted[channel]) * 255,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it("clears WCAG AA for the cursor's name chip in both themes", () => {
    // ADR 0001 claimed white cleared 4.5:1 against all five. It did not: light
    // amber was 4.00:1, and in dark mode the label was not white at all —
    // the filter turned it into #121212, leaving four of five below 4.5:1.
    expect(LIGHTEST_INK_IN_DARK).toBe("#ededed");

    for (const entry of COLLABORATOR_PALETTE) {
      expect(contrastRatio("#ffffff", entry.hex)).toBeGreaterThanOrEqual(4.5);
      // In dark mode the chip is filled with hexDark and so *appears* as hex,
      // and the label is painted black and so appears as #ededed.
      expect(
        contrastRatio(LIGHTEST_INK_IN_DARK, throughDarkFilter(entry.hexDark)),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("getClientInitials", () => {
  it("returns substring if one name provided", () => {
    expect(getNameInitial("Alan")).toBe("A");
  });

  it("returns initials", () => {
    expect(getNameInitial("John Doe")).toBe("J");
  });

  it("returns correct initials if many names provided", () => {
    expect(getNameInitial("John Alan Doe")).toBe("J");
  });

  it("returns single initial if 1 letter provided", () => {
    expect(getNameInitial("z")).toBe("Z");
  });

  it("trims trailing whitespace", () => {
    expect(getNameInitial("  q    ")).toBe("Q");
  });

  it('returns "?" if falsey value provided', () => {
    expect(getNameInitial("")).toBe("?");
    expect(getNameInitial(undefined)).toBe("?");
    expect(getNameInitial(null)).toBe("?");
  });

  it('returns "?" when value is blank', () => {
    expect(getNameInitial(" ")).toBe("?");
  });

  it("works with multibyte strings", () => {
    expect(getNameInitial("😀")).toBe("😀");
    // but doesn't work with emoji ZWJ sequences
    expect(getNameInitial("👨‍👩‍👦")).toBe("👨");
  });
});

describe("getClientColor — explicit choice", () => {
  it("uses the collaborator's chosen palette index over the hash", () => {
    const chosen = { ...collaborator("abc"), colorIndex: 3 } as Collaborator;

    expect(getClientColor(socket("abc"), chosen)).toBe(
      COLLABORATOR_PALETTE[3].hex,
    );
  });

  it("still inverts the chosen colour in dark mode", () => {
    const chosen = { ...collaborator("abc"), colorIndex: 3 } as Collaborator;

    // The interactive canvas is colour-filtered in dark mode, so the DOM
    // avatar and the canvas cursor only agree if the pre-inverted hex is used.
    expect(getClientColor(socket("abc"), chosen, THEME.DARK)).toBe(
      COLLABORATOR_PALETTE[3].hexDark,
    );
  });

  it("falls back to the hash when no choice has been made", () => {
    const unchosen = {
      ...collaborator("abc"),
      colorIndex: null,
    } as Collaborator;

    expect(getClientColor(socket("abc"), unchosen)).toBe(
      COLLABORATOR_PALETTE[getCollaboratorPaletteIndex("abc")].hex,
    );
  });

  it("ignores an index outside the palette rather than rendering nothing", () => {
    const bogus = { ...collaborator("abc"), colorIndex: 99 } as Collaborator;

    // The value comes off the wire from a peer, so it cannot be trusted to be
    // in range; an undefined entry here would throw inside the renderer.
    expect(COLLABORATOR_PALETTE.map((entry) => entry.hex)).toContain(
      getClientColor(socket("abc"), bogus),
    );
  });
});

// ---------------------------------------------------------------------------
// The crewmate glyph
// ---------------------------------------------------------------------------

interface PaintOp {
  op: string;
  /**
   * Only `fillText` carries one — the glyph the initials cursor drew.
   *
   * The only optional field here. `fillStyle` and `strokeStyle` stay required
   * because every recorded op supplies them, and the colour assertions read
   * them directly: making them optional compiles under `yarn test:typecheck`
   * and fails the stricter `tsc` the docker build runs, which is a difference
   * worth knowing about — a green test run does not mean a green image.
   */
  text?: string;
  fillStyle: string;
  strokeStyle: string;
}

/**
 * A recording 2D context.
 *
 * jsdom has no canvas, and the point here is not what the pixels look like —
 * that is what the screenshots are for — but *which colours are asked for in
 * which theme*, which is exactly where the dark-mode filter bites.
 */
const recordingContext = () => {
  const ops: PaintOp[] = [];
  const points: [number, number][] = [];

  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineJoin: "",
    lineCap: "",
    font: "",
    globalAlpha: 1,
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: (x: number, y: number) => points.push([x, y]),
    lineTo: (x: number, y: number) => points.push([x, y]),
    bezierCurveTo: (
      ax: number,
      ay: number,
      bx: number,
      by: number,
      x: number,
      y: number,
    ) => {
      // Control points included: the dome's apex is one, so a bounding box
      // built from endpoints alone would not see the top of the head.
      points.push([ax, ay], [bx, by], [x, y]);
    },
    arc: () => {},
    ellipse: () => {},
    roundRect: () => {},
    fillRect: () => {},
    clip: () => {},
    drawImage: () =>
      ops.push({
        op: "drawImage",
        fillStyle: context.fillStyle,
        strokeStyle: context.strokeStyle,
      }),
    measureText: () => ({
      width: 40,
      actualBoundingBoxAscent: 9,
      actualBoundingBoxDescent: 3,
    }),
    // Records, unlike the no-op it replaces: the initials cursor draws its
    // glyph with this, so a stub that swallowed it would make "an initial was
    // drawn" unassertable — and the assertion would pass against a cursor that
    // drew nothing at all.
    fillText: (text: string) =>
      ops.push({
        op: "fillText",
        text,
        fillStyle: context.fillStyle,
        strokeStyle: context.strokeStyle,
      }),
    fill: () =>
      ops.push({
        op: "fill",
        fillStyle: context.fillStyle,
        strokeStyle: context.strokeStyle,
      }),
    stroke: () =>
      ops.push({
        op: "stroke",
        fillStyle: context.fillStyle,
        strokeStyle: context.strokeStyle,
      }),
  };

  return { context, ops, points };
};

const paintCursor = (
  theme: typeof THEME[keyof typeof THEME],
  collaboratorPatch: Partial<Collaborator> = {},
) => {
  const { context, ops, points } = recordingContext();
  const socketId = socket("s1");

  renderRemoteCursors({
    context: context as unknown as CanvasRenderingContext2D,
    renderConfig: {
      remotePointerViewportCoords: new Map([[socketId, { x: 200, y: 200 }]]),
      remotePointerUserStates: new Map(),
      remotePointerButton: new Map(),
      remotePointerUsernames: new Map([[socketId, "yasmin"]]),
    } as any,
    appState: {
      collaborators: new Map([
        [socketId, { id: "u_1", ...collaboratorPatch } as Collaborator],
      ]),
      offsetLeft: 0,
      offsetTop: 0,
      theme,
    } as any,
    normalizedWidth: 800,
    normalizedHeight: 600,
  });

  return { ops, points, colours: ops.map((entry) => entry.fillStyle) };
};

describe("the crewmate cursor", () => {
  it("paints the body in the collaborator's assigned colour", () => {
    const { ops } = paintCursor(THEME.LIGHT, { colorIndex: 7 });

    expect(ops.map((entry) => entry.fillStyle)).toContain(
      COLLABORATOR_PALETTE[7].hex,
    );
  });

  it("uses the pre-inverted body colour in dark mode", () => {
    const { ops } = paintCursor(THEME.DARK, { colorIndex: 7 });

    const fills = ops.map((entry) => entry.fillStyle);
    expect(fills).toContain(COLLABORATOR_PALETTE[7].hexDark);
    expect(fills).not.toContain(COLLABORATOR_PALETTE[7].hex);
  });

  it("never paints literal white in dark mode", () => {
    // Measured, not assumed: the interactive canvas filter turns #ffffff into
    // #121212. A "white outline" there is a near-black one, and a white label
    // on a mid-tone chip fails contrast. Every light ink must be the
    // pre-image, #000000.
    const { ops } = paintCursor(THEME.DARK);

    for (const entry of ops) {
      expect(entry.fillStyle.toLowerCase()).not.toBe("#ffffff");
      expect(entry.strokeStyle.toLowerCase()).not.toBe("#ffffff");
    }
    expect(ops.some((entry) => entry.strokeStyle === "#000000")).toBe(true);
  });

  it("still uses white in light mode, where it is white", () => {
    const { ops } = paintCursor(THEME.LIGHT);

    expect(ops.some((entry) => entry.strokeStyle === "#ffffff")).toBe(true);
    expect(ops.some((entry) => entry.strokeStyle === "#000000")).toBe(false);
  });

  it("keeps the crewmate for a GUEST, who has no name of their own", () => {
    // This used to be "keeps the crewmate for a peer who has no picture", and
    // the change is deliberate: a signed-in peer without a picture now gets
    // their initial. A room of accounts that had simply not uploaded one was a
    // row of identical spacemen separable only by colour, and colour alone
    // stops working before the room does.
    //
    // A guest keeps the crewmate because they have no account and no name of
    // their own — an initial would be inventing an identity for somebody who
    // has not got one. `isGuest` is server-announced (ADR 0006); it is never
    // read from a pointer payload, which the peer writes itself.
    const { ops, points } = paintCursor(THEME.LIGHT, { isGuest: true });

    expect(points.length).toBeGreaterThan(8);
    expect(ops.some((entry) => entry.op === "drawImage")).toBe(false);
    // No INITIAL. `fillText` alone is not the test — the name chip under the
    // cursor uses it too, so asserting "no fillText" would fail on a correct
    // crewmate and pass on nothing in particular. The initial is one glyph.
    expect(ops.filter((entry) => entry.text?.length === 1)).toEqual([]);
  });

  it("draws an initial for a named peer with no picture", () => {
    const { ops } = paintCursor(THEME.LIGHT, { username: "yasmin" });

    const text = ops.find((entry) => entry.text?.length === 1);
    expect(text).toBeTruthy();
    // Capitalised, and one code point — `getNameInitial` handles a surrogate
    // pair, so an emoji or a non-BMP script is one glyph and not half of one.
    expect(text!.text).toBe("Y");
    // And no crewmate silhouette behind it: an initial occupies the avatar's
    // disc, so the two glyphs are alternatives rather than layers.
    expect(ops.some((entry) => entry.op === "drawImage")).toBe(false);
  });

  it("draws a figure that fills the hit box it advertises, and no more", () => {
    // Asserted on the guest path, which is the one that still traces a
    // crewmate; the box is the same for both glyphs.
    // The arrow was 11x14 and four points. width/height are read by the
    // out-of-bounds test, the edge clamp and the name-chip anchor, so a glyph
    // drawn outside its declared box would overhang the viewport edge and sit
    // under its own label. The pointer is at (200, 200) in this fixture.
    const { points } = paintCursor(THEME.LIGHT, { isGuest: true });

    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);

    expect(Math.min(...xs)).toBeGreaterThanOrEqual(200);
    expect(Math.max(...xs)).toBeLessThanOrEqual(200 + 18);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(200);
    expect(Math.max(...ys)).toBeLessThanOrEqual(200 + 22);

    // And it actually uses the box it asked for, rather than the old 11x14.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(16);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(20);
    // A crewmate is not four line segments.
    expect(points.length).toBeGreaterThan(8);
  });
});

// ---------------------------------------------------------------------------
// The avatar cursor, and the pre-image that makes it possible
//
// ADR 0003 rejected pictures on the canvas partly because "a photograph put
// through invert(93%) hue-rotate(180deg) is not a photograph". That is true of
// a photograph painted naively, and answerable for one painted as its own
// pre-image — which is the same discipline the palette's `hexDark` already
// uses, and is proved the same way: by reimplementing the CSS filter above and
// showing the round trip closes, rather than by transcribing expected pixels.
// ---------------------------------------------------------------------------

const asHex = ([red, green, blue]: readonly number[]) =>
  toHex([red / 255, green / 255, blue / 255]);

describe("preimageDarkCanvasPixel", () => {
  /**
   * Colours a photograph is actually made of: greys, skin, foliage, a dark
   * shadow and a near-white highlight. Every one of them is inside the range
   * the filter can reach, which is roughly 0.07-0.93 per channel after the hue
   * rotation — the saturated primaries are not, and are covered separately.
   */
  const PHOTOGRAPHIC_SAMPLES: ReadonlyArray<[number, number, number]> = [
    [128, 128, 128],
    [222, 171, 138],
    [40, 50, 70],
    [150, 110, 90],
    [230, 230, 225],
    [90, 140, 100],
  ];

  it("round-trips through the real dark-mode filter", () => {
    for (const sample of PHOTOGRAPHIC_SAMPLES) {
      const painted = preimageDarkCanvasPixel(...sample);
      const landed = toRgb(throughDarkFilter(asHex(painted)));

      for (let channel = 0; channel < 3; channel++) {
        // Two 8-bit roundings and one matrix in between. Anything larger than
        // this would be a visible colour cast across the whole picture.
        expect(
          Math.abs(landed[channel] * 255 - sample[channel]),
        ).toBeLessThanOrEqual(2);
      }
    }
  });

  it("is the identity of the filter applied twice, for a mid grey", () => {
    // hue-rotate(180deg) is its own inverse and invert(93%) is affine, so the
    // whole transform has a closed-form reverse. A grey exercises the matrix
    // rows summing to one, which is what makes greys survive at all.
    expect(preimageDarkCanvasPixel(128, 128, 128)).toEqual(
      toRgb(throughDarkFilter("#808080")).map((channel) =>
        Math.round(channel * 255),
      ),
    );
  });

  it("clamps out-of-gamut channels rather than producing garbage", () => {
    // Pure red has no pre-image — it would need a channel above 1 — and a
    // photograph will contain pixels like it. The answer has to stay a legal
    // colour; NaN or a negative channel would corrupt the whole bitmap.
    const OUT_OF_GAMUT: ReadonlyArray<[number, number, number]> = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
      [0, 0, 0],
    ];

    for (const sample of OUT_OF_GAMUT) {
      for (const channel of preimageDarkCanvasPixel(...sample)) {
        expect(Number.isInteger(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });
});

const AVATAR_URL = "/api/users/u_1/avatar?v=av_1";

/**
 * A stand-in for `Image` that is really a canvas.
 *
 * jsdom never loads an `<img>`, and `vitest-canvas-mock` rejects a `drawImage`
 * source it does not recognise — so a hand-rolled fake object would be refused
 * by the very call under test. A canvas element is a legal source, jsdom can
 * make one, and a constructor that returns an object hands that object back
 * from `new`. Setting `src` fires the callback on a microtask, which is what
 * makes "the frame during the decode" a real state rather than a theory.
 */
const stubImageLoader = ({ fails = false } = {}) => {
  const constructed: HTMLCanvasElement[] = [];

  function FakeImage() {
    const node = document.createElement("canvas") as HTMLCanvasElement & {
      onload: (() => void) | null;
      onerror: (() => void) | null;
    };
    node.width = 64;
    node.height = 48;
    node.onload = null;
    node.onerror = null;
    Object.defineProperty(node, "src", {
      set() {
        queueMicrotask(() => (fails ? node.onerror?.() : node.onload?.()));
      },
    });
    constructed.push(node);
    return node;
  }

  vi.stubGlobal("Image", FakeImage);
  return constructed;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the avatar cursor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetCollaboratorAvatars();
  });

  it("falls back to the initial on the frame where the picture is still decoding", () => {
    // The render loop must never wait for a fetch. Until the bitmap exists this
    // peer is drawn as they would be with no picture at all — which is now
    // their initial rather than a crewmate, so the cursor does not change
    // shape twice on the way to being a photograph.
    stubImageLoader();
    const { ops } = paintCursor(THEME.LIGHT, {
      avatarUrl: AVATAR_URL,
      username: "yasmin",
    });

    expect(ops.some((entry) => entry.op === "drawImage")).toBe(false);
    expect(ops.find((entry) => entry.text?.length === 1)?.text).toBe("Y");
  });

  it("draws the picture, and not the crewmate, once it is decoded", async () => {
    stubImageLoader();
    paintCursor(THEME.LIGHT, { avatarUrl: AVATAR_URL });
    await settle();

    const { ops, points } = paintCursor(THEME.LIGHT, {
      avatarUrl: AVATAR_URL,
    });

    expect(ops.some((entry) => entry.op === "drawImage")).toBe(true);
    // Not one segment of the silhouette: the two glyphs are alternatives, not
    // layers, or the crewmate would show through a picture with transparency.
    expect(points).toEqual([]);
  });

  it("rings the picture in the collaborator's palette colour", async () => {
    stubImageLoader();
    paintCursor(THEME.LIGHT, { avatarUrl: AVATAR_URL, colorIndex: 7 });
    await settle();

    const { ops } = paintCursor(THEME.LIGHT, {
      avatarUrl: AVATAR_URL,
      colorIndex: 7,
    });

    // A photograph carries no reliable identity — it can be dark, busy, or of
    // somebody's cat — so the ring is the only thing guaranteeing that the
    // canvas and the DOM avatar still name the same person.
    expect(
      ops.filter((entry) => entry.op === "stroke").map((e) => e.strokeStyle),
    ).toContain(COLLABORATOR_PALETTE[7].hex);
  });

  it("uses the pre-inverted ring and ink in dark mode", async () => {
    stubImageLoader();
    paintCursor(THEME.DARK, { avatarUrl: AVATAR_URL, colorIndex: 7 });
    await settle();

    const { ops } = paintCursor(THEME.DARK, {
      avatarUrl: AVATAR_URL,
      colorIndex: 7,
    });
    const strokes = ops
      .filter((entry) => entry.op === "stroke")
      .map((entry) => entry.strokeStyle);

    expect(strokes).toContain(COLLABORATOR_PALETTE[7].hexDark);
    expect(strokes).not.toContain(COLLABORATOR_PALETTE[7].hex);
    // The same rule the crewmate's halo follows: white on the filtered canvas
    // arrives as #121212, so the light ink is #000000 there.
    expect(strokes).toContain("#000000");
    expect(strokes).not.toContain("#ffffff");
  });

  it("decodes a picture once, however many frames go past", async () => {
    // renderRemoteCursors is on the hot path. A decode per frame would be a
    // fetch per frame, at cursor frequency, for every peer on the board.
    const constructed = stubImageLoader();

    for (let frame = 0; frame < 5; frame++) {
      paintCursor(THEME.LIGHT, { avatarUrl: AVATAR_URL });
    }
    await settle();
    for (let frame = 0; frame < 5; frame++) {
      paintCursor(THEME.LIGHT, { avatarUrl: AVATAR_URL });
    }

    expect(constructed).toHaveLength(1);
  });

  it("caches per theme, because the pre-image differs between them", async () => {
    const constructed = stubImageLoader();

    paintCursor(THEME.LIGHT, { avatarUrl: AVATAR_URL });
    await settle();
    paintCursor(THEME.DARK, { avatarUrl: AVATAR_URL });
    await settle();

    expect(constructed).toHaveLength(2);
  });

  it("never retries a picture that failed, and never throws while rendering", async () => {
    const constructed = stubImageLoader({ fails: true });

    paintCursor(THEME.LIGHT, { avatarUrl: AVATAR_URL });
    await settle();

    // A 404 avatar that re-requested on every frame would be indistinguishable
    // from a network loop, and an exception here would take the whole
    // interactive canvas down with it.
    expect(() =>
      paintCursor(THEME.LIGHT, { avatarUrl: AVATAR_URL }),
    ).not.toThrow();

    // Still drawn, and drawn as a peer with no picture: their initial. A
    // failed avatar must degrade to the ordinary fallback rather than to
    // nothing on screen.
    const { ops } = paintCursor(THEME.LIGHT, {
      avatarUrl: AVATAR_URL,
      username: "yasmin",
    });
    expect(ops.find((entry) => entry.text?.length === 1)?.text).toBe("Y");
    expect(constructed).toHaveLength(1);
  });

  it("announces a decoded picture so an idle peer's cursor is repainted", async () => {
    // The interactive canvas has no continuous render loop, so without this a
    // peer who is not moving keeps their crewmate until they next touch the
    // mouse — which was one of ADR 0003's objections.
    const ready = vi.fn();
    const unsubscribe = onCollaboratorAvatarReady(ready);
    stubImageLoader();

    paintCursor(THEME.LIGHT, { avatarUrl: AVATAR_URL });
    await settle();

    expect(ready).toHaveBeenCalled();
    unsubscribe();
  });
});
