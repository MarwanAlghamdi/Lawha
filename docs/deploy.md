# Deploying Lawha on another machine

**One command, once you have filled in two files:**

```bash
./run.sh
```

Then in the hub: **Add link** → `http://localhost:9002` → tick **Give it a name on the network** → type `lawha`. That makes it **http://lawha.local**.

The rest of this file is what `run.sh` is doing and what to do when it stops.

---

## The short version

```bash
git clone https://github.com/MarwanAlghamdi/Lawha.git lawha && cd lawha

./run.sh                 # creates .env and lawha.env from the examples, then stops
./run.sh secret          # generates a value for LAWHA_MASTER_PASSWORD
# ...edit ./.env and ./lawha.env...
./run.sh                 # preflight, build, start, wait for health, report
```

`run.sh` will not invent your secrets. A password it generated and printed is one that lived in your shell history and your terminal scrollback, so it stops and tells you what to fill in instead.

Other subcommands: `./run.sh check` (preflight only, changes nothing), `./run.sh stop`, `./run.sh logs`.

---

## What runs where

This deployment is **plain HTTP behind a gateway** ([ADR 0018](adr/0018-plain-http-behind-a-gateway.md)). The gateway owns port 80 and maps names onto published ports; Lawha publishes one port in the 9001–9099 band and terminates no TLS.

|  |  |
| --- | --- |
| Published port | `LAWHA_PUBLISHED_PORT` in `./.env`, default **9002** |
| Inside the container | nginx on 8080 |
| Never bound | **80** (the gateway's) and **443** (nothing here does TLS) |
| From the internet | `./run.sh public` → ngrok, opt-in, off by default |
| Health | `http://localhost:<port>/healthz` → `200 ok` |

**Do not put this on port 80.** Taking it does not fail loudly — it removes every _other_ project's name from the network at the same time, so the symptom is "the network is broken" on a machine nobody is looking at. `run.sh` refuses.

**Do not put it on 32768 or above.** Linux draws ephemeral outbound ports from there, so a service parked in that range binds fine most days and occasionally loses the race to a random outbound connection — intermittent, and it looks like the app crashing. `run.sh` refuses that too.

## The two files you fill in

Confusing them costs an afternoon:

| File | Read by | Holds |
| --- | --- | --- |
| `./.env` | **compose**, for `${...}` in `docker-compose.yml` | `LAWHA_PUBLISHED_PORT`, `LAWHA_DATA_DIR`, `LAWHA_BACKUP_DIR` |
| `./lawha.env` | **lawha-server**, inside the container | everything else — auth, rate limits, admin, backups |

An `env_file:` entry reaches the container and is invisible to compose; a `./.env` value is expanded by compose and never reaches the server. A setting written in the wrong one is silently ignored rather than rejected.

**Two settings in `lawha.env` matter more than the rest here:**

- `LAWHA_MASTER_PASSWORD` — the admin skeleton key. `./run.sh secret` generates one. Leaving it unset is supported; it disables the mechanism.
- `LAWHA_TRUST_PROXY_HOPS=2` — **not the default of 1.** There are two proxies in front of the server now (the gateway, then nginx). At 1, every request appears to come from nginx, so the whole network shares one rate-limit bucket and one person fumbling a password locks everyone out of sign-in.

**And one you cannot change:** `LAWHA_SECURE_COOKIES` is pinned to `false` in `docker-compose.yml`, where `environment:` outranks `env_file:`. That is correct and load-bearing — `Secure` means HTTPS-only, and on a plain-http origin the browser accepts the cookie, never stores it, and signs everyone out for ever with nothing in any log.

## What is degraded on plain HTTP

Browsers withhold `window.crypto.subtle` outside HTTPS and `localhost`. Three things notice, and none of them stops the app:

- **Image ids** fall back from a SHA-1 of the bytes to a random id, so the same image uploaded twice is stored twice. Uploads work.
- **Clipboard buttons** are replaced by a "select and Ctrl+C" hint.
- **Boards written before ADR 0012** cannot be decrypted. A fresh database has none.

ADR 0018 has the measurements.

---

## What the device needs

- Docker with the Compose plugin.
- One free port in 9001–9099.
- uid 1000 for the user running the stack, or `run.sh` will tell you the `chown` to run.

That is the whole list. **No `avahi-daemon`, no hostname change, no free port 80 or 443, and no certificates** — the gateway does the naming and Lawha never binds a privileged port. If you are looking for those steps, they were here until [ADR 0018](adr/0018-plain-http-behind-a-gateway.md) and they are in [ADR 0005](adr/0005-docker-and-tls.md), which is still correct about the deployment it describes.

## What `run.sh` does, in order

Worth knowing because it is also the troubleshooting order.

1. **Checks Docker** is installed, has the Compose plugin, and is reachable by this user. "Installed but not running" and "you are not in the `docker` group" are different failures and it says which.
2. **Creates `./.env` and `./lawha.env`** from the examples if missing, then stops so you can fill them in. It never invents a secret.
3. **Validates the port** — refuses 80, refuses 443, refuses 32768 and above, warns outside 9001–9099, and refuses if something else already holds it.
4. **Creates the data directories** — `~/lawha-data` and `~/lawha-backups`, `chmod 700` on the second because it holds the config mirror, which holds the master password. Docker would otherwise create them as `root:root` on first `up` and the unprivileged container could not open them.
5. **Builds and starts**, then polls health rather than sleeping a fixed time — the first boot runs migrations and is genuinely slower than the second.
6. **Reports the URL** and, on a fresh database, the first-boot administrator password, which is printed once and is not recoverable afterwards.

## Give it a name on the network — portless

[portless](https://github.com/vercel-labs/portless) is the gateway. It owns port 80, advertises `<name>.local` over mDNS, and proxies to Lawha's published port. Colleagues type **http://lawha.local** and nothing else.

```bash
portless alias lawha 9002            # route the name at Lawha's published port
sudo portless service install --lan --no-tls
```

`alias` registers a static route for a service portless does not manage — which is what a Docker container is. `service install` makes the proxy start with the machine; `portless proxy start --lan --no-tls` does the same for one session.

**Both flags are load-bearing.**

`--lan` binds `0.0.0.0` and `::` and advertises `<name>.local` over mDNS. Without it the proxy listens on loopback only and the name works on this machine and nowhere else.

`--no-tls` puts the proxy on **port 80, plain HTTP**. Without it portless terminates TLS on 443 with a CA it generated locally — which is trusted on the machine that made it and on no other device, so every colleague gets a certificate warning. That is the same trade Lawha's own `gen-certs.sh` used to make, and it is the reason this deployment is plain HTTP (ADR 0018).

`sudo` is for port 80. Without a terminal able to answer the prompt, portless falls back to port 1355 and the clean URL — the entire point — is the one thing it does not deliver.

Check it:

```bash
portless list                        # lawha.localhost -> localhost:9002
curl -H "Host: lawha.local" http://127.0.0.1/healthz     # -> ok
```

### What portless sends upstream

Measured against portless 0.15.5, because the documentation does not say and two of Lawha's behaviours depend on it:

```
host:              lawha.local          ← PRESERVED, not rewritten
x-forwarded-for:   <the real client>
x-forwarded-proto: http
x-forwarded-host:  lawha.local
x-portless-hops:   1
```

**`Host` is passed through**, so the CSRF check in `src/http/middleware/csrf.ts` — which compares the `Origin` host against the `Host` header — is satisfied with nothing configured. `LAWHA_ORIGIN` can stay empty. If a future portless version starts rewriting `Host`, the symptom is specific: every read works, every write is refused with "Request origin not allowed", so boards open and nothing can be saved. Fill in `LAWHA_ORIGIN` then.

**`X-Forwarded-For` is set**, which is what makes `LAWHA_TRUST_PROXY_HOPS=2` correct: portless is one hop and nginx is the second. At the default of 1 the address every request appears to come from is nginx's, so the whole network shares one rate-limit bucket and one person fumbling a password locks everyone out of sign-in.

### If you would rather have HTTPS

Two routes, and they are not exclusive.

**At the gateway.** Drop `--no-tls` and portless terminates TLS on 443. Lawha gets `window.crypto.subtle` back, which means content-addressed image ids and working clipboard buttons.

**In the stack.** `./run.sh tls`, then `LAWHA_TLS=on` in `./.env`, and nginx gains its own listener on `${LAWHA_TLS_PORT:-9443}` beside the plain one ([ADR 0022](adr/0022-optional-tls-and-a-cookie-that-follows-the-scheme.md)). Use this when nothing in front of you does TLS, or when you want the encrypted path to reach all the way to the container rather than stopping at the gateway.

Either way the cost is the same and it is the part that decides whether this works: **every device has to trust the CA, or live with a warning on every visit.** `./run.sh tls` mints one and nginx serves it at `/lawha-ca.pem` for exactly that. A warning people are trained to dismiss is worse than no TLS at all — it trains them past the warning on every other site too.

**`LAWHA_SECURE_COOKIES` no longer needs to move with it.** It used to: a Secure cookie on a plain-http origin signs everyone out for ever with nothing in any log, so the setting and the TLS had to land in one commit. It is pinned to `auto` now and decides per request from the scheme that request arrived over, so a deployment answering on both an http and an https origin gets the right answer on each. Set it to `true` or `false` explicitly only if some proxy in front reports the scheme wrongly.

### Running more than one Lawha on this machine

Set three things in `./.env` — `LAWHA_STACK`, `LAWHA_DATA_DIR` and `LAWHA_BACKUP_DIR` — plus a different `LAWHA_PUBLISHED_PORT`. The stack name becomes the container-name prefix and the Compose project, so the two deployments cannot collide at the Docker daemon.

```bash
LAWHA_STACK=lawha2
LAWHA_DATA_DIR=~/lawha-data-lawha2
LAWHA_BACKUP_DIR=~/lawha-backups-lawha2
LAWHA_PUBLISHED_PORT=9003
```

`./run.sh` **refuses to start** if `LAWHA_STACK` is set and the directories are not. That is not tidiness: two stacks bind-mounting one `~/lawha-data` is two servers with two WAL connections onto one `lawha.db`, which neither SQLite nor Docker refuses, and which presents as boards disappearing from whichever dashboard you are not looking at.

The gateway route follows the stack name too — `portless alias lawha2 9003`, reachable at `http://lawha2.local`.

## Reaching it from outside the network — ngrok

portless gives colleagues `http://lawha.local` **on the LAN**. ngrok gives them one fixed `https://…` address **from anywhere**. Both at once, and the LAN path keeps working unchanged.

```bash
# ./.env
NGROK_AUTHTOKEN=...                          # dashboard.ngrok.com/get-started/your-authtoken
NGROK_DOMAIN=https://something.ngrok-free.dev # dashboard.ngrok.com/domains
```

```bash
./run.sh public          # or: docker compose --profile public up -d
```

**It is opt-in and stays that way.** The ngrok service sits behind a compose profile, so `docker compose up -d` and a plain `./run.sh` do not start it. Putting a deployment on the public internet should not be something that happens because somebody ran the ordinary start command. Stop just the tunnel with `docker compose stop ngrok`.

### Why the address is stable

Every free ngrok account is permanently assigned one dev domain — it does not expire and does not change between restarts. That is what `NGROK_DOMAIN` pins. Leave it unset and ngrok mints a fresh random hostname on every start, so the link you gave people last week is dead; `run.sh public` refuses rather than let that happen quietly.

### What the free plan costs you

|             | Free plan                                   |
| ----------- | ------------------------------------------- |
| Transfer    | 1 GB / month                                |
| Requests    | 20,000 / month                              |
| Endpoints   | 3 concurrent                                |
| First visit | an ngrok interstitial page to click through |

**A collaborative canvas is not a light user of the first two.** The Excalidraw bundle is large, every board save is a request, and a live collaboration session streams cursor traffic continuously. If colleagues report it going quiet mid-month, check the dashboard before debugging Lawha. Removing the interstitial and lifting the ceilings is the Hobbyist plan, around $8–10 a month.

### Why ngrok points at `lawha-app:8080` and not at the published port

So that both routes in cross the same number of proxies:

```
LAN:      browser -> portless -> lawha-app -> lawha-server   (2 hops)
internet: browser -> ngrok    -> lawha-app -> lawha-server   (2 hops)
```

`LAWHA_TRUST_PROXY_HOPS` is one number and has to be right for both. Pointing ngrok at the host port would put portless in front of one path and not the other, and every internet visitor would collapse into a single rate-limit bucket — one person fumbling a password would lock out everyone else.

### The three settings that make dual access work

**`LAWHA_SECURE_COOKIES=false`** — and it must stay false, even though the ngrok URL is https. `Secure` means HTTPS-only, so a Secure cookie works over ngrok and silently breaks sign-in on `http://lawha.local`. False is the only value that serves both. The cost is that the session cookie is not flagged Secure over the tunnel; in practice ngrok endpoints are https-only, so it is still encrypted end to end.

**`LAWHA_TRUST_PROXY_HOPS=2`** — see above.

**`LAWHA_ORIGIN` empty** — ngrok forwards its own hostname as `Host`, and the browser's `Origin` is that same hostname, so the CSRF check's Origin-host-equals-Host rule is satisfied with nothing configured. This is why `--host-header` is deliberately absent from the ngrok command: setting it to `rewrite` would substitute `lawha-app:8080` and every write would start failing while every read kept working.

### Registration is open

`LAWHA_ALLOW_OPEN_REGISTRATION=true`, so anyone who has the public link can create an account. That is a reasonable default on a private network and a decision worth making deliberately once the address is public. `run.sh public` warns about it on every start rather than deciding for you.

To close it: `LAWHA_ALLOW_OPEN_REGISTRATION=false` in `lawha.env`, then create accounts from `/admin` — which generates a password to read out — or hand out per-board invite codes (ADR 0014).

## When it does not work

| Symptom | Cause |
| --- | --- |
| Sign-in works, then every page is signed out | A `Secure` cookie on a plain-http origin. `LAWHA_SECURE_COOKIES` must be `false` — it is pinned in `docker-compose.yml`, so check nothing overrode it there. |
| Boards open, nothing can be saved or renamed | The CSRF check: the `Origin` host and the `Host` header disagree. The gateway is rewriting `Host`. Set `LAWHA_ORIGIN` in `lawha.env` to the address people actually type. |
| One person's bad password locks out the LAN | `LAWHA_TRUST_PROXY_HOPS` is 1. There are two proxies now — the gateway, then nginx. Set it to `2`. |
| Websocket dead, REST fine | Same Host/Origin mismatch as above, judged by the relay instead of the CSRF middleware. Same fix. |
| Container unhealthy | `docker compose logs lawha-server`. On first boot it is usually a data directory the container cannot write. |
| The same image appears twice | Expected on plain HTTP. Image ids fall back to random when `crypto.subtle` is absent. ADR 0018. |
| Public URL 404s or shows "endpoint offline" | The tunnel is not up. `docker compose logs ngrok`. Most often the domain in `NGROK_DOMAIN` is not the one assigned to the account the authtoken belongs to. |
| Public URL worked, now dead | Free-plan ceiling: 1 GB transfer or 20k requests a month. Check dashboard.ngrok.com before debugging Lawha. |
| Works over ngrok, signed out on `lawha.local` | `LAWHA_SECURE_COOKIES` was set to `true`. A Secure cookie is never stored on a plain-http origin. It must stay `false` for dual access. |
| Colleagues see an ngrok warning page first | Expected on the free plan. Removed on Hobbyist (~$8–10/mo). |

## Moving an existing deployment to this device

There are two ways to get the old deployment's data here. They produce the same result; the first needs a shell on the old machine and the second needs a browser.

### From `/admin`, in a browser

1. On the old machine, open `/admin`, scroll to **Backups**, and press **Back up now and download**. Re-enter your password when it asks. What comes back is a single `.tar` holding a verified database _and_ the uploaded images — which is the whole of step 2 below in one file.
2. Copy that `.tar` and `lawha.env` to the new device.
3. Do steps 1–4 above on the new device, then unpack and restore **before** the first `up`:
   ```bash
   tar -xf lawha-20260805-141500.db.tar          # gives ./lawha.db and ./files/
   LAWHA_DB_PATH=~/lawha-data/lawha.db corepack yarn --cwd lawha-server restore lawha.db
   cp -an files/. ~/lawha-data/files/
   ```
4. `docker compose up -d`, then check the logs show **no** first-boot administrator banner. That banner means zero accounts, which means it is not looking at your data.

The tar is safe to extract with ordinary `tar` even though the warning below says never to `tar` a database — because what is inside it is not the live one. It is a copy taken through SQLite's online backup API, verified, and checkpointed out of WAL mode before it was ever added to the archive. The hazard is `tar`ring `~/lawha-data/lawha.db` yourself, which is a different act.

### From the command line

1. On the old machine, take a verified backup and stop the stack:
   ```bash
   LAWHA_DB_PATH=~/lawha-data/lawha.db corepack yarn --cwd lawha-server backup ~/lawha-backups
   docker compose down
   ```
   Read the row counts it prints. **Never `cp` or `tar` `lawha.db`** — it runs in WAL mode and a file copy yields a database with zero tables that restores silently and contains nothing.
2. Copy the newest `~/lawha-backups/lawha-*.db`, the whole `~/lawha-data/files/` directory, and `lawha.env` to the new device.
3. Do steps 1–4 above on the new device, then restore before the first `up`:
   ```bash
   LAWHA_DB_PATH=~/lawha-data/lawha.db corepack yarn --cwd lawha-server restore <backup-file>
   cp -an files/. ~/lawha-data/files/
   ```
4. `docker compose up -d`, then check the logs show **no** first-boot administrator banner. That banner means zero accounts, which means it is not looking at your data.

Whichever route you take, `lawha.env` carries `LAWHA_MASTER_PASSWORD`, and the downloaded archive carries every password hash and session on the old box. Move both the way you would move the machine itself, and delete the copy you moved them with afterwards.

**Do not copy `certs/` or the old `./.env`.** Nothing terminates TLS any more, so the certificates are dead weight that names the old machine, and `./.env` carries that machine's port and paths. Start from `.env.example` on the new box — `run.sh` copies it for you.

## Running the end-to-end suites

Two Playwright projects run against a **built** stack rather than the dev server, because `window.h` and `window.collab` are gated on `isTestEnv() || isDevEnv()` and are simply absent in a production build — a probe through them reads empty instead of failing, which is how two of these tests first reported a working feature as broken.

```bash
LAWHA_E2E_BASE_URL=http://localhost:9002 yarn test:e2e:open
```

`two-accounts` additionally needs an account that already has boards, because what it exercises is a mix of converted and still-encrypted scenes that a freshly registered account cannot have. The credentials are read from the environment and are deliberately not defaulted — a default would let the suite run green while testing nothing it was written for:

```bash
LAWHA_E2E_BASE_URL=https://localhost \
LAWHA_E2E_OWNER=<username> \
LAWHA_E2E_OWNER_PASSWORD=<password> \
  yarn test:e2e:accounts
```

Both create boards, so they are kept out of the default run: the visual baselines assume the shared account has none.
