# 0022 — Optional TLS in the stack, and a cookie that follows the scheme

**Status:** accepted **Date:** 2026-08-14 **Amends, does not reverse:** [0018](0018-plain-http-behind-a-gateway.md) · **Reads on:** [0005](0005-docker-and-tls.md)

## What changed

Three things, and only the third changes what a default deployment does:

1. **`LAWHA_TLS=on` gives this stack an HTTPS listener.** Off by default. Unset, `docker/nginx.conf` is byte-for-byte the single plain-HTTP server block ADR 0018 describes.
2. **`./run.sh tls`** mints the CA and leaf through the `scripts/gen-certs.sh` that has been sitting unused in the repo since ADR 0018, and nginx serves `/lawha-ca.pem` again.
3. **`LAWHA_SECURE_COOKIES` is three-valued**, and the new value `auto` is now the default and the compose pin.

ADR 0018 stays correct about the deployment it describes. Plain HTTP behind a gateway is still the shipped configuration and still a supported one.

## The cookie, which is the part worth reading

ADR 0018 pinned `LAWHA_SECURE_COOKIES=false` and explained at length why: `Secure` means HTTPS-only, so on `http://lawha.local` a Secure cookie is one the browser accepts, never stores and never sends back — sign-in returns 200, the page reloads signed out, for ever, on every device, with nothing in any log.

Then its own amendment of 2026-08-06 recorded what that cost: over the ngrok tunnel, which is https, the session cookie is sent unflagged too. And the LAN amendment recorded the larger version — the cookie crosses the network in the clear, so anyone who can watch the wire gets a full account takeover with no password to crack and nothing in the audit log, which records the _account_, not the transport.

Both facts were true at once because **one boolean was answering a question that has two answers on this deployment.** This stack serves two origins with different schemes.

`auto` answers per request instead of per deployment, from `req.secure` — which Express derives from `trust proxy` (`LAWHA_TRUST_PROXY_HOPS`) and the `X-Forwarded-Proto` that `docker/nginx.conf` already forwards on all three proxy blocks through its `$lawha_forwarded_proto` map. That map was left in place by ADR 0018 for exactly this eventuality; its comment says so.

| origin                 | under `false` | under `auto`                |
| ---------------------- | ------------- | --------------------------- |
| `http://lawha.local`   | no `Secure`   | no `Secure` — **identical** |
| ngrok https            | no `Secure`   | `Secure`                    |
| `https://…:9443` (new) | n/a           | `Secure`                    |

Measured on a live stack rather than reasoned about: the same server, the same config, one sign-in over each port —

```
over https: lawha_session=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=…; Secure
over http:  lawha_session=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=…
```

`true` and `false` keep their exact previous meanings and remain available. The pin stays in `docker-compose.yml`'s `environment:` block, so it still outranks `lawha.env` and setting it there still does nothing, silently — that trap is unchanged and is still documented where it lives.

### The edge, stated rather than engineered around

The `$lawha_forwarded_proto` map passes a client-supplied `X-Forwarded-Proto` through when nothing upstream overwrote it. So a client can send `X-Forwarded-Proto: https` over plain http, be handed a `Secure` cookie, and sign itself out. Both real routes in front of this stack set the header themselves — portless sends `http`, ngrok sends `https`, both measured in ADR 0018's own notes — so reaching this means bypassing them to attack nobody but yourself. `LAWHA_SECURE_COOKIES=false` is the explicit escape hatch if some future proxy turns out to lie.

### `/api/admin/config` reports both halves

`secureCookies` (the mode) and `secureCookiesEffective` (what this request got). Collapsing `auto` into a boolean would have been right half the time and silently wrong the other half, on the one page an operator opens precisely to find out what the box is doing. Invariant 24 applied to a setting rather than to a refusal.

## The TLS listener

**A glob include inside the existing server block**, not a second server block:

```nginx
include /etc/nginx/lawha/*.conf;
```

`docker/nginx-tls.sh` — mounted at `/docker-entrypoint.d/40-lawha-tls.sh`, after the image's own envsubst step — writes `tls.conf` there when `LAWHA_TLS=on`, and removes it otherwise.

Three choices in that sentence, each with a failure it avoids:

- **A glob**, because `include …/tls.conf` on a deployment that does not want TLS is a config nginx refuses to load. A feature left switched _off_ would stop the stack coming up.
- **A script, not a template.** envsubst has no conditionals. Every trick that fakes one — a variable expanding to a whole block, a second server block behind a mount that may not exist — fails by taking the stack down rather than by turning a feature off.
- **Inside the one server block**, because two blocks means maintaining `/api/`, `/socket.io/`, the admin-backup override and the SPA fallback twice, and the failure mode of forgetting one is a route that works on http and 404s on https.

**It refuses to start when the flag is on and the certificate is missing.** Starting on 8080 alone would leave the operator with a healthy stack, a green healthcheck, and an https port that simply does not answer. `run.sh` checks first so the refusal arrives in two seconds on the host rather than after a build and a 180-second health wait.

**Port 9443, not 443.** Same reason the plain port is not 80: 443 belongs to whatever fronts the machine.

**Still no HSTS.** ADR 0005 point 5 is unchanged and load-bearing: the certificate is signed by a local CA, and HSTS removes Chrome's "Advanced → Proceed" escape hatch, so the first person to visit before installing the CA locks themselves out of the deployment they were trying to reach. The header goes in the day a publicly-trusted certificate does.

**`/lawha-ca.pem` is served again**, and this is the fix for a two-ADR-old dangling instruction: `scripts/gen-certs.sh` has always ended by printing _"Install the CA on each device, once: http://<name>/lawha-ca.pem"_, and since ADR 0018 that URL has been a 404. An instruction nobody can follow is how "install the CA" becomes "click through the warning" — which ADR 0018 correctly identifies as worse than no TLS at all, because it trains people past the warning everywhere else too. It is an exact-match location on one filename; `lawha-key.pem` sits in the same directory and is never served. (`GET /lawha-key.pem` returns 200 — that is the SPA fallback returning `index.html`, verified as `text/html` with no key material in the body.)

## What this does NOT solve

**The certificate is still locally signed.** ADR 0018's amendment listed three real fixes: mkcert-style CA installation, a real certificate for a real name, or a tailnet. This is the first of those, with the install step made possible rather than merely recommended. The second and third are unchanged and still better.

**A CA key on the same box.** `certs/lawha-ca-key.pem` can mint a certificate for any name the trusting devices accept. It is `0600`, `.dockerignore` keeps it out of every image, and the mount into `lawha-app` is read-only — but it is a real key on the machine that also holds the database. ADR 0005 stated that trade and it is unchanged.

**Nothing about data at rest.** That is [ADR 0020](0020-encryption-at-rest.md), and the two should not be confused: encrypting the database does nothing about a cookie on the wire, and TLS does nothing about a copied `lawha.db`.

## Consequences

- `docker-compose.yml` publishes a second port (`${LAWHA_TLS_PORT:-9443}:8443`), mounts `./certs` read-only on `lawha-app`, mounts `docker/nginx-tls.sh`, and pins `LAWHA_SECURE_COOKIES: "auto"`.
- `run.sh` gains `tls`, refuses `LAWHA_TLS=on` without a certificate, warns on an expired leaf and on an unrecognised value (`LAWHA_TLS=yes` reads as enabled to a person and disabled to the script).
- `run.sh`'s refusal of `LAWHA_PUBLISHED_PORT=443` stays, with its reason rewritten — "nothing in this stack terminates TLS any more" stopped being true.
- The three cookie builders in `http/middleware/session.ts` and `buildGuestCookie` all resolve through one `resolveSecureCookie(ctx, req)`. A second resolution point would be a second thing to remember, and the cleared cookies must match the ones they replace on `Secure` or the deletion silently does not delete.
- **`lawha-server/scripts/deploymentConfig.test.mjs` is new**, and is the deliberate exception to the removal of this project's test suites. Fifteen assertions over the raw compose and nginx text, no dependencies (this directory is live in `lawha-backup` the instant a file is saved — ADR 0020, amendment 2), run by the existing `yarn test:server` gate. Twelve mutations were introduced and all twelve were caught; a guard nobody has seen fail is not a guard.

  > **Amended 2026-08-26 — seventeen assertions, and one of them has a dependency.** Two were added to re-pin properties that lost their witness in `59930dbf`: the backup archive's `:ro` (ADR 0017) and a real `nginx -t`. The second breaks the "no dependencies" claim above and does so deliberately — an undefined `log_format` name is a config nginx refuses to load, and no amount of text-matching finds that. It runs `nginx:alpine` under docker, never pulls the image, and **skips** when docker or the image is absent, which is the same shape as `age` in `backup.test.mjs`. A skip is not a pass: the runtime image has no docker, so this assertion is a development-machine guard by construction. Eight further mutations were introduced across both new tests and all eight were caught.

- ADR 0005, ADR 0018 and the roadmap cite `deploymentConfig.test.ts` in six places. That file no longer exists; the citations now point here.
