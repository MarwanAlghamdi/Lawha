# lawha-server

The self-hosted half of Lawha: a socket.io relay, a REST API, and a SQLite store. One process, no external services.

## What it does and does not do

Scenes, socket traffic and image files are stored and relayed **in the clear**. This paragraph used to say the opposite — "the room key lives in the URL fragment", "a ciphertext store and a message relay" — and it stopped being true in two steps. [ADR 0011](../docs/adr/0011-server-recoverable-escrow.md) gave the server a copy of every account's key so an administrator could reset a password without destroying that account's boards, at which point the encryption was no longer protecting scenes _from_ the server; [ADR 0012](../docs/adr/0012-no-encryption.md) removed it rather than keep paying a locked screen, a password prompt and a padlock for a property it had stopped buying. Migration 013 dropped `account_keys`, `board_keys` and `server_escrow_keys`, so there is nothing left here to decrypt with.

**Authorization is `resolveBoardPermission` and nothing else.** That makes invariant 21 — _a permission enforced in one layer is not enforced_ — load-bearing alone: the scene write, the relay's broadcast path, the client's view mode and the file upload all check `canEdit`, and there is no longer a second mechanism that would make a mistake there merely embarrassing.

Encryption at rest is a separate and opt-in thing that changes none of the above. `LAWHA_DB_KEY` (SQLCipher) and `LAWHA_BACKUP_RECIPIENT` (`age`) protect a copied _file_ — a stray `lawha.db`, an old drive, an archive that leaves the building — not a running server or a stolen machine. [ADR 0020](../docs/adr/0020-encryption-at-rest.md) is precise about which half protects what, and both are unset on this deployment.

That leaves one consequence worth stating plainly: **the server cannot merge two divergent scenes.** Firestore used to do that inside a transaction. Here the server enforces compare-and-swap on a monotonic `rev` and returns `409` with its current copy; the client reads the winner's copy, reconciles per element with `reconcileElements`, and retries. Merging is element-wise and never deletes, which is a thing only the editor knows how to do. See `src/db/repositories/scenes.ts` and `excalidraw-app/data/storage/lawha.ts`.

It also means the server cannot recover work on its own. Persistence is entirely client-driven, so a scene is only as durable as the last successful `PUT`.

## Identity

Username and password. **There is no email column, no email field in any request or response, and no mail-based recovery.** This is deliberate, not an omission — please do not add SMTP "for convenience".

An email column existed briefly and was removed again in migration 003. The reasoning is worth keeping: this is a private network with a named administrator, so the recovery path is a phone call, not a link in an inbox. An address nobody sends to is a field to mistype and a record to keep safe for no benefit.

### The first way in

On a database with **no accounts at all**, the server creates one administrator at boot and prints it once, in a box, on stdout — `docker compose logs lawha-server`. There is nothing to register first and nothing to guess. `src/lib/firstBootAdmin.ts`.

- The account is called `admin`, or `LAWHA_ADMIN_USERNAME` if that is set. `admin` is a reserved username, so nobody can have squatted on it before your first boot.
- The password is `LAWHA_ADMIN_PASSWORD` when that is set and passes the ordinary 8-character minimum, and a generated 24-character one otherwise.
- **Only a password the server generated is ever printed.** Echoing `LAWHA_ADMIN_PASSWORD` back would copy a secret out of your environment into a log file, a systemd journal and `docker compose logs`, none of which you asked for. A configured password gets one line saying the account was created, and nothing else. A hash is never printed either — useless to you, useful to an attacker.
- A refused `LAWHA_ADMIN_PASSWORD` does not leave the server without an admin. The refusal is printed on the boot log and a generated password is seeded instead, because failing closed here would mean nobody can ever sign in.
- It is **idempotent, and silent when it does nothing.** Any existing account means you have been through this once, and a banner on every restart trains you to scroll past the one that matters. That silence is also a free check after a restore: if you see the banner, the database it opened has zero accounts in it and you are not looking at your data.

The generated alphabet drops `l`, `1`, `I`, `0` and `O`, because this password's whole life is being read off a terminal and typed into a browser, quite possibly over the phone.

`LAWHA_ADMIN_PASSWORD` is read at the moment that first account is created and never again. It is not a way to change an existing account's password — a value sitting in an environment file that silently reset someone's credentials on every restart would be a back door, not a setting. Use the admin panel or the CLI below for that.

Separately, a **registration** becomes an administrator when the server currently has no administrators at all. That is how the role came into being before first-boot seeding existed, and it is still the fallback if every admin is deleted. `LAWHA_ADMIN_USERNAME` promotes its account on every boot, which is the way back from an accidental demotion. The server refuses to remove the last administrator.

### When someone forgets their password

Three ways, in order of convenience:

1. **The admin panel.** Any administrator sees an Administration card in their account settings: pick the account, set a new password, read it out. Every session that account had is revoked.
2. **The master password.** With `LAWHA_MASTER_PASSWORD` set, there are two ways to use it. `POST /api/auth/master` takes the password alone and signs you in as this server's administrator — that is the **Master password** segment on the prompt at `/admin`, and the way back in when everyone is locked out. `POST /api/auth/login` with `{username, password, master: true}` signs you in as _any_ named account, which is how you reproduce a problem on somebody else's. Either way the session belongs to a real account, is flagged `via_master`, says so in the UI, and is written to the server log — so an administrative action taken this way still names a person. Both share one budget: ten verifications per fifteen minutes, globally, spent by ordinary mistyped passwords too; the root README explains why that has to be global and what it costs.
3. **The CLI**, when nobody can reach the UI at all:

   ```bash
   yarn --cwd lawha-server reset-password <username> <new-password>

   # inside the Docker stack, where only the build output is present:
   docker compose exec lawha-server node dist/cli/reset-password.js <username> <new-password>
   ```

   That revokes every session for the user.

Granting the administrator role rather than a password is a separate list, and every mechanism that exists is written out in [`docs/operating.md`](../docs/operating.md#make-someone-an-administrator).

## This process cannot serve HTTPS — and it does not need to

State the boundary before the commands, because it decides which command is the right one.

`src/index.ts` calls `node:http`'s `createServer`, and there is no `LAWHA_HTTPS_KEY`/`LAWHA_HTTPS_CERT` in `src/config.ts`. This process speaks plain HTTP and nothing else. (`LAWHA_HTTPS_*` do exist — they configure the **Vite dev server** in `excalidraw-app/vite.config.mts`, not this one.)

This heading used to end "and Lawha needs HTTPS", and the section under it said the app could not function without a secure context, because every board key was minted with `window.crypto.subtle` and creating a board on `http://192.168.x.x` died with `Cannot read properties of undefined (reading 'generateKey')`. Both halves are retired. [ADR 0012](../docs/adr/0012-no-encryption.md) removed the board keys — `onNewBoard` mints an id with `window.crypto.getRandomValues`, which plain HTTP exposes, so a board created over `http://` works — and [ADR 0018](../docs/adr/0018-plain-http-behind-a-gateway.md), titled "the end of invariant 18", replaced the assertion with the measurement that should have been taken the first time:

| Without `window.crypto.subtle` | What actually happens |
| --- | --- |
| Image ids — `generateIdFromFile` SHA-1s the bytes | Already `try/catch`'d upstream (`packages/excalidraw/data/blob.ts`), falling back to `nanoid(40)`. Uploads work; the same image uploaded twice is stored twice. |
| `navigator.clipboard` — the two copy buttons | `undefined`. Both call sites already had a `try/catch`; one failed **silently**, which was the real bug. The button now hides itself and shows the manual path instead. |
| A board written before ADR 0012 | Cannot be decrypted. The only real loss, and only for legacy ciphertext: a fresh database has none, and the export loop reports the affected board into `skipped` rather than refusing all of them. |

That is degraded, not inert, and the code says so where it used to refuse: `assertSecureContext` threw at the top of board import and export, and is now `secureContextNote()` in `excalidraw-app/lawha/home/boardTransfer.ts`, which returns the first row of that table as a sentence for the report and never throws.

So plain HTTP on the LAN is the supported deployment, and the one this repo ships. A gateway holds port 80 and maps a name like `http://lawha.local` onto the port this stack publishes (`${LAWHA_PUBLISHED_PORT:-9002}` → 8080); nothing here terminates TLS unless you opt in with `LAWHA_TLS=on`, which adds an 8443 listener beside the plain one ([ADR 0022](../docs/adr/0022-optional-tls-and-a-cookie-that-follows-the-scheme.md)).

**What plain HTTP does cost is not in that table**, and ADR 0018's own amendment states it: the session cookie crosses the LAN in the clear on every request. Anyone who can watch the wire — another machine on the same Wi-Fi, a port mirror, a guest on the office network — can capture it and be that user, with no password to crack, and the audit log records the account rather than the transport. It was accepted because the alternative on the table was a certificate warning people learn to click through, which is worse than no TLS because it trains them past the warning everywhere else. The honest summary is that Lawha on this network is as private as the network is: reasonable for a LAN you control, poor on shared Wi-Fi, and a decision rather than an assumption.

## Running it

**For real use on a LAN or a tailnet**, use Docker: nginx serves the built app and reverse-proxies `/api` and `/socket.io` to this process over one plain-HTTP port — `8080` in the container, published as `9002` — so the browser still sees one origin. That is what keeps the session cookie first-party: no `SameSite=None` and no CORS preflight.

`lawha.env.example` is committed at the repo root and holds every `LAWHA_*` setting with a note on what breaks if it is wrong; the copy is gitignored and is where your secrets go.

```bash
cp lawha.env.example lawha.env   # then read it and fill it in
docker compose build
docker compose up -d
docker compose logs lawha-server # first boot only: the administrator, in a box
```

`./run.sh` from the repo root does the same thing with a preflight in front of it; [`docs/deploy.md`](../docs/deploy.md) is the operator-facing version of this section.

The stack publishes two host ports: `${LAWHA_PUBLISHED_PORT:-9002}` onto nginx's plain-HTTP `:8080`, and `${LAWHA_TLS_PORT:-9443}` onto `:8443`. The second is published unconditionally but answers only when `LAWHA_TLS=on` makes `docker/nginx-tls.sh` write the `listen 8443 ssl` include; left unset, nothing inside is listening there and connections are refused. Publishing it either way costs a docker-proxy socket and removes the place where the two halves of "TLS is on" could disagree.

**Point everyone at `http://<this-machine>:9002/`**, or at the name the gateway maps onto that port — `http://lawha.local`. Host `:80` is left unbound on purpose, and so is `:443`: 80 belongs to the gateway and 443 to whatever terminates its TLS, and taking either does not fail loudly — it removes every other project's name from the network at the same time, on a machine nobody is looking at. The container listens on `8080` rather than `80` so that no one-character edit to a port mapping can reach it; the healthcheck goes to `http://127.0.0.1:8080/healthz`.

`docker compose logs lawha-server` is where you get in on a fresh database: with no accounts in it the server creates one administrator and prints its username and password **once**, and never again. See "The first way in" above. Copy it, sign in, change it.

### If you want TLS in this stack anyway

Optional, off by default, and [ADR 0022](../docs/adr/0022-optional-tls-and-a-cookie-that-follows-the-scheme.md) is the whole story. Two commands rather than one, deliberately: minting a certificate writes files, and turning the listener on changes what the deployment answers — folding them together would mean a command called `tls` quietly rebinding a port.

```bash
./run.sh tls                  # mints certs/lawha-ca.pem and a leaf signed by it
echo 'LAWHA_TLS=on' >> .env   # compose reads ./.env, not lawha.env
./run.sh                      # recreates lawha-app; `docker compose restart` will NOT
                              # pick up a new mount, because mounts are fixed at create
```

A hand-written `openssl req -x509` heredoc used to live here, and it produced a single self-signed leaf that every phone and laptop had to import again on every re-issue. `scripts/gen-certs.sh` mints a small CA instead and signs a leaf with it, so a re-issue costs nothing on the devices. It builds the SAN list from `localhost`, `127.0.0.1`, the primary name and every IPv4 address this machine answers on, because **the SAN list is the part that matters**: browsers ignore `CN` entirely, and a certificate missing the address someone actually types is not a warning they click past — Chrome refuses it with `ERR_CERT_COMMON_NAME_INVALID` and the page never loads at all.

**Install `certs/lawha-ca.pem` on each device, once.** nginx serves it at `/lawha-ca.pem`, on the plain-HTTP listener too, so a device that does not trust the CA yet can still fetch it. Skipping the install leaves a certificate warning on every visit, and a warning people are trained to dismiss is worse than no TLS at all, because it defeats TLS everywhere else they go. Nothing sets `Strict-Transport-Security` for the same reason: HSTS removes the browser's "Proceed" escape hatch, so the first visitor who has not installed the CA locks themselves out of the deployment they were trying to reach (ADR 0005 point 5).

`yarn lan` still exists: it builds the app and serves it from this process on `:3002`, plain HTTP, with no nginx in front. Since ADR 0018 it is reachable from other machines rather than only from the one running it — with the three degradations listed above on any name that is not `localhost` — but it is still a local smoke test rather than a deployment. There is no gateway in front of it, no TLS option, and none of the pinned settings the compose stack applies.

**For development:**

```bash
yarn --cwd lawha-server migrate   # optional; also runs on boot
yarn dev                          # app on :3001, server on :3002
```

The Vite dev server proxies `/api` and `/socket.io` to this process, so the browser sees a single origin. That is what keeps the session cookie first-party — no `SameSite=None` and no CORS preflight. Vite serves plain HTTP unless both `LAWHA_HTTPS_KEY` and `LAWHA_HTTPS_CERT` are set, and `http://localhost:3001` is a secure context anyway because browsers special-case `localhost` — so this works as-is on the dev machine. Reaching it from another machine needs `--host`, because Vite binds `localhost` by default, and since ADR 0018 it needs nothing more: what you get on a LAN name is the three degradations above rather than a failure. Set that pair if you want Vite itself to serve TLS and remove them.

Why the built bundle rather than the dev server for anything but development: Vite serves ~885 separate module requests on a cold load. On localhost that is 2 seconds, but across a WireGuard tunnel each one pays the round trip and the canvas takes the best part of a minute to appear. The built bundle is 20 requests and 2.9MB, and the canvas is up in about 250ms.

If port 3002 is taken, set `LAWHA_SERVER_URL` in `.env.development.local` and `LAWHA_PORT` for the server.

## Docker

`docker-compose.yml` at the repo root builds two images and runs them on one network:

- **`lawha-server`** — this process. Not published; only nginx can reach it. Runs as the unprivileged `node` user. `/data` holds the database and the uploaded blobs, and is a **bind mount from `~/lawha-data` on the host** (`LAWHA_DATA_DIR` overrides it, absolute paths only). `LAWHA_SECURE_COOKIES` is pinned to `auto` in compose's `environment:` block; `LAWHA_REQUIRE_AUTH` is deliberately left out of it so `lawha.env` can win, and defaults to `true` in `src/config.ts`.
- **`lawha-app`** — nginx with the built frontend, publishing host `${LAWHA_PUBLISHED_PORT:-9002}` onto container `:8080` and host `${LAWHA_TLS_PORT:-9443}` onto container `:8443`. The TLS port is published unconditionally and only answers when `LAWHA_TLS=on`; otherwise nothing inside listens there. Neither 80 nor 443 is bound anywhere, inside the container or out, because host port 80 belongs to whatever fronts the machine and 443 to whatever terminates its TLS — there is no `:80` block and no redirect in `docker/nginx.conf` at all. `./certs` is bind-mounted read-only at `/etc/nginx/certs` (back since ADR 0022, and read-only because a private key must never enter an image); `./docker/nginx.conf` likewise, as a template the image's entrypoint expands into `conf.d`, with `docker/nginx-tls.sh` mounted after it as `/docker-entrypoint.d/40-lawha-tls.sh`.

`LAWHA_SECURE_COOKIES: "auto"` is pinned in `docker-compose.yml` — `environment:` outranks `env_file:`, so setting it in `lawha.env` does nothing at all, silently, and someone chasing "sign-in works and then every request looks signed out" will edit that file, see no change, and conclude the cookie code is broken.

It no longer has to move with TLS, and that is what ADR 0022 changed. `Secure` means HTTPS-only, so a `Secure` cookie on a plain-http origin is one the browser accepts, never stores and never sends back: sign-in returns 200, the page reloads signed out, for ever, on every device, with nothing in any log. ADR 0018 pinned `false` for that reason, and paid for it by sending the cookie unflagged over the https ngrok tunnel too — one boolean answering a question that has two answers on a stack serving two origins with different schemes. `auto` answers per request instead, from `req.secure` (derived from `LAWHA_TRUST_PROXY_HOPS` and the `X-Forwarded-Proto` nginx forwards), so an http request gets exactly what `false` gave it and an https request gets the flag `false` was withholding. `true` and `false` keep their previous meanings and remain the escape hatch for a proxy that reports the scheme wrongly ([ADR 0022](../docs/adr/0022-optional-tls-and-a-cookie-that-follows-the-scheme.md)).

`~/lawha-data` was a named volume until it cost this deployment its accounts. A directory in `$HOME` survives `docker compose down -v`, `docker volume rm`, `docker volume prune`, `docker system prune --volumes` and a renamed checkout; a named volume survives none of them, because its name carries the compose project name, which defaults to the directory name. **Nothing here needs a `docker volume` command for any purpose.**

Rebuilding does not touch it. `docker compose build`, `up`, `down` without `-v`, `stop`, `start` and `restart` all leave `~/lawha-data` alone, and migrations are idempotent — recorded in `schema_migrations` and skipped ever after — so a newer image against an existing database applies only what is new.

There is no `lawha-server/yarn.lock`, so the image's transitive dependencies are re-resolved on every cache miss. The five direct dependencies are pinned to exact versions in `package.json`, so the floating surface is transitives only — but that is not the same as reproducible, and the real fix is a committed lockfile.

[ADR 0005](../docs/adr/0005-docker-and-tls.md) is why the stack is shaped this way, but read it with its successors: [ADR 0018](../docs/adr/0018-plain-http-behind-a-gateway.md) reversed its deployment half — plain HTTP behind a gateway, no TLS in the stack — and [ADR 0022](../docs/adr/0022-optional-tls-and-a-cookie-that-follows-the-scheme.md) put an optional listener back behind a flag without reversing that. 0005 is still the right account of _why_ TLS here is shaped as it is, which is why putting it back starts there.

## Backing it up

```bash
LAWHA_DB_PATH=~/lawha-data/lawha.db \
  yarn --cwd lawha-server backup ~/lawha-backups [--keep N]

LAWHA_DB_PATH=~/lawha-data/lawha.db \
  yarn --cwd lawha-server restore ~/lawha-backups/lawha-20260802-091811.db
```

`scripts/backup.mjs` uses SQLite's online backup API rather than copying a file, and the reason is the first thing to know about this database: **it runs in WAL mode, so `lawha.db` is usually a 4KB header while every table lives in `lawha.db-wal`.** `cp lawha.db` yields a database with zero tables that restores in silence, and `tar` over the directory can catch the `-wal` mid-transaction and archive a `-wal` that disagrees with its `.db`. The online API is safe against a database this process is actively writing — no `stop` — and emits one checkpointed file with no sidecar to restore alongside. `node:22-slim` ships no `sqlite3` CLI, so `.backup` from a shell is not an option inside the container either.

The result is reopened, `integrity_check`ed and counted before the script reports success; it exits non-zero on any failure so a cron wrapper notices, and quarantines a file that fails as `.rejected`. `scripts/restore.mjs` verifies the backup before anything moves, refuses while the server is running, and moves the existing database aside as `.pre-restore-<stamp>` rather than deleting it. Both are pinned by `scripts/*.test.mjs`, which `yarn --cwd lawha-server test` runs alongside the vitest suite — the first test is the experiment itself: the same live database copied two ways, one of which comes back empty.

The uploaded blobs under `LAWHA_FILES_DIR` are not in the `.db` — they are immutable files, so `cp -a` is right for them. The full procedure, including the commands never to run, is in [`docs/backups.md`](../docs/backups.md).

**The scripts are not in the runtime image.** `lawha-server/Dockerfile` copies `dist/`, `node_modules/` and `package.json` and nothing else, so `docker compose exec lawha-server node scripts/backup.mjs` will not find them. Run them from the checkout on the host instead — which is where you want the backup to land anyway, and which works precisely because the database is a bind mount rather than a volume.

## Configuration

Every setting lives in **`lawha.env.example`** at the repo root, committed, grouped, and annotated with what breaks if each value is wrong. The detailed reference with "if wrong" notes for each setting is [`lawha.env.example`](../lawha.env.example). Operator-facing documentation covering how to fill in the two configuration files and when to use each is in [`docs/configuration.md`](../docs/configuration.md).

## Security posture

- Sessions are stored as `sha256(token)`, so a database leak yields no live sessions.
- Passwords use argon2id via `@node-rs/argon2` (prebuilt binaries; the node-gyp alternative fails routinely on musl and on new Node majors).
- The cookie is `SameSite=Lax`, not `Strict`. `Strict` would drop the cookie when someone opens a shared `/b/<id>` link from a chat app, which is the product's core flow.
- Login runs argon2 against a dummy hash for unknown usernames, so response timing cannot enumerate accounts.
- Rate limiting is loose per IP and tight per username, on purpose. A whole team can sit behind one NAT address, so an IP is barely an identity here — a tight per-IP limit mostly locks out the fifth colleague to sign up on their first morning. The per-username limit (5 failures per 15 minutes, not configurable) is what actually stops guessing, because an attacker cannot spread attempts against one account across addresses they do not have. All of it is in memory, so restarting the server clears it.
- Passwords are length-checked only. A common-password blocklist was removed deliberately: with per-username limiting and argon2id at roughly 50ms a guess, on a private network, it was costing more in refused passwords than it bought.
- Broadcasts are refused unless the sender has joined the room (`src/socket/rooms.ts`). Upstream `excalidraw-room` omits that check, which lets any connected client push a scene update into any guessable room id. Since ADR 0012 the payload is plaintext here, so what would land without the check is a scene that renders on everyone's canvas rather than ciphertext nobody can read — the check got more load-bearing, not less.
- File paths are parsed against an allowlist and asserted to stay under their scope root; the client-supplied prefix is never interpolated into a path.
- The master password costs the same ~50ms argon2 verification as any other login, and is only reached after the account's own password has already failed — so it is neither free to brute-force nor able to shadow a user's real credentials.
- Master-password sign-ins are recorded on the session row, printed to the log, and shown in that session's account panel. Acting as someone else is never silent.
- **A profile picture is an access rule, not a display preference.** `GET /api/users/:id/avatar` serves your own picture always and somebody else's only when that account has switched `avatar_on_cursor` on. A refusal is `404`, byte-identical to having no picture at all, because whether an account has one it has chosen not to share is itself not the asker's business. The relay withholds the avatar id from its `lawha-identities` event as well, but that alone bought nothing: the same event hands every co-present peer's account id to every other peer, link guests included, so the bytes were one hand-written request away until the route itself checked. That is invariant 21 — a permission enforced in one layer is not enforced — and `docs/adr/0006` records it in full.

## Layout

```
src/
  protocol.ts            wire contract shared with the client
  socket/                relay, per-room authorization, metrics
  http/                  auth, boards, scene CAS, files
  db/                    schema, migrations, repositories
  cli/                   reset-password
scripts/                 operator tools: backup, restore, copy-migrations
tests/
  integration/           real socket clients and a real HTTP server
```

`yarn --cwd lawha-server test` runs the vitest suite against an in-memory database and then `node --test scripts/*.test.mjs` against real files on disk. The scripts are plain `.mjs` with no build step, so their tests spawn the exact artefact an operator invokes rather than a compiled stand-in; `yarn --cwd lawha-server test:scripts` runs that half alone.
