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
| `yarn test:app` | The editor's own suite, under `packages/` — 117 files, 1788 tests |
| `yarn test:server` | The backup and restore scripts, under `node:test` — 3 files, 110 assertions |
| `yarn test:typecheck` | TypeScript over app + packages |
| `yarn test:typecheck:server` | TypeScript `--noEmit` in lawha-server |
| `yarn test:code` | ESLint `--max-warnings=0` |
| `yarn test:other` | Prettier (includes markdown) |
| `yarn test:visual` | Playwright visual regression, 3 viewports × 2 themes |
| `yarn test:visual:update` | Regenerate visual baselines |
| `yarn fix` | Prettier `--write` then ESLint `--fix` |

### `yarn test:all` does NOT include the server gates

`yarn test:all` runs typecheck, ESLint, Prettier and app tests. It excludes `yarn test:server` and `yarn test:typecheck:server`, both of which CI runs separately. Run them by hand before merging; a green `test:all` says nothing about the server.

### What is and is not covered

`test:app` runs Excalidraw's tests for the editor. `test:server` runs the backup and restore scripts — covered because a silent backup failure has already cost this project real data.

**Lawha's own application and server code has no unit or integration suite.** Changes there are held by the typechecker, the linter and review. The Playwright suite in `e2e/` covers sign-in, boards, invites and visual regression, but CI does not run it: `playwright.config.ts` expects a dev server already listening on `localhost:3001`, which CI does not provide. Run it yourself against a running stack.

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

The supplied `docker-compose.yml` runs on a LAN with a gateway handling TLS. It is plain HTTP inside, behind an nginx proxy.

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

The stack publishes one host port (default 9002). Never port 80 — that belongs to the portless gateway, and taking it removes every other project's name from the network.

## Traps

### `window.h` and `window.collab` do not exist in a production build

Both are gated on `isTestEnv() || isDevEnv()`, so any probe that reaches through them reads empty rather than failing loudly. This is why **`e2e/persistence.spec.ts` cannot be run against the Docker stack.** It only works against `yarn dev`. The visual suite has no such dependency and runs anywhere; point `LAWHA_E2E_BASE_URL` at the origin:

```bash
LAWHA_E2E_BASE_URL=http://localhost:9002 yarn test:visual
```

### Do not serve the dev server over a tunnel

Vite hands the browser roughly 885 module requests; across a tunnel each one pays the round trip and the canvas takes most of a minute. Use `yarn lan` instead — it builds the bundle and serves it from lawha-server: 20 requests, canvas in about 250 ms. (ADR 0014 §4 is written down.)

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

Playwright runs against the **built** Docker stack, not the dev server. This is because `window.h` and `window.collab` are gated on `isTestEnv() || isDevEnv()` and are simply absent in a production build.

```bash
LAWHA_E2E_BASE_URL=http://localhost:9002 yarn test:visual
```

The `two-accounts` suite needs an account that already has boards (to test both converted and still-encrypted scenes):

```bash
LAWHA_E2E_BASE_URL=https://localhost \
LAWHA_E2E_OWNER=<username> \
LAWHA_E2E_OWNER_PASSWORD=<password> \
  yarn test:e2e:accounts
```

Both create boards and are kept out of the default run.
