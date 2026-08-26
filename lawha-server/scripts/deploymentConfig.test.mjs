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
 * by name in six places. This is the small, deliberate exception to that
 * removal, because the changes it guards — an optional TLS listener, a
 * three-valued cookie setting, interpolated container names — are precisely
 * the class those files existed for, and re-adding TLS to this stack has now
 * been done and undone three times.
 *
 * Two more were added on 2026-08-26 for the same reason: the backup archive's
 * `:ro` (ADR 0017) and a real `nginx -t` had both lost their only witness in
 * `59930dbf`, and both fail silently — the first as a security property that
 * is simply gone, the second as a container that will not start.
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
 * caused. Nothing below imports anything but `node:` built-ins, and that
 * includes the `node:child_process` added for `nginx -t`.
 *
 * A RUNTIME TOOL IS NOT AN IMPORT, AND IS ALLOWED HERE ON ONE CONDITION: it
 * must SKIP when absent, never fail and never install. "the nginx config
 * actually parses" needs docker and a local `nginx:alpine`; it checks for both
 * and skips otherwise, exactly as `backup.test.mjs` does for `age`. The
 * consequence is worth stating rather than discovering: the runtime image has
 * no docker, so that assertion is a development-machine guard by construction,
 * and a green run there proves nothing about it.
 *
 * ANCHOR WHOLE DIRECTIVES, NEVER SUBSTRINGS. `expect(conf).toContain("listen
 * 80")` passed for months after the listener had moved to 8080, because
 * `listen 80` is a substring of `listen 8080`. A false pass is worse than a
 * missing test, because it is counted. Every match below is either a full line
 * or a regex with an explicit boundary.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

/**
 * The compose file split by service, comments stripped.
 *
 * The flat `composeLines` view above cannot express "read-only HERE and
 * writable THERE", and that distinction is the whole of the backup-archive
 * rule below: one service must have the archive read-only and exactly one
 * other must have it writable. A flat "every /backups mount ends in :ro"
 * assertion would be wrong — it would fail on the service that is supposed to
 * write the backups.
 *
 * Services are two spaces in and their keys four, which is what the depth
 * checks below key off. If that ever changes, this helper fails loudly rather
 * than silently returning empty services and passing every assertion.
 */
const composeServices = () => {
  const services = new Map();
  let current = null;
  let inServices = false;
  for (const raw of compose.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trimEnd();
    if (line.length === 0) {
      continue;
    }
    if (/^services:/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) {
      continue;
    }
    if (/^\S/.test(line)) {
      inServices = false;
      continue;
    }
    const service = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (service) {
      current = service[1];
      services.set(current, []);
      continue;
    }
    if (current) {
      services.get(current).push(line);
    }
  }
  assert.ok(
    services.size >= 3,
    "the compose service parser found almost nothing, so every assertion " +
      "built on it would pass vacuously — the file's indentation has changed",
  );
  return services;
};

/** Entries under a service's own `volumes:` key, `- host:container[:mode]`. */
const volumesOf = (lines) => {
  const out = [];
  let inVolumes = false;
  for (const line of lines) {
    if (/^ {4}[a-z_]+:/.test(line)) {
      inVolumes = /^ {4}volumes:/.test(line);
      continue;
    }
    if (inVolumes && /^ {6}- /.test(line)) {
      out.push(line.replace(/^ {6}- /, "").trim());
    }
  }
  return out;
};

/** True when the service offers a way in — `ports:` or `expose:`. */
const listens = (lines) =>
  lines.some((line) => /^ {4}(ports|expose):/.test(line));
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

test("the backup archive is read-only in every service that can be reached", () => {
  // ADR 0017's rule, which lost its only witness when `backupCoverage.test.ts`
  // went with `59930dbf` and is re-pinned here.
  //
  // `:ro` is not decoration on the `lawha-server` mount. That is the container
  // with a way in — the one an attacker reaches first — and write access to
  // the archive would mean a compromise there also reaches every backup,
  // including the ones that exist to recover FROM a compromise. Ransomware
  // does exactly this: find the backups from the web server, encrypt those
  // first.
  //
  // So the assertion is not "every /backups mount is read-only" — one service
  // has to write them. It is: whoever LISTENS gets `:ro`, exactly one service
  // gets write access, and that one listens on nothing.
  const services = composeServices();
  const mounts = [];
  for (const [name, lines] of services) {
    for (const volume of volumesOf(lines)) {
      if (/:\/backups(:|$)/.test(volume)) {
        mounts.push({ name, volume, readOnly: /:ro$/.test(volume), listens: listens(lines) });
      }
    }
  }

  assert.ok(
    mounts.length >= 2,
    "expected the archive to be mounted by both a reader and a writer; found " +
      `${mounts.length}. A rename here silently disables every check below`,
  );

  for (const mount of mounts) {
    if (mount.listens) {
      assert.ok(
        mount.readOnly,
        `${mount.name} publishes or exposes a port AND mounts the backup ` +
          `archive writable (${mount.volume}). Add :ro, or move the write to ` +
          `a service with no way in`,
      );
    }
  }

  const writers = mounts.filter((mount) => !mount.readOnly);
  assert.strictEqual(
    writers.length,
    1,
    "exactly one service may write the backup archive; found " +
      `${writers.length}: ${writers.map((mount) => mount.name).join(", ")}`,
  );
  assert.ok(
    !writers[0].listens,
    `${writers[0].name} writes the backup archive and also listens. The ` +
      "writer must be unreachable — that separation is the whole design",
  );

  // Two views of ONE host directory. A typo in either default shows up as an
  // admin page listing no backups on a stack that is taking them perfectly
  // well, which reads as "backups are broken" and is not.
  const hosts = new Set(mounts.map((mount) => mount.volume.split(":/backups")[0]));
  assert.strictEqual(
    hosts.size,
    1,
    `the reader and the writer must point at the same host directory; got ${[...hosts].join(" | ")}`,
  );
});

/**
 * `nginx -t` on the real config, when there is something to run it with.
 *
 * This is the assertion `docker/nginx.conf` claimed to have for months and
 * never did: its comment credited `nginx -t` to `deploymentConfig.test.ts`,
 * which parsed the file as text exactly as this one does. The class of bug it
 * names is real and text cannot catch it — a `log_format` name the base image
 * does not define is not a degraded log, it is a config nginx refuses to load,
 * so the first sign is a container that will not start.
 *
 * Docker only, and deliberately so: it is what the deployment actually uses,
 * and it is the path that was exercised when this was written. A local `nginx`
 * binary would need a synthesized parent config and was left out rather than
 * shipped unexercised. The image is never pulled — if it is not already on the
 * machine the test skips and says how to get it, because a test that quietly
 * downloads 60MB is a test people disable.
 */
const dockerNginxAvailable = () => {
  const daemon = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
  if (daemon.status !== 0) {
    return false;
  }
  const image = spawnSync("docker", ["image", "inspect", "nginx:alpine"], {
    stdio: "ignore",
    timeout: 15_000,
  });
  return image.status === 0;
};

test("the nginx config actually parses", { skip: dockerNginxAvailable() ? false : "docker with a local nginx:alpine image is not available (docker pull nginx:alpine)" }, () => {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "-v",
      `${path.join(REPO, "docker/nginx.conf")}:/etc/nginx/conf.d/default.conf:ro`,
      "nginx:alpine",
      "nginx",
      "-t",
    ],
    { encoding: "utf8", timeout: 120_000 },
  );

  // The file is mounted verbatim, which is what the deployment does: compose
  // sets NGINX_ENVSUBST_FILTER "^LAWHA_" and there are no ${...} placeholders
  // left in it. If one is ever added, substitute it here rather than deleting
  // this test — an unsubstituted placeholder is itself a config nginx rejects.
  assert.ok(
    !/\$\{[A-Za-z_]+\}/.test(nginx),
    "docker/nginx.conf gained a ${...} placeholder; this test mounts the file " +
      "verbatim and must learn to substitute it",
  );

  assert.strictEqual(
    result.status,
    0,
    `nginx rejected docker/nginx.conf:\n${result.stderr || result.stdout}`,
  );
});
