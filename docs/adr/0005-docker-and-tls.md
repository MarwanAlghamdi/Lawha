# ADR 0005 — nginx terminates TLS, because Lawha cannot run without it

**Status:** accepted, with points 3 and 7 amended in place — see "Amendments" at the bottom **Affects:** `.dockerignore`, `Dockerfile`, `docker-compose.yml`, `docker/nginx.conf`, `lawha-server/Dockerfile`

## Context

Three separate problems, which turn out to be one decision.

**The stack did not build.** `.dockerignore` opens with `*` and re-includes eleven paths. `lawha-server/` was not one of them, so the directory never entered the build context and `docker compose build lawha-server` failed at `lawha-server/Dockerfile:11`:

```
failed to compute cache key: failed to calculate checksum of ref ...:
"/lawha-server/package.json": not found
```

The obvious fix — a `lawha-server/.dockerignore` — does not work. BuildKit reads the ignore file beside the **build context**, and both services build from the repo root. Everything, including the exclusion of the 4MB live database in `lawha-server/lawha-data`, has to live in the root file.

**It would not have worked if it had built.** `docker-compose.yml` published `5174:80` and `docker/nginx.conf` listened on port 80 only. Invariant 18 says there is no plain-HTTP LAN deployment: every board key is minted with `window.crypto.subtle`, and browsers expose that only on HTTPS or `localhost`. On `http://192.168.x.x` it is `undefined`, and creating a board dies with `Cannot read properties of undefined (reading 'generateKey')`.

That is a nasty failure mode precisely because it is invisible to whoever deploys it. The Docker host reaches `http://localhost:5174` — a secure context by special case — sees a working app, and hands the address to everyone else, for whom the first click on "New board" throws.

**lawha-server cannot fix this itself.** `src/index.ts` imports `node:http` and nothing else, and `src/config.ts` declares no certificate variables. `LAWHA_HTTPS_KEY`/`LAWHA_HTTPS_CERT` exist, but they configure the Vite **dev** server in `excalidraw-app/vite.config.mts`. Teaching the server to serve TLS would mean touching config, wiring, and the socket server; putting nginx — already in the compose file to serve the frontend — in front costs one `listen` directive.

## Decision

**1. `lawha-server/` joins the context; `lawha-server/lawha-data` and `certs` are excluded.** The root `.dockerignore` is the only ignore file BuildKit consults, so both the inclusion and the two exclusions live there. Private keys reach nginx through a read-only bind mount at runtime and never enter an image.

**2. The frontend build deletes the server workspace after `COPY . .`.** The app image has no use for `lawha-server/`, and leaving it in would make that build compile better-sqlite3's native binding against a Node major the server never runs on. One `RUN rm -rf lawha-server` keeps the app build exactly what it was before the context grew.

**3. nginx terminates TLS. Port 80 redirects; port 443 is the application.** Published as `80:80` and `443:443` rather than `5174:80` — a non-standard port would end up inside every share link. The redirect is 308, not 301, so a client cannot turn a stray POST into a GET on the way. _(Amended: the host-side publication is now `9002:443` only. See Amendments.)_

**4. `LAWHA_SECURE_COOKIES` and TLS move in the same commit, always.** They are one change wearing two hats. A `Secure` cookie is never sent over plain HTTP, so setting it without TLS breaks sign-in outright; setting up TLS without it leaves the session cookie usable on an `http://` origin, which is the only thing the flag does. `LAWHA_REQUIRE_AUTH` goes to `"true"` at the same time — the compose file still said `"false"` while the code default had already moved to `true`.

**5. No HSTS.** This is the one place the secure-by-default reflex is wrong. The certificate is self-signed, and Chrome removes the "Advanced → Proceed" escape hatch on an HSTS host, so the first person to visit would lock themselves out of the deployment they were trying to reach. The header goes in the day a trusted certificate does.

**6. `/healthz` answers on port 80 without redirecting.** The app image's `HEALTHCHECK` uses busybox `wget`, which follows redirects and then refuses the self-signed certificate. Probing `/` would have reported a perfectly working stack as unhealthy.

**7. The server image runs as `node`, ships production dependencies only, and stores data in a named volume.** Three stages: `deps` installs `--production`, `build` layers the devDependencies on top and compiles, `runtime` copies `node_modules` from **`deps`** — so tsx, vitest and typescript never ship. `/data` is chowned to `node` in the image, which is what lets a fresh named volume come up writable: Docker seeds a new volume from the image directory, permissions and all. A bind mount does not work that way — Docker creates a missing bind source as `root:root` and the first boot cannot open the database — which is why `./lawha-data` became the named volume `excalidraw_lawha-data`. _(Amended: reversed. See Amendments.)_

**8. `restart: unless-stopped`, and `depends_on` waits on the healthcheck.** `on-failure` does not bring a container back after a host reboot, which is the one restart a self-hosted box actually experiences. nginx resolves its upstreams at startup and exits if `lawha-server` has no address yet, so `condition: service_healthy` is load-bearing rather than decorative.

## Consequences

The certificate is now a deployment prerequisite: no `./certs`, no nginx. That is the correct failure — loud, at boot, on the machine of the person who can fix it — rather than a `TypeError` on someone else's laptop an hour later. `lawha-server/README.md` carries the `openssl` invocation, and leads with the SAN list, because browsers ignore `CN` entirely; a certificate the browser rejects outright never gets as far as `crypto.subtle`, so a wrong SAN and a missing certificate fail identically from the user's side.

Data moved from a bind mount to a named volume, so it is no longer sitting in the working tree. The backup command is in the README. _(Both halves of that sentence were later reversed — see Amendments.)_

## Amendments

Two of the decisions above were made for reasons that were correct at the time and stopped being correct. They are amended here rather than edited away, because in both cases the original reasoning is what makes the reversal legible.

**Point 3 — published ports are now `9002:443`, and nothing binds host 80.** The reason for choosing 443 was that a non-standard port ends up inside every share link. That is still true; it is now a cost we accept rather than a rule we keep, because host port 80 belongs to a LAN gateway that fronts this machine and serves the pretty origin. Publishing 80 here either fails to bind or takes the port out from under the gateway, and that failure presents as "the gateway is down" — a symptom nobody traces back to a compose file. Links minted through the gateway carry no port; only links minted from the direct address carry `:9002`, and that address was never pretty. Container `:80` still listens and is deliberately unpublished: point 6 above (the healthcheck) depends on it, so the block in `docker/nginx.conf` must not be deleted as cleanup. `deploymentConfig.test.ts` pins both facts.

**Point 3, amended a second time — the stack binds host `443:443` and `80:80`, and there is one address: `https://lawha.local`.** The first amendment above gave up host 80 and accepted `:9002` inside every share link, because a LAN gateway on another box owned the standard ports and minted the pretty origin. Both premises are gone: Lawha runs on a device of its own now, and nothing else on it wants 80 or 443. So the reason point 3 gave for choosing 443 in the first place — a non-standard port ends up inside every share link — simply applies again, unopposed.

What changes with it:

- The `:8080` "dumb gateway" block in `docker/nginx.conf` and the loopback `5176:80` portless hop are **deleted**, along with `LAWHA_GATEWAY_PORT` and `LAWHA_PORTLESS_PORT`. Both existed to hand a proxy in front the shape it needed; there is no proxy in front.
- `:80` is now published to the LAN and **must never serve the application**. It answers `/healthz`, serves `/lawha-ca.pem`, and 307s everything else to https. That is the load-bearing constraint: a browser left on a plain-http origin finds `window.crypto.subtle` undefined, and since it is on the decrypt path as well as key generation, Lawha is inert rather than degraded (invariant 18). `deploymentConfig.test.ts` pins that the `:80` block contains no `proxy_pass`, no `try_files` and no SPA index.
- The guard that pinned "nothing binds host 80" is **inverted rather than deleted**, and the reasoning it recorded is kept: taking that port while a gateway owned it presented as "the gateway is down", a symptom nobody traces back to a compose file. It is now a positive assertion, which cannot fail silently the way the old negative one did — that failure is documented in `composePortGuard.test.ts` and is why the extractor behind it still has its own tests.

**Point 5 is untouched and now matters more.** Still no HSTS. A locally-trusted CA is not a publicly-trusted one: any device that has not installed `lawha-ca.pem` still sees an interstitial, and HSTS would remove its "Advanced → Proceed" escape hatch. The condition for turning HSTS on is unchanged and has not been met.

**A CA replaces the bare self-signed leaf.** `scripts/gen-certs.sh` mints `certs/lawha-ca.pem` once and issues the `lawha.local` leaf from it. The old procedure — an `openssl req -x509` heredoc duplicated in two READMEs — produced a `CA:FALSE` self-signed certificate that had to be re-imported on every device each time it was reissued. A CA moves that cost to once per device, for good. The cost is stated rather than glossed: whoever holds `lawha-ca-key.pem` can mint a certificate for any name those devices will accept. It is `0600`, it never enters an image (`.dockerignore` excludes `./certs`), and on a LAN deployment where that key and the database already share a box it is a reasonable trade — but it is a trade.

**Point 7 — the database is a bind mount again, to `~/lawha-data` on the host.** The stated hazard was real: Docker creates a missing bind source as `root:root` and the server runs as `node`, so the first boot cannot open the database. It does not apply here, because the host user and the container's `node` are both uid 1000 — `mkdir -p ~/lawha-data` before the first `up` is the entire mitigation, and the README makes it a numbered step. What the named volume cost was the data: `docker volume rm`, `docker volume prune`, `docker compose down -v` and `docker system prune --volumes` all destroy it, and the first of those was written into this project's own restore instructions. It also carries the compose project name, which defaults to the directory name, so renaming or re-cloning the checkout silently addresses an empty volume and prints a first-boot administrator banner that looks exactly like data loss. A directory in `$HOME` survives all of it. There is no top-level `volumes:` block in `docker-compose.yml` any more, and that absence is the point.

A third fact belongs beside these two even though no decision above stated it: **this database is in WAL mode, so `cp lawha.db` yields a database with zero tables.** Proven, not theorised. `lawha-server/scripts/backup.mjs` uses SQLite's online backup API and verifies the artefact before printing row counts; that, not a file copy, is the backup procedure.

**One thing is knowingly left undone.** `lawha-server/` has no lockfile, so `yarn install` there re-resolves transitive dependencies on every cache miss and two builds a month apart can differ. The five direct dependencies are pinned exactly in `package.json`, so the floating surface is transitives only — but that is not reproducibility. The fix is a committed `lawha-server/yarn.lock`, or a workspace-focused install against the root one; both mean adding a lockfile, which is out of scope for this change and is recorded here rather than quietly worked around.

The `--production`/full-install split does reduce the blast radius meanwhile: the runtime image contains five packages' worth of transitives, not the compiler and the test runner as well.
