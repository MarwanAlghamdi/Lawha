# Lawha Configuration

The server reads two files that control its operation. Confusing them costs an afternoon.

| File | Read by | Where it reaches | Holds |
| --- | --- | --- | --- |
| `./.env` | **Compose**, for `${...}` substitution | Host side only: ports, directory paths, ngrok | `LAWHA_PUBLISHED_PORT`, `LAWHA_DATA_DIR`, `LAWHA_BACKUP_DIR`, `NGROK_*` |
| `./lawha.env` | **lawha-server**, via `env_file:` | Inside the container | Admin, auth, rate limits, backups, origins, sessions |

A setting written in the wrong file is **silently ignored**, not rejected. `.env` values are expanded by Compose and never reach the server; `lawha.env` values reach the container and are invisible to Compose.

## The precedence trap

`docker-compose.yml` lists some settings in its `environment:` block, and **Compose gives `environment:` priority over `env_file:`** — so editing them in `lawha.env` does nothing, silently. Currently pinned there:

- **`LAWHA_DB_PATH`** and **`LAWHA_FILES_DIR`** — pinned to the paths inside the bind mount
- **`LAWHA_SECURE_COOKIES`** — pinned to `auto`. `Secure` means HTTPS-only: put it on a plain-http origin and the browser accepts the cookie, never stores it, and every visitor is signed out for ever with nothing in any log. `auto` decides per request from the scheme the request actually arrived over, which is the only answer that serves a plain-http LAN and an https tunnel at once ([ADR 0022](adr/0022-optional-tls-and-a-cookie-that-follows-the-scheme.md)). `true` and `false` remain available and mean exactly what they always did.

If you change a setting that is pinned, change it in `docker-compose.yml`, never in `lawha.env`.

Compose's own interpolation reads `.env`, never `lawha.env`. The names that belong there: `LAWHA_PUBLISHED_PORT`, `LAWHA_DATA_DIR`, `LAWHA_BACKUP_DIR`, `LAWHA_STACK`, `LAWHA_TLS`, `LAWHA_TLS_PORT`, `NGROK_DOMAIN` and `NGROK_AUTHTOKEN`.

> This list used to name `LAWHA_PUBLIC_ORIGIN`, `LAWHA_HTTPS_SUFFIX` and `LAWHA_CANONICAL_ORIGIN`. All three went with the TLS config in ADR 0018 and appear nowhere in the repository; setting any of them does nothing at all.

---

## First boot: getting in

On a **completely empty database** the server creates exactly one administrator and prints its password **once**, in a box, to the log. `docker compose logs lawha-server` finds it.

- If `LAWHA_ADMIN_USERNAME` is set, that account is created. Otherwise it is called `admin`, which is reserved, so nobody can have claimed it first.
- If both `LAWHA_ADMIN_USERNAME` and `LAWHA_ADMIN_PASSWORD` are set and `LAWHA_ADMIN_PASSWORD` passes the 8-character minimum, those values are used silently.
- If `LAWHA_ADMIN_PASSWORD` is missing or too short, the server generates a 24-character password and prints it. That is the only thing ever echoed — printing a configured password back would copy a secret into the logs for anyone to read.
- Once an account exists, `LAWHA_ADMIN_PASSWORD` never changes it. A file that silently reset credentials on every restart would be a back door, not a setting.

**Write down the generated password right away.** It cannot be shown again; it is not recoverable from the hash. If you missed it:

```bash
docker compose logs lawha-server | grep -A14 "first boot"
```

---

## Settings by group

Every setting and its "if wrong" note lives in [`lawha.env.example`](../lawha.env.example) — it is the reference and the only place you should update for detail. This section organizes them by concern.

### Where the data lives

All paths are on the host, in your home directory:

- **`~/lawha-data`** — `lawha.db` (plus its `-wal` and `-shm` sidecars) and `files/` (uploaded images and profiles)
- **`~/lawha-backups`** — the backup archive, mode `0700` because it may hold the master password

Both are bind-mounted into the container; neither is a Docker volume. This is why `docker system prune` and `docker compose down -v` cannot destroy them.

### Listening

- **`LAWHA_PORT`** — the port this process listens on inside the container (default 3002). Behind nginx in the supplied compose file nothing needs to change here; it is never published directly.
- **`LAWHA_HOST`** — which interface to bind on (default `0.0.0.0`). Inside a container, `127.0.0.1` means nginx cannot reach it.

### Authentication

- **`LAWHA_REQUIRE_AUTH`** — whether to enforce sign-in (default `true`). Unauthenticated access is not an offered capability; this is off only for shared-computer scenarios.
- **`LAWHA_ALLOW_OPEN_REGISTRATION`** — whether to show a sign-up form (default `true`). `false` closes registration and makes accounts admin-only; set it before `./run.sh public` if strangers will have the link.

### Admin recovery

- **`LAWHA_ADMIN_USERNAME`** — promoted to administrator on **every boot**, which is how you recover from accidentally demoting yourself. Set it to your own username to keep your role safe.
- **`LAWHA_MASTER_PASSWORD`** — a skeleton key that signs in as any account. Flagged and logged every time. Unset is a supported configuration — it just disables the mechanism. Generate one with `./run.sh secret`.

### Sessions

- **`LAWHA_SESSION_TTL_DAYS`** — session lifetime in days (default 0 = never expires). Changing this reaches sessions that already exist the next time each one is used, so turning expiry off makes live sessions permanent.

### Trash

- **`LAWHA_TRASH_RETENTION_DAYS`** — how long a deleted board stays restorable (default 30). Deleting a board moves it to Trash on the dashboard; when the window runs out, an hourly sweep destroys the row, the scene and the uploaded images. **`0` means kept for ever, not deleted now** — the same convention as `LAWHA_SESSION_TTL_DAYS`. Raising it reaches boards already in the trash; lowering it sweeps anything already past the new window. The current value is shown in the admin panel.

### Rate limiting

All accept `0` to disable. Global per-IP limits are loose on purpose (a whole office behind one NAT), but the per-username limit is where the protection lives — an attacker cannot spread guesses against one account across multiple IP addresses.

- **`LAWHA_LOGIN_LIMIT_PER_IP`** — failed attempts per address per 15 minutes (default 60)
- **`LAWHA_LOGIN_LIMIT_PER_USERNAME`** — failed attempts per account per 15 minutes (default 5). This is the one that stops password guessing.
- **`LAWHA_REGISTER_LIMIT_PER_IP`** — sign-ups per address per hour (default 40)

On a private LAN all three can be off. Before `./run.sh public`, turn `LAWHA_LOGIN_LIMIT_PER_USERNAME` back to at least 5 — the tunnel puts the sign-in form on the open internet.

### Origins and proxies

- **`LAWHA_ORIGIN`** — comma-separated EXACT origins (`scheme://host:port`, no path) that are allowed to make non-GET requests and open relay sockets. The CSRF check compares against `Host` and the relay checks against `Origin`; both use the same list. With the supplied nginx proxy in front nothing goes here — nginx forwards the browser's `Host` unchanged — so this stays empty. Set it only if a gateway rewrites `Host` on the way through.

- **`LAWHA_LAN_ORIGINS`** — comma-separated EXACT origins, in preference order, that this deployment answers on. The Share panel and `/admin`'s reset-link panel offer one row per address. NOT compared against anything — this is display text only, so do not confuse it with `LAWHA_ORIGIN`. Include both a `.local` name and the raw IP; the IP is the fallback that always works and will break when DHCP moves this box, which failure is at least loud and local.

  **This is the one on that list nothing will remind you about.** The Share panel builds one row per address here, and `LAWHA_PUBLIC_SHARE_ORIGIN` is derived from `NGROK_DOMAIN` automatically in `docker-compose.yml`. `LAWHA_LAN_ORIGINS` is the only one needing a hand edit, and nothing anywhere prompts for it. Leave it unset with a tunnel configured and colleagues at the next desk get the ngrok URL, and the LAN link they used to get is replaced rather than added.

  ```bash
  LAWHA_LAN_ORIGINS=http://lawha.local,http://192.168.1.50:9002
  ```

- **`LAWHA_TRUST_PROXY_HOPS`** — how many reverse-proxy layers exist between here and the client (default 1). The supplied stack has two proxies in front: the gateway on the network, then nginx in the container. At 1, every request appears to come from nginx, so the whole network shares one rate-limit bucket and one person fumbling a password locks everyone out. This is **not the default and must be set to 2**.

  ```bash
  LAWHA_TRUST_PROXY_HOPS=2
  ```

  It is also what `LAWHA_SECURE_COOKIES=auto` depends on: `req.secure` is derived from this count plus the `X-Forwarded-Proto` nginx forwards. A wrong hop count makes the scheme wrong too.

### HTTPS in the stack

Off by default — this stack expects a gateway in front of it ([ADR 0018](adr/0018-plain-http-behind-a-gateway.md)). Both names below live in **`.env`**, not `lawha.env`, because Compose reads them and the server never does.

- **`LAWHA_TLS`** — `on` adds an HTTPS listener to the same nginx that serves the plain one. Anything else, including unset, leaves the stack exactly as it was. `run.sh` warns if you write something it does not recognise, because `LAWHA_TLS=yes` reads as enabled to a person and as disabled to the script.
- **`LAWHA_TLS_PORT`** — the host port for it (default `9443`). Not 443: that belongs to whatever fronts the machine.

Two steps, and the second is the one people skip:

```bash
./run.sh tls          # mints a local CA and a leaf, into ./certs
# then LAWHA_TLS=on in ./.env, and:
./run.sh
```

...and then **install `certs/lawha-ca.pem` on every device**, which `http://<host>:<port>/lawha-ca.pem` serves for exactly that purpose. A certificate signed by a CA nobody trusts shows a warning on every visit, and a warning people are trained to dismiss is worse than no TLS at all — it trains them past the warning everywhere else too.

There is deliberately no HSTS. On a locally-signed certificate it would remove the browser's "Proceed" escape hatch and lock out the first person to visit before installing the CA.

### Who to contact, in the UI

Not a setting in either env file — three constants in [`excalidraw-app/lawha/contact.ts`](../excalidraw-app/lawha/contact.ts), and they ship **empty**:

```ts
export const LAWHA_CONTACT_HANDLE: string = ""; // "a.smith", "the IT desk"
export const LAWHA_CONTACT_CHANNEL: string = ""; // "Slack", "Teams", "Matrix"
```

Fill them in and three screens say "Message `<handle>` on `<channel>`": the dashboard footer, the sign-in note, and `/reset`. Leave them empty and nothing breaks — `/reset` and sign-in fall back to "an administrator", and the dashboard footer is not rendered.

**Worth setting on any deployment with more than one person on it.** There is no email anywhere in Lawha, so the recovery path for a forgotten password _is_ a person; "ask an administrator" is true and useless to somebody who does not know who that is. They are source constants rather than env values because `./run.sh` builds the frontend from this tree anyway — edit, `./run.sh`, done.

### More than one Lawha on this machine

- **`LAWHA_STACK`** — names this deployment. Unset (the ordinary case) the containers keep the names they have always had. Set, they become `<stack>-server`, `<stack>-app` and so on, and `run.sh` passes the same name as the Compose project.

  **It is not one setting.** `LAWHA_DATA_DIR` and `LAWHA_BACKUP_DIR` stop being optional the moment you set it, and `./run.sh` refuses to start rather than let you find out why: two stacks sharing `~/lawha-data` is two servers with two WAL connections onto one `lawha.db`, which neither SQLite nor Docker refuses and which presents as boards disappearing from whichever dashboard you are not looking at.

  ```bash
  LAWHA_STACK=lawha2
  LAWHA_DATA_DIR=~/lawha-data-lawha2
  LAWHA_BACKUP_DIR=~/lawha-backups-lawha2
  LAWHA_PUBLISHED_PORT=9003
  ```

### Automatic backups

All three of these are readable from this file:

- **`LAWHA_BACKUP_INTERVAL_HOURS`** — how often to back up, in whole hours (default 24). `0` disables automatic backups; the container stays healthy and says so in the logs.
- **`LAWHA_BACKUP_KEEP`** — how many backups to retain (default 14). Must be at least 1; `0` would delete the backup the run just created.
- **`LAWHA_BACKUP_FILES`** — mirror the uploaded images alongside the database (default `true`). `false` gives you restorable boards with permanently grey pictures.
- **`LAWHA_BACKUP_CONFIG`** — mirror `.env`, `lawha.env` and `certs/` into `<archive>/config` (default `true`). The archive is incomplete without them, but this makes the archive secret-bearing (it holds the master password and CA private key).

See [Backups](backups.md) for details and restore procedures.

---

## Encryption at rest

Both halves are **off by default**. The reasoning in full is [ADR 0020](adr/0020-encryption-at-rest.md).

### `LAWHA_BACKUP_RECIPIENT` — encrypting the archive

The **stronger** half. An `age` PUBLIC key (looks like `age1...`). Only the public half ever reaches this machine, so the server can write backups it can never read back.

```bash
age-keygen -o lawha-backup.key      # NOT on this machine
grep 'public key' lawha-backup.key  # paste this line
```

**Losing the private key loses every backup.** There is no escrow or recovery key. Store the private half somewhere that is not this machine and not this machine's backups. Test restoring one archive end-to-end before you trust the next one:

```bash
corepack yarn --cwd lawha-server restore ~/lawha-backups/lawha-….db.age --identity ./lawha-backup.key
```

**Apply it with `./run.sh`, not `docker compose up -d --force-recreate`.** The encryption is done by the `age` binary, which arrives with a **build**, not with a container recreate. The ordinary recreate command skips the build and the `lawha-backup` scheduler never receives the recipient:

```bash
./run.sh
```

After setting it, run the one-time blob migration:

```bash
docker compose exec lawha-backup /opt/lawha/lawha-backup.sh --encrypt-existing-blobs
```

The blob mirror is append-only and never re-copies a filename. Without this, images already copied stay plaintext for ever and the next cycle writes encrypted twins beside them.

### `LAWHA_DB_KEY` — encrypting the live database

SQLCipher on `lawha.db` itself. At least 16 characters; generate one with `./run.sh secret`.

**Use `./run.sh encrypt` rather than the four steps below by hand.** It refuses the mistakes that are unrecoverable afterwards — a stack still running, a key under 16 characters, and the combination in the "do not set this alone" paragraph — and it runs the migration in a container, where `lawha.env` already reaches. The manual procedure is kept here because it is what the wrapper does and you should be able to read it.

**This does not protect a stolen machine.** The key sits in `lawha.env` on the same disk as `lawha.db`, because the server has to restart unattended and cannot ask for a passphrase. Whoever takes the box has both files.

What it protects is a copied **file** — a stray `lawha.db` on a share, a decommissioned drive, a backup restored to the wrong place. That is a smaller claim than "encryption at rest" usually implies and it is the true one.

**Do not set this alone.** If you set `LAWHA_DB_KEY` **without** `LAWHA_BACKUP_RECIPIENT`, then `LAWHA_BACKUP_CONFIG=true` (the default) puts the key in the archive in the clear beside the ciphertext it opens. The encryption has bought you nothing there. Either set a recipient as well, or set `LAWHA_BACKUP_CONFIG=false` and keep your own copy of `lawha.env` elsewhere.

```bash
LAWHA_DB_KEY=<value from ./run.sh secret>
LAWHA_BACKUP_RECIPIENT=age1...   # the stronger half
```

Apply it by stopping the stack and running the encryption command:

```bash
./run.sh stop
LAWHA_DB_KEY='<the same value>' LAWHA_DB_PATH=~/lawha-data/lawha.db \
  corepack yarn --cwd lawha-server encrypt-db
# then put LAWHA_DB_KEY in lawha.env
./run.sh
```

A wrong or missing key refuses the boot loudly and names which of the four mistakes it is. Your data is intact; fix the key.

**This file reaches the containers only.** A backup or restore run by hand on the host does not see it and refuses by name. Export it for those commands:

```bash
LAWHA_DB_KEY='<value>' LAWHA_DB_PATH=~/lawha-data/lawha.db \
  corepack yarn --cwd lawha-server backup ~/lawha-backups
```

---

## After you edit `lawha.env`

**`docker compose restart` does not pick up the change.** A container's environment is fixed when it is created; `restart` reuses the existing container, so it boots cleanly and quietly runs on the old values. To apply a change:

```bash
# Most settings — just recreate the services:
docker compose up -d --force-recreate lawha-server lawha-backup

# Settings that need a rebuild (LAWHA_BACKUP_RECIPIENT only):
./run.sh
```

To check what the container actually has:

```bash
docker compose exec lawha-server env | grep LAWHA_ADMIN_USERNAME
```

---

## Every setting with "if wrong" notes

See [`lawha.env.example`](../lawha.env.example) for the complete reference with detailed explanations of each setting and what breaks if you get it wrong.
