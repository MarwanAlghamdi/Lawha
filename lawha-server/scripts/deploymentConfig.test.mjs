/**
 * The deployment settings that fail SILENTLY, pinned.
 *
 * Every assertion below is a value that everything reading it accepts and then
 * quietly does the wrong thing with. None of them throws, none of them logs,
 * and none of them is caught by a typechecker — which is the whole reason this
 * file exists rather than a comment.
 *
 * IT IS A REPLACEMENT, NOT A NEW IDEA. `deploymentConfig.test.ts` and
 * `composePortGuard.test.ts` did this job and were removed by `59930dbf` with
 * the rest of the suites; ADR 0005, ADR 0018 and the roadmap still cite them
 * by name in six places. This is the small, deliberate exception to that removal, because the
 * changes it guards — an optional TLS listener, a three-valued cookie setting,
 * interpolated container names — are precisely the class those files existed
 * for, and re-adding TLS to this stack has now been done and undone three
 * times.
 *
 * `node:test` and `.mjs`, not vitest and `.ts`: `yarn test:server` runs
 * `node --test scripts/*.test.mjs`, so this is collected by a gate that already
 * exists. `lawha-server/vitest.config.ts` was deleted and stays deleted.
 *
 * NO DEPENDENCIES, deliberately, and this is not a style preference. This
 * directory is bind-mounted into the running `lawha-backup` container
 * (`./lawha-server/scripts:/opt/lawha/scripts:ro`), so a file saved here is
 * live in production at the instant it is written, and its imports resolve
 * against the IMAGE's node_modules rather than the tree's. ADR 0020's second
 * amendment records the afternoon-long outage a new top-level import here
 * caused. Nothing below imports anything but `node:` built-ins.
 *
 * ANCHOR WHOLE DIRECTIVES, NEVER SUBSTRINGS. `expect(conf).toContain("listen
 * 80")` passed for months after the listener had moved to 8080, because
 * `listen 80` is a substring of `listen 8080`. A false pass is worse than a
 * missing test, because it is counted. Every match below is either a full line
 * or a regex with an explicit boundary.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (relative) => {
  const full = path.join(REPO, relative);
  assert.ok(
    fs.existsSync(full),
    `${relative} is missing. This guard reads the real deployment files; if one ` +
      `moved, move the assertion with it rather than deleting the test.`,
  );
  return fs.readFileSync(full, "utf8");
};

/**
 * Lines with the comment stripped, so a directive quoted inside a comment
 * cannot satisfy an assertion about the config. These files are ~85% prose —
 * `docker-compose.yml` discusses port 80 at length and must never bind it — so
 * without this every "must not contain" assertion below would be answered by
 * the paragraph explaining why.
 */
const directives = (source) =>
  source
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
    .filter((line) => line.length > 0);

const compose = read("docker-compose.yml");
const composeLines = directives(compose);
const nginx = read("docker/nginx.conf");
const nginxLines = directives(nginx);

test("no host port 80 or 443 is published", () => {
  // The published side is left of the colon. Taking 80 does not fail loudly —
  // it removes every OTHER project's name from the network at the same time,
  // which presents as "the network is broken" on a machine nobody is looking
  // at. 443 is the same story with TLS on top: this stack's plain listener
  // would then be serving cleartext on the port every browser assumes is not.
  // Split on the LAST colon: the host side is `${LAWHA_PUBLISHED_PORT:-9002}`,
  // which contains a colon of its own, so anything excluding ':' matches nothing
  // at all — and "saw 0 mappings" is a test that passes by finding nothing.
  const published = composeLines
    .filter((line) => /^- ["']?.+:\d+["']?$/.test(line))
    .map((line) => line.replace(/^- ["']?/, "").replace(/["']$/, ""));

  assert.ok(published.length >= 2, `expected at least two port mappings, saw ${published.length}`);

  for (const mapping of published) {
    const host = mapping.slice(0, mapping.lastIndexOf(":"));
    assert.ok(
      !/(^|[^0-9])(80|443)$/.test(host),
      `${mapping} publishes host port 80 or 443. Both belong to whatever fronts this machine.`,
    );
  }
});

test("both published ports are interpolated, with defaults in the 9001-9099 band", () => {
  // Interpolated rather than literal so a second stack can move them from its
  // own ./.env without editing a tracked file. The defaults are asserted
  // because they are what a fresh clone actually binds.
  assert.match(compose, /- "\$\{LAWHA_PUBLISHED_PORT:-9002\}:8080"/);
  assert.match(compose, /- "\$\{LAWHA_TLS_PORT:-9443\}:8443"/);
});

test("the container listens on 8080, never on 80", () => {
  // Anchored to the whole directive. `listen 80` is a substring of
  // `listen 8080`, and that exact mistake kept a test green through the move.
  const listens = nginxLines.filter((line) => /^listen\b/.test(line));
  assert.ok(listens.some((line) => /^listen 8080\b/.test(line)), "expected `listen 8080`");
  assert.ok(
    !listens.some((line) => /^listen (80|443)(\s|;)/.test(line)),
    `nginx listens on a privileged port: ${listens.join(" | ")}`,
  );
});

test("LAWHA_SECURE_COOKIES is pinned in compose environment:, not left to lawha.env", () => {
  // `environment:` outranks `env_file:`. Being pinned here is what stops an
  // edit to lawha.env silently doing nothing — the failure that edit chases is
  // "sign-in returns 200 and every later request looks signed out", with
  // nothing in any log.
  assert.ok(
    composeLines.includes('LAWHA_SECURE_COOKIES: "auto"'),
    "expected LAWHA_SECURE_COOKIES pinned to \"auto\" in docker-compose.yml",
  );
});

test("LAWHA_TRUST_PROXY_HOPS is NOT pinned in compose", () => {
  // The opposite rule to the one above, and the pairing is the point. The hop
  // count depends on what is in front of THIS deployment — 2 for the supplied
  // gateway, fewer without it — so it belongs to the operator's lawha.env. A
  // pin here would be silently unoverridable.
  assert.ok(
    !composeLines.some((line) => /^LAWHA_TRUST_PROXY_HOPS:/.test(line)),
    "LAWHA_TRUST_PROXY_HOPS must stay in lawha.env, where an operator can change it",
  );
});

test("every proxy block forwards Host as $http_host, never $host", () => {
  // `$host` strips the port. lawha-server's CSRF check compares
  // `new URL(origin).host` against the raw Host header, so `$host` makes every
  // WRITE fail with "Request origin not allowed" while every READ keeps
  // working — boards open and nothing can be saved. That cost a whole
  // debugging session once.
  const proxies = nginxLines.filter((line) => /^proxy_pass\b/.test(line));
  assert.equal(proxies.length, 3, `expected 3 proxy_pass blocks, saw ${proxies.length}`);

  const hostHeaders = nginxLines.filter((line) => /^proxy_set_header Host\b/.test(line));
  assert.equal(hostHeaders.length, 3, `expected 3 Host headers, saw ${hostHeaders.length}`);
  for (const line of hostHeaders) {
    assert.equal(line, "proxy_set_header Host $http_host;", `wrong Host header: ${line}`);
  }
});

test("every proxy block forwards X-Forwarded-Proto through the map", () => {
  // This is what LAWHA_SECURE_COOKIES=auto reads. Drop it from one block and
  // that route's cookies quietly lose their Secure flag while the other two
  // keep it — a difference no page renders.
  const forwarded = nginxLines.filter((line) =>
    /^proxy_set_header X-Forwarded-Proto\b/.test(line),
  );
  assert.equal(forwarded.length, 3, `expected 3 X-Forwarded-Proto headers, saw ${forwarded.length}`);
  for (const line of forwarded) {
    assert.equal(line, "proxy_set_header X-Forwarded-Proto $lawha_forwarded_proto;", line);
  }
  assert.match(nginx, /map \$http_x_forwarded_proto \$lawha_forwarded_proto/);
});

test("/api/admin/backup/ is declared above /api/", () => {
  // nginx picks the longest matching prefix, so the order does not decide
  // WHICH block runs — but it decides which one a person editing this file
  // reads first, and the backup block is the one carrying proxy_buffering off
  // and the 300s timeouts a large download needs. Below /api/ it reads as dead
  // code and gets "tidied up".
  const backup = nginx.indexOf("location /api/admin/backup/");
  const api = nginx.indexOf("location /api/ ");
  assert.ok(backup !== -1 && api !== -1, "both /api/ locations must exist");
  assert.ok(backup < api, "/api/admin/backup/ must be declared before /api/");
});

test("no Strict-Transport-Security anywhere", () => {
  // The certificate this stack can mint is signed by a local CA. HSTS removes
  // Chrome's "Advanced -> Proceed" escape hatch on the host it names, so the
  // first person to visit before installing the CA locks themselves out of the
  // deployment they were trying to reach (ADR 0005 point 5). The header goes in
  // the day a publicly-trusted certificate does, and not before.
  assert.ok(
    !/strict-transport-security/i.test(nginx.replace(/(^|\s)#.*$/gm, "")),
    "HSTS on a locally-signed certificate locks out the first visitor",
  );
  // Comment-stripped as well: nginx-tls.sh explains at length WHY there is no
  // HSTS, and a test that reads the explanation as the thing it forbids fails
  // on a correct file.
  assert.ok(
    !/strict-transport-security/i.test(directives(read("docker/nginx-tls.sh")).join("\n")),
    "HSTS must not arrive through the TLS include either",
  );
});

test("the TLS listener is a glob include, and it is inside the server block", () => {
  // A glob tolerates zero matches. `include /etc/nginx/lawha/tls.conf` on a
  // deployment that does not want TLS is a config nginx REFUSES TO LOAD — a
  // stack that will not start because a feature was left switched off.
  assert.ok(
    nginxLines.includes("include /etc/nginx/lawha/*.conf;"),
    "expected a glob include for the optional TLS listener",
  );
  const serverAt = nginx.indexOf("\nserver {");
  const includeAt = nginx.indexOf("include /etc/nginx/lawha/*.conf;");
  assert.ok(serverAt !== -1 && includeAt > serverAt, "the include must be inside the server block");
});

test("TLS is off by default and the certificate is mounted read-only", () => {
  assert.ok(composeLines.includes('LAWHA_TLS: "${LAWHA_TLS:-off}"'), "LAWHA_TLS must default to off");
  assert.ok(
    composeLines.includes("- ./certs:/etc/nginx/certs:ro"),
    "the certificate mount must be present and read-only — a private key must never enter an image",
  );
  assert.ok(
    composeLines.includes("- ./docker/nginx-tls.sh:/docker-entrypoint.d/40-lawha-tls.sh:ro"),
    "the entrypoint script that writes the TLS include must be mounted",
  );
});

test("nginx serves the CA and no location reads a private key", () => {
  // gen-certs.sh ends by telling every device to fetch /lawha-ca.pem. For two
  // ADRs that URL was a 404, which turns "install the CA" into "click through
  // the warning" — the failure ADR 0018 called worse than no TLS at all.
  assert.ok(nginxLines.includes("location = /lawha-ca.pem {"), "the CA must be downloadable");

  // Exact-match on one filename. A prefix location over /etc/nginx/certs would
  // also serve lawha-key.pem and lawha-ca-key.pem, which sit beside it.
  const certAliases = nginxLines.filter((line) => /\/etc\/nginx\/certs\//.test(line));
  for (const line of certAliases) {
    assert.ok(
      !/lawha-key\.pem|lawha-ca-key\.pem/.test(line),
      `nginx.conf references a PRIVATE key: ${line}`,
    );
  }
});

test("the ngrok command has no --host-header", () => {
  // ngrok forwards its own hostname as Host, which is exactly what the CSRF
  // check needs, because the browser's Origin is that same hostname. Setting
  // it to `rewrite` substitutes lawha-app:8080, the two stop matching, and
  // every write is refused while every read keeps working.
  // composeLines, not compose: ADR 0018's reasoning is quoted in a comment
  // right above this service, and it names the flag it is telling you not to
  // set. A raw grep finds the warning and reports it as the mistake.
  assert.ok(
    !composeLines.some((line) => /--host-header/.test(line)),
    "--host-header breaks CSRF for every tunnel visitor",
  );
  assert.match(compose, /http lawha-app:8080/);
});

test("all four container names interpolate LAWHA_STACK", () => {
  // A container name is unique per docker DAEMON, not per compose project, so
  // four literals meant exactly one Lawha per machine. The `:-lawha` default
  // keeps today's names byte-identical for anyone who never sets the variable.
  const names = composeLines.filter((line) => /^container_name:/.test(line));
  assert.equal(names.length, 4, `expected 4 container_name entries, saw ${names.length}`);
  for (const line of names) {
    assert.match(line, /^container_name: \$\{LAWHA_STACK:-lawha\}-(server|app|backup|ngrok)$/, line);
  }
});

test("the database is a bind mount, and no named volume can reach it", () => {
  // `docker volume rm`, `docker volume prune`, `docker compose down -v` and
  // `docker system prune --volumes` all destroy a named volume, and the first
  // of those was once written into this project's own restore instructions.
  // A directory in $HOME survives every one of them.
  // Column zero, and the indentation is the whole distinction. Every service
  // has its own `volumes:` two spaces in; only one at column zero declares a
  // NAMED volume, which is the kind `docker volume rm` can destroy.
  assert.ok(
    !/^volumes:/m.test(compose),
    "a top-level volumes: block would reintroduce a named volume for the database",
  );
  assert.ok(
    composeLines.some((line) => /^- \$\{LAWHA_DATA_DIR:-~\/lawha-data\}:\/data$/.test(line)),
    "the data directory must stay a host bind mount",
  );
});
