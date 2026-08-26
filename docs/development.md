# Development

**Node 18+ required.** Use `corepack yarn`, not `yarn` — it ensures the correct version.

## Install and run

```bash
corepack yarn install
corepack yarn dev              # app on :3001, lawha-server on :3002
```

The Vite dev server proxies `/api` and `/socket.io` to lawha-server, so the browser sees one origin. The session cookie stays first-party with no CORS and no `SameSite=None`. `http://localhost:3001` is a secure context by the `localhost` special case, so this works with no certificate.

## Commands

| Command | What it runs |
| --- | --- |
| `yarn dev` | App and server together on :3001 and :3002 |
| `yarn start` | App alone (needs server running separately) |
| `yarn start:server` | Server alone |
| `yarn lan` | Build the app, serve it from lawha-server. Use this for testing against a tunnel; modules over a tunnel are slow. |
| `yarn test:all` | **Does NOT include** `test:server` or `test:typecheck:server`. See below. |
| `yarn test:app` | Every vitest suite — 131 files, 2050 tests. Excalidraw's editor tests under `packages/`, and Lawha's own under `lawha-server/src/` and `excalidraw-app/lawha/`. |
| `yarn test:server` | A different runner: `node --test scripts/*.test.mjs` in lawha-server — backup, restore, encrypt-db and the deployment-config pins, 4 files, 125 tests |
| `yarn test:typecheck` | TypeScript over app + packages |
| `yarn test:typecheck:server` | TypeScript `--noEmit` in lawha-server |
| `yarn test:code` | ESLint `--max-warnings=0` |
| `yarn test:other` | Prettier (includes markdown) |
| `yarn test:visual` | A bare `playwright test`, so **all 13 projects** — not just the screenshots. See [End-to-end tests](#end-to-end-tests). |
| `yarn test:visual:update` | Regenerate visual baselines. Also bare, so also all 13 projects. |
| `yarn fix` | Prettier `--write` then ESLint `--fix` |

### `yarn test:all` does NOT include the server gates

`yarn test:all` runs typecheck, ESLint, Prettier and `test:app`. It excludes `yarn test:server` and `yarn test:typecheck:server`, both of which CI runs separately. Run them by hand before merging.

It does not leave the server untested, though it used to: `test:app` collects the seven vitest suites under `lawha-server/src/` (see below). What a green `test:all` actually leaves unrun is the server's typecheck and the four `node:test` script suites.

### What is and is not covered

`test:app` runs Excalidraw's editor tests **and** Lawha's own. Measured with `vitest list`, not recalled: 131 files and 2050 tests in all, of which 123 files are upstream's under `packages/`.

**Lawha's own code has a vitest suite: 8 files, 103 tests.** Seven are under `lawha-server/src/` — the trash sweep (15) and the account sweep (15), `getBoardAccess` and `listForUser` owner-derivation (13), the socket permission resolver (18), the four refusals on admin account deletion (15) and the shape of those routes (4), and the boards route ordering (2). The eighth is `excalidraw-app/lawha/mermaid/index.test.ts` (21). They ship with ADRs 0029, 0030 and 0031.

Several are integration tests rather than unit tests, and deliberately so: they call `openDatabase({ path: ":memory:" })`, which is a real SQLite database with every migration applied, and the two sweeps also write real file blobs into a temp directory. Every claim worth making about a cascade is a claim about the database — a stubbed repository would agree with whatever the test asserted.

Lawha's editor-side features are covered under `packages/` too, by `lawhaGridObjects.test.tsx` (24) and `lawhaSvgExport.test.ts` (9).

All of that runs under `yarn test:app`, not `yarn test:server`. `vitest.config.mts` excludes only `e2e/**` and `lawha-server/scripts/**`, so `lawha-server/src/**` is collected like any other source directory. `test:server` is `node --test scripts/*.test.mjs` and nothing else — backup, restore, encrypt-db and the deployment-config pins, 4 files and 125 tests. Backup and restore are covered because a silent backup failure has already cost this project real data.

**Coverage stops there**, and what is left over is still most of the app and the server. There is no request-level harness here, so no route is driven over HTTP at all — the admin account-deletion handler is pulled off the router's layer stack and called directly, and `boardsRouteOrder` reads registration order off that same stack. Sharing, invites, folders and tags have no suite, and the React client has none outside the mermaid parser and the two files above. All of that is held by the typechecker, the linter and review. The Playwright suite in `e2e/` covers sign-in, boards, invites and visual regression, but CI does not run it: `playwright.config.ts` expects a dev server already listening on `localhost:3001`, which CI does not provide. Run it yourself against a running dev server.

## Migrations

Migrations are plain SQL files in `lawha-server/src/db/migrations/`, applied in order and recorded in `schema_migrations`. Add a new numbered file; never edit one that has already run.

Run by hand:

```bash
corepack yarn --cwd lawha-server migrate
```

They also run automatically on boot.

## Database

```bash
# Password reset by hand
corepack yarn --cwd lawha-server reset-password <username> <new-password>
```

Do not copy `lawha.db` yourself (see [Backups](backups.md#the-hazard--read-this-first) for why). Use the backup command:

```bash
LAWHA_DB_PATH=~/lawha-data/lawha.db \
  corepack yarn --cwd lawha-server backup ~/lawha-backups
LAWHA_DB_PATH=~/lawha-data/lawha.db \
  corepack yarn --cwd lawha-server restore <backup-file>
```

## Docker stack

The supplied `docker-compose.yml` runs on a LAN with a gateway handling TLS. By default it is plain HTTP inside, behind an nginx proxy (ADR 0018); `LAWHA_TLS=on` adds an HTTPS listener to that same nginx server block (ADR 0022).

```bash
# Prerequisites: fill in ./.env and ./lawha.env from the examples
./run.sh                       # preflight, build, start, wait for health
./run.sh check                 # preflight only, changes nothing
./run.sh stop                  # stop the stack
./run.sh logs                  # follow the logs

docker compose ps              # who is healthy
docker compose logs lawha-server
```

## Dev and Docker together

The **dev server** on :3001 and the **Docker stack** on :9002 (or your configured port) may already be running. Check before starting or stopping either.

The stack publishes **two** host ports: plain HTTP (default 9002) and TLS (default 9443). Both mappings are unconditional. The TLS one answers only when `LAWHA_TLS=on`; with TLS off a connection to 9443 is refused, because nothing inside is listening. It is published anyway because a conditional port does not exist in compose without a second file or a profile, and either is a place for the two halves of "TLS is on" to disagree — the cost of leaving it published is one docker-proxy socket.

Never port 80 or 443 — those belong to the portless gateway, and taking either removes every other project's name from the network.

## Traps

### `window.h` and `window.collab` do not exist in a production build

Both are gated on `isTestEnv() || isDevEnv()`, so any probe that reaches through them reads empty rather than failing loudly. This is why **`e2e/persistence.spec.ts` cannot be run against the Docker stack.** It only works against `yarn dev`. The visual specs have no such dependency and render against any origin — but `yarn test:visual` is a bare `playwright test`, so it would drag `persistence.spec.ts` along with them. Filter to the screenshot projects:

```bash
LAWHA_E2E_BASE_URL=http://localhost:9002 \
  yarn test:visual --project='*-light' --project='*-dark'
```

### Do not serve the dev server over a tunnel

Vite hands the browser roughly 885 module requests; across a tunnel each one pays the round trip and the canvas takes most of a minute. Use `yarn lan` instead — it builds the bundle and serves it from lawha-server: 20 requests, canvas in about 250 ms. (Invariant 14 in `docs/lawha-roadmap.md` §2; `excalidraw-app/vite.config.mts` cites it by that name. ADR 0014 is about invite codes and says nothing about tunnels.)

### The eslint checker in the Vite dev server eats memory

`vite-plugin-checker` runs `eslint "./**/*.{js,ts,tsx}"` on every dev start and can OOM on this monorepo. Put `VITE_APP_ENABLE_ESLINT=false` in `.env.development.local` (gitignored) and lint separately with `yarn test:code`. `.env.production` already disables it.

### The fonts file is string-replaced at build time

Anything added to `packages/excalidraw/fonts/fonts.css` works perfectly in dev and vanishes in production. `scripts/woff2/woff2-vite-plugins.js` rewrites that file during the build. Lawha's own fonts load from `excalidraw-app/lawha/fonts.ts`.

### Assert on the artefact, not on a proxy for it

A "drew a rectangle" check that counts `<canvas>` elements passes on an empty board. A drag fired in one tick leaves a zero-size shape that the sync layer correctly discards. Assert on painted pixels, element dimensions, stored ciphertext length.

## Upstream Excalidraw

Lawha is a fork of Excalidraw. The divergence is capped by invariant 10 in `docs/lawha-roadmap.md` to make upstream merges tractable. Before adding a new diverged file, write an ADR — this constraint is load-bearing. Measure the actual divergence rather than trusting a stale count:

```bash
# once per clone — a fresh clone has only `main`, and this needs upstream
git remote add upstream https://github.com/excalidraw/excalidraw.git
git fetch upstream

# See what diverged since the last merge
git diff --stat $(git merge-base upstream/master main)..main -- packages/
```

## End-to-end tests

Playwright defaults to the **dev server**, not the Docker stack: `baseURL` is `process.env.LAWHA_E2E_BASE_URL ?? "http://localhost:3001"` (`playwright.config.ts:189`), and the config deliberately has no `webServer` block, so one has to be running already. Start it with `yarn dev`.

`yarn test:visual` is a bare `playwright test`, which runs **every project in the list**: 13 projects, 56 tests across 8 spec files, counted with `playwright test --list`. That is `setup` and `cleanup`, the six visual projects (3 viewports × 2 themes), then `behaviour`, `grid-objects`, `open-boards`, `two-accounts` and `invite-codes`. The last five register accounts and create boards. `playwright.config.ts` comments that it puts them last, and it does — but last is not excluded, and nothing in the default run skips them.

`two-accounts` throws in `beforeAll` unless **both** `LAWHA_E2E_OWNER` and `LAWHA_E2E_OWNER_PASSWORD` name an account that already has boards, because it asserts against both converted and still-encrypted scenes:

```bash
LAWHA_E2E_BASE_URL=https://localhost \
LAWHA_E2E_OWNER=<username> \
LAWHA_E2E_OWNER_PASSWORD=<password> \
  yarn test:e2e:accounts
```

The visual specs themselves render against any origin, including the built Docker stack. `behaviour` (`e2e/persistence.spec.ts`) does not: it drives the editor through `window.h`, which a production bundle does not have (see the trap above). So when the target is the built stack, filter to the screenshot projects rather than running the suite bare:

```bash
LAWHA_E2E_BASE_URL=http://localhost:9002 \
  yarn test:visual --project='*-light' --project='*-dark'
```

`--project` selects one project per occurrence, so repeat the flag or use a glob; the `setup` and `cleanup` dependencies are pulled in either way. Verified on Playwright 1.61.1.

Whatever `LAWHA_E2E_BASE_URL` names, the suite registers accounts and creates boards on it. Run it against a scratch server, never your deployment — [docs/e2e-sandbox.md](e2e-sandbox.md) has the two commands and the checks that prove the isolation held.
