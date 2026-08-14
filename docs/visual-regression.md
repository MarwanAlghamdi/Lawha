# Visual regression suite

Playwright screenshot diffing across the three viewports x two themes matrix called for in the roadmap (`docs/lawha-roadmap.md`, "No Playwright" under Phase 3 risks): phone (390x844), tablet (834x1112), and desktop (1440x900), each in light and dark — six projects, one spec file, run against every project.

## Running it

A dev server must already be running at `http://localhost:3001` (`yarn dev` or `yarn lan`) — this suite does not start its own; it just points at it.

```bash
yarn test:visual           # run the suite against the committed baselines
yarn test:visual:update    # regenerate the baselines
```

Both are thin wrappers around `playwright test` / `playwright test --update-snapshots`, so any Playwright CLI flag works too, e.g.:

```bash
npx playwright test --project=desktop-dark
npx playwright test --grep "sign in screen"
npx playwright show-report
```

## What it covers

One spec, `e2e/visual.spec.ts`, run once per viewport x theme project:

| Route         | State                                             |
| ------------- | ------------------------------------------------- |
| `/signin`     | signed out                                        |
| `/signup`     | signed out                                        |
| `/`           | signed out (canvas)                               |
| `/`           | signed in (dashboard, zero boards)                |
| `/account`    | signed in                                         |
| `/b/:boardId` | signed in, board created through the dashboard UI |

Theme is set via a `page.addInitScript` that writes `excalidraw-theme` to `localStorage` before the app's first script runs — that key is `STORAGE_KEYS.LOCAL_STORAGE_THEME` in `excalidraw-app/app_constants.ts`, read once by the app at boot.

## The shared account

Registration is rate-limited to 40 requests/hour per IP. Rather than registering per test (or per project), `e2e/auth.setup.ts` registers exactly **one** account per suite run — a disposable `pw-visual-<timestamp>` user — and every project reuses its session via a Playwright `storageState` file (`e2e/.auth/user.json`, gitignored). `e2e/auth.teardown.ts` deletes that account again after every project has finished, so repeated runs don't accumulate throwaway accounts on the server.

`/signin` and `/signup` redirect a signed-in visitor away (`RedirectIfSignedIn` in `excalidraw-app/routes/SessionGate.tsx`), so those two tests — and the signed-out canvas test — override `storageState` back to empty for just that `test.describe` block.

The `/b/:boardId` test creates its board by clicking "+ New board" on the dashboard rather than deep-linking to a fabricated id. Board keys are end-to-end encrypted and never leave the browser (`excalidraw-app/data/boardKeys.ts` stores them in IndexedDB); only the UI flow generates a key, remembers it, and _then_ calls `POST /api/boards`. A deep link to an id nobody's browser holds a key for renders the "this board is locked here" state instead of a canvas. That test deletes the board again once it has its screenshot, which is what keeps the dashboard screenshot (captured earlier in the same project, before any board exists) stable at zero boards run after run.

## Why `workers: 1`

Every project shares the one account above, and the dashboard baseline assumes it owns zero boards. If two projects' tests interleaved, one project's "create a board" step could land in the moment between another project's dashboard navigation and its screenshot, and the board count in that screenshot would no longer match the baseline. `playwright.config.ts` runs the whole suite serially (`workers: 1`, `fullyParallel: false`) to make that race impossible rather than merely unlikely. For a suite this size (six projects x six specs = 36 screenshots) that costs roughly a couple of minutes, not the run.

## Masking

`toHaveScreenshot()` runs with a `maxDiffPixelRatio: 0.02` tolerance for antialiasing drift, plus an explicit `mask` on everything else that is not deterministic between runs:

- `canvas` — every canvas layer (static grid, interactive, new-element); Excalidraw's dot grid and edge antialiasing are not pixel-stable run to run.
- `.lw-board-card__meta` — the board id and its "3 days ago"-style relative age.
- `.lw-board-card__live` — the "N editing" presence chip.
- `.lw-account-panel__identity`, `.lw-account__avatar`, `.lw-account__name` — the generated username and its avatar initials, wherever they appear.
- `.UserList__wrapper` — the collaborator presence list; empty today, but its content is live presence data.

Autofocused, empty inputs (the username field on `/signin` and `/signup`) also blink a text caret whose phase is not deterministic at capture time; every test blurs focus (`document.activeElement.blur()`) immediately before its screenshot for that reason, independent of masking.

## Baselines

Expected screenshots live under `e2e/visual.spec.ts-snapshots/` and **are** committed — only run artifacts (`test-results/`, `playwright-report/`) and the shared-account session (`e2e/.auth/`) are gitignored. Regenerate them with `yarn test:visual:update` whenever a UI change is intentional, review the diffs like any other change, and commit the updated PNGs alongside it.
