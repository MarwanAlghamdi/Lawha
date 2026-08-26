# 0018 — Plain HTTP behind a gateway, and the end of invariant 18

**Status:** accepted **Date:** 2026-08-05 **Supersedes the deployment half of:** [0005](0005-docker-and-tls.md)

## What changed

Lawha no longer owns the front door. A gateway on this network holds port 80, maps names like `http://lawha.local` onto published ports on the machines behind it, and is the thing browsers actually talk to. Lawha publishes one plain-HTTP port in the 9001–9099 band and terminates no TLS at all.

That is a straight reversal of ADR 0005, which is still correct about the deployment it describes — it just no longer describes this one.

## Invariant 18 is retired

> **18. Lawha needs a secure context. There is no plain-HTTP LAN deployment.** Every board key is minted with `window.crypto.subtle` …

The premise died with [ADR 0012](0012-no-encryption.md). There are no board keys. What was left was a much smaller claim wearing the same words, and it is worth writing down exactly what it covered, because "we need HTTPS" and "three specific things degrade" lead to very different decisions.

Measured, not assumed:

| Path | Without `crypto.subtle` | Verdict |
| --- | --- | --- |
| Image ids — `generateIdFromFile` SHA-1s the bytes | Already wrapped in `try/catch`; falls back to `nanoid(40)`. Uploads work; the same image uploaded twice is stored twice. | degraded, upstream already handles it |
| Boards written before ADR 0012 | Cannot be decrypted | not applicable to a fresh database, and the export loop already reports it per board into `skipped` |
| `navigator.clipboard` — two copy buttons | `undefined` | both call sites already had `try/catch`; one failed **silently**, which was the real bug |

None of that is "inert". The invariant's own justification — "Lawha is inert rather than degraded" — stopped being true two ADRs ago.

## What this cost, stated plainly

**Content-addressed image ids are gone on this deployment.** Uploading the same picture to two boards stores it twice. That is real and it is the price; it is also the entire price, and it is smaller than a deployment nobody on the network can reach by name.

**A pre-0012 board is unreadable here.** Irrelevant on a fresh database, which is what the new machine starts with, and reported per board rather than as a refusal if one ever appears.

## What had to change in code, not just config

`assertSecureContext` threw at the top of board import and export. It became `secureContextNote()`, which returns a sentence for the import report and never throws — because the thing it was guarding against is already caught per board, one layer down, where it can name the affected board instead of refusing all of them.

`LawhaAdminSecret` caught a refused clipboard and set `copied = false`, so the Copy button visibly did nothing. It now hides the button when `navigator.clipboard` is absent and shows the manual path instead. That is the silence-is-the-bug lesson landing on this feature.

## The three settings that fail silently

Each of these is accepted by everything that reads it and then quietly does the wrong thing, so each is pinned and tested.

**`LAWHA_SECURE_COOKIES` must be `false`.** `Secure` means HTTPS-only. On a plain-http origin the browser accepts the cookie, never stores it, and never sends it back: sign-in returns 200, the page reloads signed out, for ever, on every device, with nothing in any log. Pinned in `docker-compose.yml` where `environment:` outranks `env_file:`, so editing `lawha.env` cannot undo it.

**`LAWHA_TRUST_PROXY_HOPS` must be `2`.** There are two proxies in front of `lawha-server` now — the gateway, then nginx. At the default of 1 every request appears to come from nginx, so the whole network shares one rate-limit bucket and one person fumbling a password locks everyone out of sign-in.

**Nothing may bind host port 80.** Not a preference: taking it removes every _other_ project's name from the network at the same time, which presents as "the network is broken" on a machine nobody is looking at. The container listens on 8080 so a one-character edit to a port mapping cannot reach 80 either.

`deploymentConfig.test.ts` asserts all three. Its port assertion has now been inverted twice — "never bind 80" → "bind 80 and 443, serve nothing on 80" → "never bind 80" — and each version was correct for its deployment and silently wrong for the next. The comment there matters as much as the assertion.

> **Amended 2026-08-26 — the file named above does not exist, and the replacement does not assert all three.** `deploymentConfig.test.ts` went with `59930dbf`; `lawha-server/scripts/deploymentConfig.test.mjs` is its deliberate replacement (ADR 0022), and the citation should be read as pointing there. But not one-for-one, and the difference is the middle rule: the `.mjs` asserts that `LAWHA_TRUST_PROXY_HOPS` is **not** pinned in compose — the value belongs to the operator's `lawha.env`, where it is `2` today — so what survives is a guard on _where the number lives_, not on the number being 2. The other two are asserted directly ("no host port 80 or 443 is published", "the container listens on 8080, never on 80"). Fifteen assertions in total, all over raw compose and nginx text. **Nothing in this repository has ever run `nginx -t`** — see the comment at `docker/nginx.conf:194`.

## One test that was passing for the wrong reason

`expect(conf).toContain("listen 80")` kept passing after the listener moved to 8080, because `listen 80` is a substring of `listen 8080`. It is now anchored to the whole directive. A false pass is worse than a missing test, because it is counted.

## Consequences

- `docker/nginx.conf` is one plain-HTTP `server` block on 8080. No TLS, no 443, no canonical-origin redirect, no `/lawha-ca.pem`, no `error_page 497`.
- `docker-compose.yml` publishes `${LAWHA_PUBLISHED_PORT:-9002}:8080` and drops the `./certs` mount.
- `scripts/gen-certs.sh` and ADR 0005 stay in the repo, unused. Putting TLS back means reading 0005 first — it is still right about why.
- `run.sh` brings the stack up on a fresh machine and refuses port 80, port 443 and anything at 32768 or above, where Linux draws ephemeral outbound ports and a bound service loses the race intermittently.
- Secrets stay the operator's: `run.sh secret` prints one and writes it nowhere.

---

## Amendment, same day — reachable from outside the network too

A second way in was added: an `ngrok` service in `docker-compose.yml`, behind `profiles: ["public"]`, giving one fixed `https://…` address from anywhere while `http://lawha.local` keeps working on the LAN.

**Behind a profile, deliberately.** `docker compose up -d` and a plain `./run.sh` do not start it; `./run.sh public` does. Putting a deployment on the public internet should not be a thing that happens because somebody ran the ordinary start command, and opting out cannot be the thing you have to remember.

**It points at `lawha-app:8080` inside the compose network, not at the published host port.** That is the load-bearing detail. `LAWHA_TRUST_PROXY_HOPS` is one number and both routes have to agree with it:

```
LAN:      browser -> portless -> lawha-app -> lawha-server   (2 hops)
internet: browser -> ngrok    -> lawha-app -> lawha-server   (2 hops)
```

Pointing it at the host port would put portless in front of one path and not the other; every internet visitor would then collapse into a single rate-limit bucket, and one person fumbling a password would lock out the rest.

**`LAWHA_SECURE_COOKIES` stays `false`, even though the tunnel is https.** This is the counter-intuitive one. `Secure` means HTTPS-only, so a Secure cookie works over ngrok and silently breaks sign-in on `http://lawha.local`. False is the only value that serves both origins. The cost is that the cookie is not flagged Secure over the tunnel — in practice ngrok endpoints are https-only, so it is still encrypted end to end, but it is a real weakening and it is written down rather than assumed.

**`--host-header` is deliberately absent from the ngrok command.** ngrok forwards its own hostname as `Host`, which is exactly what the CSRF check needs since the browser's `Origin` is that same hostname. Setting it to `rewrite` would substitute `lawha-app:8080`, the two would stop matching, and every write would be refused while every read kept working. `deploymentConfig.test.ts` asserts its absence.

### What was NOT changed, and is a standing decision

`LAWHA_ALLOW_OPEN_REGISTRATION` stays `true`. Anyone with the public link can create an account. That was raised and kept deliberately; `run.sh public` warns on every start rather than deciding for the operator. Closing it is one setting plus creating accounts from `/admin`, or handing out invite codes (ADR 0014).

### The ceiling nobody hits until they do

The ngrok free plan allows 1 GB of transfer and 20,000 HTTP requests a month. Lawha ships a large bundle, saves a scene per edit, and streams cursor traffic for the whole of a collaboration session. This is the most likely thing to go wrong first, and its symptom — the site simply stopping — looks nothing like a quota.

---

## Amendment, 2026-08-06 — what plain HTTP costs on the LAN, stated plainly

This ADR argued at length that `LAWHA_SECURE_COOKIES` must be `false`, and it noted the weakening over the tunnel. It never wrote down the consequence on the network this deployment actually runs on, and a security review found that gap rather than the setting.

**The session cookie travels in the clear across the LAN.** Every request to `http://lawha.local` carries it unencrypted. Anyone able to see the traffic — another machine on the same Wi-Fi, anything with a port mirror, a guest on the office network — can capture a cookie and use it. There is no password to crack and no prompt to defeat: the cookie _is_ the session, and Lawha's own design makes it a long-lived one (`LAWHA_SESSION_TTL_DAYS` is 30 here, and 0 — never expires — is a supported value).

Nothing in this deployment detects it. The stolen cookie produces requests indistinguishable from the real user's, and the audit log records the _account_, not the transport.

**This is the actual cost of the decision above**, and it is larger than the three degradations this ADR already lists (image ids, clipboard, legacy ciphertext). Those are inconveniences. This is a full account takeover available to anyone who can watch the wire.

**It was accepted for a reason that still holds**: the alternative on the table in ADR 0005 was a locally-generated CA that no colleague's device trusts, which produced a certificate warning on every visit and taught everyone to click through it. A warning people are trained to dismiss is worse than no TLS, because it also defeats TLS everywhere else they go.

**What would actually fix it**, in rough order of effort:

- **`mkcert`** — a locally-generated CA that _is_ installed into each device's trust store, rather than merely offered. Solves the warning problem the old approach had; costs one install step per device.
- **A real certificate for a real name**, if this deployment ever gets a DNS name rather than an mDNS one.
- **A tailnet.** Already discussed for other reasons; it encrypts the transport and removes the LAN-sniffing threat entirely, without any certificate story.

Until one of those lands, the honest statement is: **Lawha on this network is as private as the network is.** That is a reasonable position for a LAN you control and a poor one for shared or guest Wi-Fi, and the difference should be a decision rather than an assumption.
