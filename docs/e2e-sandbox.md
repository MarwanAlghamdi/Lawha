# Running the e2e suite without touching your deployment

**The suite writes to whatever `LAWHA_E2E_BASE_URL` names.** `auth.setup.ts` registers an account on every run, and `openBoards.spec.ts` / `twoAccounts.spec.ts` register more and never delete them (known issue 30 — six runs against a live stack took it from 48 accounts to 70). Specs create boards, and `gridObjects.spec.ts` saves, leaves and reopens one.

None of that is a problem against a scratch server. All of it is a problem against the one holding your work. **The default `baseURL` is the dev server, not your deployment — keep it that way.**

## The sandbox

Two processes and a directory. Nothing here goes near `~/lawha-data`.

```bash
SANDBOX=~/lawha-e2e-sandbox
mkdir -p "$SANDBOX/files"

# 1. A server with its own database, on loopback only.
cd lawha-server
LAWHA_PORT=3007 LAWHA_HOST=127.0.0.1 \
LAWHA_DB_PATH="$SANDBOX/lawha.db" \
LAWHA_FILES_DIR="$SANDBOX/files" \
LAWHA_REQUIRE_AUTH=true \
LAWHA_ADMIN_USERNAME=e2eadmin LAWHA_ADMIN_PASSWORD=<anything> \
./node_modules/.bin/tsx src/index.ts

# 2. The app. Run it FROM excalidraw-app, not from the repo root.
cd excalidraw-app
../node_modules/.bin/vite --host 127.0.0.1 --port 3001
```

Then:

```bash
LAWHA_E2E_BASE_URL=https://127.0.0.1:3001 \
  ./node_modules/.bin/playwright test --project=grid-objects
```

## Three things that will catch you out

**Run vite from `excalidraw-app`.** Its config calls `loadEnv(mode, "../")`, which resolves against vite's `root`. Started from the repo root with `--config excalidraw-app/vite.config.mts`, `"../"` points at the parent of the checkout, no `.env.development.local` is found, and the proxy silently falls back to `http://localhost:3002`. That is the port the deployed server listens on _inside its container_, so the failure is a confusing `ECONNREFUSED` rather than a wrong-database disaster — but only by luck.

**It is https, not http.** `.env.development.local` sets `LAWHA_HTTPS_KEY`/`LAWHA_HTTPS_CERT`, so vite serves TLS. `curl` needs `-k`; Playwright already has `ignoreHTTPSErrors: true`.

**The first-boot banner is the isolation check.** `lawha: first boot — created administrator ...` in the server log means zero accounts, which means it is **not** looking at your data. `docs/backups.md` uses the same signal in the opposite direction: after a restore that banner means the restore failed.

## Proving it, rather than believing it

Before and after a run:

```bash
python3 -c "
import sqlite3
c=sqlite3.connect('file:$HOME/lawha-data/lawha.db?mode=ro',uri=True)
print(c.execute('SELECT COUNT(*) FROM users').fetchone()[0], 'users',
      c.execute('SELECT COUNT(*) FROM boards').fetchone()[0], 'boards')"
```

The counts must be identical. This takes two seconds and is the only check that actually settles it.

## Not the visual suite

Do not run `test:visual` against the sandbox, and never `test:visual:update` against it. The baselines are of the **deployment**; regenerating them here replaces a deployment baseline with a development one and blesses the difference as the new normal. Known issue 18 is the record of that going wrong. Visual runs want `LAWHA_E2E_BASE_URL=https://localhost` and eyes on the diff.

## Tearing it down

```bash
pkill -f "tsx src/index.ts"; pkill -f "vite --host 127.0.0.1 --port 3001"
rm -rf ~/lawha-e2e-sandbox
```

The sandbox is disposable by construction. That is the point of it.
