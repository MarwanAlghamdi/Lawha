# ADR 0003 — Crewmate cursors, a twelve-colour wheel, and an ink that survives the dark filter

**Status:** accepted, **superseded in part by ADR 0006** — pictures are no longer DOM-only, and a peer's picture can now be fetched, because the server announces each socket's identity. The two statements 0006 reverses are marked below; everything else here stands. **Affects:** `packages/excalidraw/clients.ts`, `packages/common/src/colors.ts`, `excalidraw-app/lawha/**` **Supersedes in part:** ADR 0001 (the contrast claim), ADR 0002 (where the colour is chosen)

## Context

Three things came back from using the product, and one of them was a false claim in ADR 0001.

**The cursor was an arrow.** Upstream's four-point arrow says "pointer"; it says nothing about who. Lawha shows the same person as a cursor on the canvas and as an avatar in the DOM, and the canvas half carried no identity beyond a colour.

**The colour was a preference, and preferences collide.** ADR 0002 wired the account's colour picker through to the canvas. That worked, but two people picking blue is not a hypothetical on a five-value palette — it is the common case on a board of four. The colour is now assigned by the server at registration, cycling the palette so the first N accounts on a server are guaranteed distinct, and the picker is gone. What is left for the user to choose is their _laser_ colour, which is decoration rather than identity.

**ADR 0001's contrast claim was not true as built.** It said the cursor's name chip, filled with the user's colour and labelled in white, "clears 4.5:1 against all five". Measured:

| entry            | white on `hex` (light) | label on chip, as seen (dark) |
| ---------------- | ---------------------- | ----------------------------- |
| blue `#0f74c5`   | 4.86                   | **3.86**                      |
| green `#278733`  | 4.57                   | **4.10**                      |
| red `#b94642`    | 5.23                   | **3.58**                      |
| purple `#8059bb` | 5.17                   | **3.63**                      |
| amber `#a87600`  | **4.00**               | 4.69                          |

One light failure and four dark ones. The dark column is the interesting one, and it is a consequence the ADR did not follow through: `.excalidraw__canvas.interactive` carries `filter: invert(93%) hue-rotate(180deg)` in dark mode, so `COLOR_WHITE` painted there arrives on screen as **`#121212`** — a near-black. Every "white outline" in `clients.ts` was, in dark mode, a black one, and the white label was black text on a mid-tone chip.

## Decision

### 1. The cursor is a crewmate

`traceCrewmate` in `clients.ts` traces a silhouette — backpack, domed body, two feet — into the current path, in the `width` x `height` box anchored at the pointer position. The box grew from 11x14 to 18x22; the clamp, the out-of-bounds test and the name-chip anchor all read those two numbers, so nothing else needed to move.

Painted in three passes: a halo stroke, the body filled in the collaborator's assigned colour, then a visor and one highlight. The halo is what separates a mid-lightness body from a dark canvas.

Drawn inside `clients.ts` rather than in a new module on purpose. The `packages/` divergence is capped at four files by ADR 0001 and 0002; a `crewmate.ts` would have made it five for no benefit, since the only caller is twenty lines away.

The speaking halo, the click ripple and the name chip are unchanged in intent. The halo now traces the crewmate rather than the arrow, because a green arrow poking out from behind a crewmate is not a halo.

### 2. There is no pre-image of white, so "white" is theme-dependent

Painting `#000000` on the dark interactive canvas lands on `#ededed`; pure white would need a negative channel and is simply unreachable. So `cursorInk(theme)` returns `COLOR_WHITE` in light and `#000000` in dark, and every light ink — halo, visor highlight, chip border, label — goes through it. The visor gets the same treatment: `#bcd8ec` and its exact pre-image `#03233a`.

The result is that the cursor looks the _same on screen_ in both themes, which is the whole point of the pre-image discipline (invariant 16) and was already true of the body colour alone.

### 3. Twelve colours, chosen so both themes clear AA

`COLLABORATOR_PALETTE` goes from five entries to twelve, each gaining a `hue` so the picker can lay them out as a wheel. Indices 0–4 keep their names and their meaning: `users.color_index` rows hold these indices, and reordering the array would repaint every existing account.

Every entry is now chosen against two constraints the original five did not meet:

- **`hexDark` is inside sRGB.** Three of the original five (blue, red, amber) had a pre-image that required an out-of-range channel and was clamped, so what they rendered in dark mode was a visibly different colour from what they rendered in light. All twelve now round-trip to within one 8-bit step, and `clients.test.ts` reimplements the CSS filter to prove it rather than transcribing a table.
- **4.5:1 against the label in both themes.** In dark mode the chip appears as `hex` and the label as `#ededed`, which is the stricter of the two directions. Every entry clears 4.6:1 there and better than 5.3:1 against white.

The cost is chroma: holding luminance low enough for AA against `#ededed` caps OKLCH C at roughly 0.09–0.175 depending on hue, so these are muted colours rather than vivid ones. Readability of a name won over saturation of a dot.

### 4. Where each control lives now

| control | before | now |
| --- | --- | --- |
| cursor colour | account page picker | assigned by the server; account page shows it |
| laser colour | account page picker (broken) | popover on the canvas top bar |
| profile picture | did not exist | account page; appears in DOM surfaces only |
| sign out | account page _and_ canvas menu | canvas menu only |

The laser picker moved to the canvas because that is where the laser is. It was also **broken** where it was: the account form marked `laserColorIndex` dirty but built its PATCH body from `username` and `colorIndex` only, so changing nothing but the laser colour sent `{}` and the server answered 400 "Nothing to update". A setting that cannot be saved is worse than one that is missing.

Profile pictures are DOM-only — account panel, presence stack, top-bar chip. They are deliberately **not** on the canvas cursor: a photograph put through `invert(93%) hue-rotate(180deg)` is not a photograph, and there is no per-collaborator image to fetch anyway (see Consequences).

> **Reversed by ADR 0006.** The filter argument is about applying it _forward_; both halves are invertible, so the bitmap is pre-imaged before it is drawn. The missing per-collaborator image was solved by the wire-format change this ADR left to whoever owned `Collab`. Pictures on the cursor are opt-in per account and off by default.

## Alternatives rejected

**Keep white and darken the palette until it clears 4.5:1 against `#121212`.** That is the other way to fix the dark column — but `#121212` on a mid-tone chip is a _dark_ label, so the chip would have had to become pale, and a pale chip cannot also be the cursor's body colour. One ink that is light in both themes keeps a single palette doing both jobs.

**Draw the crewmate as an SVG overlay in the DOM, where pictures work.** Would duplicate pointer interpolation, idle alpha, the edge clamp and follow mode — the same argument ADR 0001 made against DOM cursors, and it has not got weaker.

**Let users keep picking their colour, and merely warn on collision.** A warning that two people clash is a warning about something the server already knows and can simply prevent.

## Consequences

- `packages/` divergence stays at four files. `clients.ts` and `common/src/colors.ts` were already two of them.
- **`COLLABORATOR_PALETTE_SIZE` in `lawha-server/src/lib/validation.ts` is a hand-copied `5`** and bounds `colorIndex`/`laserColorIndex` on `PATCH /api/auth/me`. Until it is raised to 12, indices 5–11 are rejected with a 400 and more than half the wheel is unreachable. That file belongs to the server package; `clients.test.ts` asserts the client-side number, which is where its own comment says the bound is checked from.
  > **Closed, one phase later than it should have been.** It is `12` now. It stayed at `5` because the sentence above is wrong about where the bound is pinned: `clients.test.ts` cannot see the server's constant, and the server's own "rejects a colour outside the palette" test used the literal `9`, which stopped meaning "outside the palette" the moment the wheel grew. A stale test and a stale bound agreed with each other. See ADR 0006's consequences.
- **Only your own profile picture can be shown.** Excalidraw's collaborator map is keyed by socket and carries a username, an idle state and a palette index — no account id — so there is nothing to fetch a peer's picture _by_. Peers keep initials on their assigned colour, which is the same identity their cursor shows. Putting a user id on the pointer payload would fix it and is a wire-format change, i.e. a decision for whoever owns `Collab`.
  > **Taken, by ADR 0006** — but not on the pointer payload, which is client-claimed and would let a guest assert someone else's account. The relay announces it on its own event instead.
- The presence stack no longer derives its own colour. `getPresenceColor` delegates to `getClientColor`; it used to hash the id and ignore `colorIndex`, which reproduced exactly the cursor-versus-avatar drift ADR 0001 exists to prevent. Likewise `LawhaTopBar.scss` no longer hardcodes `--lw-presence-0` for the account chip.
- Anyone merging upstream should expect `clients.ts` to conflict. Keep the palette lookup, the ink helper and the crewmate; re-apply them over whatever upstream does to the surrounding code.
