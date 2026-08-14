# 0016 — Lawha serves its own assets and reports to nobody

**Status:** accepted.

**Affects:** `scripts/woff2/woff2-vite-plugins.js`, `excalidraw-app/index.html`, `e2e/visual.spec.ts` and its baselines.

## Context

Lawha's whole claim is that it runs on your machine and your boards stay there. Two things in the production build were quietly untrue about that, both inherited from upstream, and neither was visible from inside the app.

**Fonts came from a CDN.** `woff2-vite-plugins.js` set `EXCALIDRAW_ASSET_PATH` to `https://excalidraw.nyc3.cdn.digitaloceanspaces.com/oss/` with the deployment's own origin as a fallback, and emitted four `<link rel="preload">` tags pointing straight at it. Right for excalidraw.com; wrong here.

**Every page view was reported to Simple Analytics.** `index.html` appended `https://scripts.simpleanalyticscdn.com/latest.js` on any `PROD` build, under a comment reading "100% privacy friendly analytics".

Both were found by accident, and that is the part worth recording. Nothing in the product misbehaved: `font-display: swap` meant text still appeared, and analytics is invisible by design. What surfaced them was measuring a page load while trying to work out why the visual-regression suite could not run.

```
DOMContentLoaded   141 ms
load            30,038 ms    ← four fonts, ERR_TIMED_OUT at 30s each
```

**That 30-second `load` is why the baselines had gone stale and could not be regenerated.** `auth.setup.ts` waits for `load` on a 30s budget, so the setup step timed out, so every visual project was skipped. Known issues 18 and 29 had been recording the baselines as increasingly out of date for several batches without anyone establishing that the suite was simply unable to run.

## Decision

**Neither the app nor its assets may reach an origin the operator did not choose.**

1. **Fonts are served by the deployment.** `EXCALIDRAW_ASSET_PATH` is `"/"`, the preload tags are same-origin, and the `@font-face` sources are the local files. Nothing was added to the image to make this work — **all 267 woff2 files were already there**, including the exact hashed filenames being requested from the CDN. `/fonts/Excalifont/Excalifont-Regular-a88b….woff2` answers 200 with 24,956 bytes from nginx. The CDN round trip was buying nothing.
2. **The analytics loader is deleted, not disabled.** Upstream's "100% privacy friendly" is a claim about how the vendor handles the data. It is not a claim about whether the request happens — and here the request _is_ the disclosure: it tells `simpleanalyticscdn.com` that this deployment exists, from which address, and which page was opened. `packages/excalidraw/analytics.ts` guards every call on `window.sa_event`, so removing the loader makes the tracking calls no-ops with **no `packages/` change** (invariant 10).

Measured after, on `/signin` and `/home`:

```
load 143 ms / 169 ms       off-origin requests: NONE
```

`/signin` went from 30,038 ms to 143 ms — the fonts were never slow, they were unreachable.

## Consequences

**This is the kind of change an upstream merge silently reverts.** Both edits are to files upstream owns and actively maintains — a build plugin and the app's `index.html` — and both would come back as an innocuous-looking conflict resolution. That is the whole reason this is an ADR rather than a commit message. **After any merge from upstream, load a page and check the network panel is empty.** It is a ten-second check and it is the only one that catches this.

**The visual suite runs again, and the baselines are regenerated — with eyes on the diff**, which is what known issue 18 asked for and why nobody had done it. What the diffs actually showed:

- **the sign-in and sign-up screens still claimed "Boards are end-to-end encrypted"** — a baseline predating ADR 0012, still asserting the thing that ADR removed;
- **the dashboard predated the Tags button** and the header consolidation;
- **the account panel predated the colour picker** replacing the read-only "Your colour" row.

Every one was the baseline being behind, not the build being wrong. 10 updated, 32 green.

**`canvas-signed-out` and its six baselines are deleted.** The test screenshotted `/` for a visitor with no account, back when that was a scratch canvas; `LandingRoute` now sends them to `/signin`. It was failing on a missing canvas element rather than on a pixel diff — the failure mode that means a test is about something else now. The behaviour is pinned in `signedOutEntry.test.tsx` and the screen it lands on is `signin.png`. 36 baselines became 30.

**The suite must be pointed at the built stack.** `LAWHA_E2E_BASE_URL=https://localhost`, which is what these were regenerated against. Known issue 18's standing warning still holds: the suite screenshots whatever origin it is given, so regenerating against a dev server would silently replace a deployment baseline with a development one.

**What this does not claim.** Lawha still fetches nothing at runtime from anywhere but its own origin — but that is a property of the current build, not something enforced by a test. A CI check that fails on any off-origin request during a page load would make it enforced rather than merely true, and does not exist yet.
