# lawha-server

The self-hosted half of Lawha: a socket.io relay, a REST API, and a SQLite store. One process, no external services.

## What it does and does not do

The room key lives in the URL fragment and is never transmitted. Every scene and every image arrives here already encrypted, and this server has no way to decrypt them. It is a ciphertext store and a message relay.

That has one consequence worth stating plainly: **the server cannot merge two divergent scenes.** Firestore used to do that inside a transaction. Here the server enforces compare-and-swap on a monotonic `rev` and returns `409` with its current copy; the client — which holds the key — merges and retries. See `src/db/repositories/scenes.ts` and `excalidraw-app/data/storage/lawha.ts`.

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

## This process cannot serve HTTPS — and Lawha needs HTTPS

State the boundary before the commands, because it decides which command is the right one.

`src/index.ts` calls `node:http`'s `createServer`, and there is no `LAWHA_HTTPS_KEY`/`LAWHA_HTTPS_CERT` in `src/config.ts`. This process speaks plain HTTP and nothing else. (`LAWHA_HTTPS_*` do exist — they configure the **Vite dev server** in `excalidraw-app/vite.config.mts`, not this one.)

Meanwhile the app cannot function without a secure context. Every board key is minted with `window.crypto.subtle`, which browsers expose only on HTTPS or `localhost`. On `http://192.168.x.x` it is not degraded, it is `undefined`, and creating a board dies with `Cannot read properties of undefined (reading 'generateKey')`.

Put the two together:

| How it is reached | Secure context? | Works? |
| --- | --- | --- |
| `http://localhost:3002` on the machine running it | yes — `localhost` is special-cased | yes |
| `http://<lan-ip>:3002` or `http://<hostname>:3002` from any other machine | **no** | **no** — dies on the first board |
| `https://<lan-ip>/` through a TLS terminator in front | yes | yes |

So there is no plain-HTTP LAN deployment. Something has to terminate TLS in front of this process, and `docker compose up` is the supported way to do that.

## Running it

**For real use on a LAN or a tailnet**, use Docker: nginx terminates TLS and reverse-proxies `/api` and `/socket.io` to this process, so the browser still sees one origin.

First, a certificate. `certs/` is gitignored, so generate your own — from the repo root:

```bash
mkdir -p certs
cat > certs/openssl.cnf <<'EOF'
[req]
distinguished_name = dn
x509_extensions    = ext
prompt             = no
[dn]
CN = lawha.local
[ext]
subjectAltName   = @alt
basicConstraints = CA:FALSE
keyUsage         = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
[alt]
DNS.1 = localhost
DNS.2 = lawha.local
IP.1  = 127.0.0.1
IP.2  = 192.168.1.10        # <- this machine's LAN address
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/lawha-key.pem \
  -out    certs/lawha-cert.pem \
  -config certs/openssl.cnf
```

**The `[alt]` list is the part that matters.** Modern browsers ignore `CN` entirely and match the SAN list, so every name and every address anyone will actually type has to appear there — add an `IP.3` for a tailnet address, a `DNS.3` for an mDNS name. A certificate with the wrong SAN is not a warning you click past on the way to a working app; Chrome refuses it as `ERR_CERT_COMMON_NAME_INVALID` and the page never loads, so `crypto.subtle` is never reached either.

It is still self-signed, so each browser shows an interstitial once. Click through it, or import `certs/lawha-cert.pem` into the OS trust store to make it stop.

Then the settings, and the stack. `lawha.env.example` is committed at the repo root and holds every `LAWHA_*` setting with a note on what breaks if it is wrong; the copy is gitignored and is where your secrets go.

```bash
cp lawha.env.example lawha.env   # then read it and fill it in
docker compose build
docker compose up -d
docker compose logs lawha-server # first boot only: the administrator, in a box
```

The stack publishes one host port, `9002`, onto nginx's `:443`. Point everyone at `https://<this-machine>:9002/` — the name or address you put in the SAN list, with the port. Host `:80` is left unbound on purpose so a gateway in front of this machine can have it; nginx's own `:80` block still exists inside the container for the healthcheck.

On a fresh volume that last command is where you get in: with no accounts in the database the server creates one administrator and prints its username and password **once**, and never again. See "The first way in" above. Copy it, sign in, change it.

`yarn lan` still exists and still builds and serves the app from this process on `:3002`, but per the table above it is only usable **from the machine it runs on**. It is a local smoke test, not a deployment.

**For development:**

```bash
yarn --cwd lawha-server migrate   # optional; also runs on boot
yarn dev                          # app on :3001, server on :3002
```

The Vite dev server proxies `/api` and `/socket.io` to this process, so the browser sees a single origin. That is what keeps the session cookie first-party — no `SameSite=None` and no CORS preflight. `https://localhost:3001` is a secure context, so this works as-is on the dev machine; to reach the dev server from another machine set `LAWHA_HTTPS_KEY`/`LAWHA_HTTPS_CERT` so Vite itself serves TLS.

Why the built bundle rather than the dev server for anything but development: Vite serves ~885 separate module requests on a cold load. On localhost that is 2 seconds, but across a WireGuard tunnel each one pays the round trip and the canvas takes the best part of a minute to appear. The built bundle is 20 requests and 2.9MB, and the canvas is up in about 250ms.

If port 3002 is taken, set `LAWHA_SERVER_URL` in `.env.development.local` and `LAWHA_PORT` for the server.

## Docker

`docker-compose.yml` at the repo root builds two images and runs them on one network:

- **`lawha-server`** — this process. Not published; only nginx can reach it. Runs as the unprivileged `node` user. `/data` holds the database and the uploaded blobs, and is a **bind mount from `~/lawha-data` on the host** (`LAWHA_DATA_DIR` overrides it, absolute paths only). `LAWHA_REQUIRE_AUTH` and `LAWHA_SECURE_COOKIES` are both `true` there.
- **`lawha-app`** — nginx with the built frontend, publishing host `9002` onto container `:443` and nothing else. Container `:80` still listens (healthcheck, then a 308 to https) but is unpublished, because host port 80 belongs to whatever fronts the machine. `./certs` is bind-mounted read-only at `/etc/nginx/certs`; `./docker/nginx.conf` likewise.

`LAWHA_SECURE_COOKIES: "true"` and the TLS block in `docker/nginx.conf` are a pair and must be changed together. A `Secure` cookie is never sent over plain HTTP, so turning it on without TLS breaks sign-in outright; turning TLS on without it leaves the session cookie usable on an `http://` origin, which is the entire point of the flag.

It was a named volume until it cost this deployment its accounts. A directory in `$HOME` survives `docker compose down -v`, `docker volume rm`, `docker volume prune`, `docker system prune --volumes` and a renamed checkout; a named volume survives none of them, because its name carries the compose project name, which defaults to the directory name. **Nothing here needs a `docker volume` command for any purpose.**

Rebuilding does not touch it. `docker compose build`, `up`, `down` without `-v`, `stop`, `start` and `restart` all leave `~/lawha-data` alone, and migrations are idempotent — recorded in `schema_migrations` and skipped ever after — so a newer image against an existing database applies only what is new.

There is no `lawha-server/yarn.lock`, so the image's transitive dependencies are re-resolved on every cache miss. The five direct dependencies are pinned to exact versions in `package.json`, so the floating surface is transitives only — but that is not the same as reproducible, and the real fix is a committed lockfile.

See `docs/adr/0005-docker-and-tls.md` for why it is shaped this way.

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
- Broadcasts are refused unless the sender has joined the room. Upstream `excalidraw-room` omits this, letting any client inject undecryptable ciphertext into any guessable room id.
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
