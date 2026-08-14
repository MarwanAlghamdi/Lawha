#!/usr/bin/env bash
#
# Brings the whole Lawha stack up on a machine that has never run it.
#
# Everything here is idempotent — run it again after a `git pull`, after
# editing lawha.env, or just to check the stack is healthy. It never touches
# your data: the database and the backup archive are bind-mounted directories
# on the host, and nothing below writes to either.
#
# WHAT IT WILL NOT DO. It will not invent your secrets. `lawha.env` holds
# LAWHA_MASTER_PASSWORD, which is equivalent to the database itself, and a
# password this script generated and printed is one that lived in your shell
# history and your terminal scrollback. It stops and tells you what to fill in
# instead — see `./run.sh secret` for a generator whose output goes nowhere but
# the clipboard-shaped hole you paste it into.
#
#   ./run.sh            preflight, build, start, wait for health, report
#   ./run.sh public     the same, PLUS the ngrok tunnel — reachable from the
#                       internet. Opt-in on purpose; see below.
#   ./run.sh secret     print one strong random secret and exit
#   ./run.sh tls        mint the certificate for an in-stack HTTPS listener
#   ./run.sh encrypt    encrypt the database at rest (one way, stack stopped)
#   ./run.sh check      preflight only — change nothing
#   ./run.sh stop       stop the stack, keep the data
#   ./run.sh logs       follow the logs
#
set -euo pipefail

cd "$(dirname "$0")"

readonly BOLD=$'\033[1m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' DIM=$'\033[2m' OFF=$'\033[0m'

say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$OFF" "$*"; }
head_() { printf '\n%s%s%s\n' "$BOLD" "$*" "$OFF"; }

fail() {
  printf '\n%sStopped.%s %s\n\n' "$RED" "$OFF" "$*"
  exit 1
}

# ── which stack ──────────────────────────────────────────────────────────────
#
# LAWHA_STACK names this deployment. Unset is the ordinary case and means "the
# one Lawha on this machine": compose uses its own default project name (the
# directory), `container_name` in docker-compose.yml resolves to the old
# literals `lawha-server`/`lawha-app`/`lawha-backup`/`lawha-ngrok`, and nothing
# about a machine that has only ever run one Lawha changes at all.
#
# Set it and TWO things have to move together — the container names, which are
# unique per docker DAEMON and are what made "one stack per host" a limitation,
# and the compose project passed below as -p, which is what namespaces the
# network. Neither alone is enough, which is why both read the same variable.
#
# Read by grep rather than by sourcing ./.env — the same way the port is read
# below, and the same way compose itself reads it. Sourcing would execute
# whatever is in that file, and would pull LAWHA_* names into this shell where
# `docker compose run` would then hand them to a container.
STACK="$(grep -E '^\s*LAWHA_STACK\s*=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r' || true)"
COMPOSE_PROJECT=()
[ -n "$STACK" ] && COMPOSE_PROJECT=(-p "$STACK")

# The container-name prefix, resolved the same way docker-compose.yml resolves
# ${LAWHA_STACK:-lawha}. `docker compose ps --format '{{.Name}}'` prints
# container names, not service names, so anything matching on that output has
# to know this prefix.
STACK_PREFIX="${STACK:-lawha}"

# Every compose invocation in this file goes through here. One that does not is
# one talking to the DEFAULT project while the rest talk to $STACK — on a
# two-stack machine that means starting one deployment and reporting the health
# of the other, and both look like they worked.
dc() { docker compose "${COMPOSE_PROJECT[@]}" "$@"; }

# The same command as a string, for the hints this script prints. A copyable
# command that omits -p sends the reader to the wrong project, and "the logs
# are empty" is a much harder thing to diagnose than a typo.
DC_HINT="docker compose"
[ -n "$STACK" ] && DC_HINT="docker compose -p $STACK"

# One value out of each config file, read rather than sourced — sourcing would
# execute the file and pull every LAWHA_* name into this shell, where
# `docker compose run` would hand them to a container.
#
# Both live up here, before the subcommand dispatch, because bash resolves a
# function at CALL time in file order: a definition further down is a "command
# not found" to anything above it, and both are now read by subcommands.
#
# The two files are NOT interchangeable and confusing them is this project's
# most expensive recurring mistake. ./.env is compose's interpolation file and
# reaches no container; ./lawha.env is an `env_file:` and reaches the container
# and nothing else. A setting in the wrong one is ignored rather than rejected.
read_env() {
  grep -E "^\s*$1\s*=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r' || true
}

read_lawha_env() {
  grep -E "^\s*$1\s*=" lawha.env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r' || true
}

# ── ./run.sh secret ──────────────────────────────────────────────────────────
#
# 32 bytes of urandom, base64url. Long enough that nobody will try to guess it
# and short enough to paste. Printed alone, with no label, so `./run.sh secret`
# can be piped somewhere without a header coming along for the ride.
if [ "${1:-}" = "secret" ]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; echo
  else
    head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; echo
  fi
  exit 0
fi

# ── ./run.sh tls ─────────────────────────────────────────────────────────────
#
# Mints the certificate; does NOT switch TLS on. Two steps rather than one, and
# the split is deliberate: `scripts/gen-certs.sh` writes files, and turning the
# listener on changes what the deployment answers. Folding them together would
# mean a command called "tls" quietly rebinding a port.
#
# The CA is the part that matters and the part people skip. A certificate signed
# by a CA nobody has installed produces a warning on every visit, and a warning
# people are trained to dismiss is worse than no TLS at all — it defeats TLS
# everywhere else they go. ADR 0018 records that lesson from the last time this
# stack had certificates. So this prints the install step rather than merely
# leaving the file lying in ./certs.
if [ "${1:-}" = "tls" ]; then
  [ -x scripts/gen-certs.sh ] || fail "scripts/gen-certs.sh is missing or not executable."
  LAWHA_CERT_NAME="${LAWHA_CERT_NAME:-${STACK_PREFIX}.local}" scripts/gen-certs.sh
  say ""
  say "${BOLD}Two things left, and neither is optional.${OFF}"
  say ""
  say "  1. Turn the listener on. In ${BOLD}./.env${OFF}:"
  say "       ${DIM}LAWHA_TLS=on${OFF}"
  say "     then ${DIM}./run.sh${OFF} — a recreate, because a container's mounts and"
  say "     environment are fixed when it is created, not when it starts."
  say "     ${DIM}docker compose restart will NOT do it.${OFF}"
  say ""
  say "  2. Install ${BOLD}certs/lawha-ca.pem${OFF} on every device that will use Lawha."
  say "     ${DIM}Without this each visit shows a certificate warning, and a warning${OFF}"
  say "     ${DIM}people learn to click through is worse than no TLS — it trains them${OFF}"
  say "     ${DIM}past the warning on every other site too. Install it once; the leaf${OFF}"
  say "     ${DIM}can then be re-issued as often as you like.${OFF}"
  say ""
  exit 0
fi

# ── ./run.sh encrypt ─────────────────────────────────────────────────────────
#
# Encrypts the live database with SQLCipher, under the LAWHA_DB_KEY already in
# lawha.env. The work is all in `lawha-server/scripts/encrypt-db.mjs`, which
# refuses before it touches anything, copies through SQLite's own backup API,
# verifies the copy table by table, and leaves the plaintext original as
# `<db>.pre-encryption`. This wrapper exists for the two things that script
# cannot see from inside itself.
#
# ONE: the four-step procedure in docs/configuration.md is correct and nobody
# performs it in order. It ends with a command that has to be run with the key
# exported, against a path that is not the default, on a stopped stack.
#
# TWO, and this is the reason this is a refusal rather than a convenience: a key
# in lawha.env with no LAWHA_BACKUP_RECIPIENT set means LAWHA_BACKUP_CONFIG
# (default true) mirrors lawha.env into every backup archive — so the archive
# holds the SQLCipher key in the clear, beside the ciphertext it opens. The
# encryption has then bought nothing at all, in the one place it was supposed to
# help most: a copy that leaves the building. `docker/lawha-backup.sh` already
# warns about this at container start. A warning is the wrong instrument at the
# moment of encrypting, because encrypting is not reversible.
#
# It runs in a ONE-OFF CONTAINER rather than on the host. That is not
# incidental: `lawha.env` is an `env_file:`, so LAWHA_DB_KEY reaches a container
# and reaches nothing on the host — the host route needs the key exported by
# hand, and a node_modules the machine may not have. The container already has
# both, plus ./lawha-server/scripts bind-mounted at /opt/lawha/scripts.
if [ "${1:-}" = "encrypt" ]; then
  [ -f lawha.env ] || fail "There is no ./lawha.env. Run ./run.sh once to create it."

  DB_KEY="$(read_lawha_env LAWHA_DB_KEY)"
  RECIPIENT="$(read_lawha_env LAWHA_BACKUP_RECIPIENT)"
  BACKUP_CONFIG="$(read_lawha_env LAWHA_BACKUP_CONFIG)"

  if [ -z "$DB_KEY" ]; then
    fail "LAWHA_DB_KEY is not set in ./lawha.env, so there is nothing to encrypt with.

  Generate one and put it there:

    ./run.sh secret

  LOSING THAT VALUE LOSES EVERY BOARD. There is no recovery path and no second
  tool that undoes the encryption. Store it somewhere that is not this machine
  before you go any further.

  Read the two halves first — they have different keys and protect different
  things:  docs/adr/0020-encryption-at-rest.md"
  fi

  if [ "${#DB_KEY}" -lt 16 ]; then
    fail "LAWHA_DB_KEY is ${#DB_KEY} characters. The server refuses anything under 16, so encrypting with this would produce a database it will not boot against. Generate one with ./run.sh secret."
  fi

  # The footgun, refused rather than warned about.
  if [ -z "$RECIPIENT" ] && [ "$BACKUP_CONFIG" != "false" ]; then
    fail "LAWHA_DB_KEY is set, LAWHA_BACKUP_RECIPIENT is not, and LAWHA_BACKUP_CONFIG is not false.

  That combination puts the SQLCipher key into every backup archive, in the
  clear, beside the ciphertext it opens — so a copied archive is exactly as
  readable as it was before you encrypted anything. Encrypting the database
  would buy you nothing in the one place it matters most.

  Two ways out, and the first is the better one:

    1. Encrypt the archives too, with a key that is never on this machine:

         age-keygen -o lawha-backup.key      # NOT on this machine
         grep 'public key' lawha-backup.key  # paste into lawha.env as
                                             #   LAWHA_BACKUP_RECIPIENT=age1...

       The private half never arrives here, so a fully compromised server
       cannot read a backup it wrote itself.

    2. Or stop mirroring the config, and keep your own copy of lawha.env
       somewhere else:

         LAWHA_BACKUP_CONFIG=false

       The archive is then incomplete — it can restore your boards but not
       rebuild the deployment — and that is a real trade, not a formality.

  Set one of those in ./lawha.env and run this again."
  fi

  if [ -n "$(dc ps -q 2>/dev/null)" ]; then
    fail "The stack is running. encrypt-db needs exclusive access to the database and will refuse while lawha-server holds it open.

    ./run.sh stop
    ./run.sh encrypt"
  fi

  BACKUP_DIR_ENC="$(read_env LAWHA_BACKUP_DIR)"
  BACKUP_DIR_ENC="${BACKUP_DIR_ENC:-$HOME/lawha-backups}"
  BACKUP_DIR_ENC="${BACKUP_DIR_ENC/#\~/$HOME}"

  head_ "Encrypting the database"
  say "  ${DIM}The plaintext original is KEPT, as <db>.pre-encryption. Nothing is${OFF}"
  say "  ${DIM}deleted; removing it is your decision, by hand, after you have started${OFF}"
  say "  ${DIM}the server against the encrypted file and seen your boards.${OFF}"
  say ""
  if [ -d "$BACKUP_DIR_ENC" ] && [ -n "$(ls -A "$BACKUP_DIR_ENC" 2>/dev/null)" ]; then
    ok "Existing archives in $BACKUP_DIR_ENC (newest: $(ls -t "$BACKUP_DIR_ENC" | head -1))"
  else
    warn "No archives in $BACKUP_DIR_ENC — the .pre-encryption file will be your only fallback"
  fi
  say ""

  # `lawha-backup` rather than `lawha-server`: the runtime image ships dist/ and
  # node_modules and NOT scripts/, and it is the backup service that
  # bind-mounts ./lawha-server/scripts. Both mount /data and both read
  # lawha.env, so the key arrives without being typed anywhere.
  dc run --rm --no-deps --entrypoint node lawha-backup \
    /opt/lawha/scripts/encrypt-db.mjs --db /data/lawha.db

  head_ "Two things change from here"
  say "  ${BOLD}1.${OFF} A backup run BY HAND on this host no longer works without the key."
  say "     ${DIM}lawha.env reaches the containers only. Export it for host runs:${OFF}"
  say "     ${DIM}  LAWHA_DB_KEY=… LAWHA_DB_PATH=… corepack yarn --cwd lawha-server backup …${OFF}"
  say "     ${DIM}The scheduled backups in the container are unaffected.${OFF}"
  say ""
  say "  ${BOLD}2.${OFF} Every archive taken BEFORE now is plaintext, and restoring one is"
  say "     two steps rather than one. restore.mjs refuses and prints them, so"
  say "     this is a delay rather than a trap — but know it before the day."
  say ""
  say "  Now start it and look at a board:  ${DIM}./run.sh${OFF}"
  say ""
  exit 0
fi

if [ "${1:-}" = "stop" ]; then
  # Never `-v`. That flag is the difference between "stop it" and "erase it",
  # and this project has lost a database to it once already.
  dc down
  say "Stopped. Your data in the directories below is untouched."
  exit 0
fi

if [ "${1:-}" = "logs" ]; then
  exec docker compose "${COMPOSE_PROJECT[@]}" logs -f
fi

CHECK_ONLY=false
[ "${1:-}" = "check" ] && CHECK_ONLY=true

# ── public mode ──────────────────────────────────────────────────────────────
#
# Off unless asked for, and the asking is the point: every other part of this
# stack is reachable only from the LAN, and this one puts it on the internet.
# A flag you have to type is the difference between a deliberate act and a
# default nobody reviewed.
PUBLIC=false
COMPOSE_PROFILE=()
if [ "${1:-}" = "public" ]; then
  PUBLIC=true
  COMPOSE_PROFILE=(--profile public)
fi

# ── preflight ────────────────────────────────────────────────────────────────

head_ "Checking this machine"

command -v docker >/dev/null 2>&1 || fail "Docker is not installed."
docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is missing. Install docker-compose-plugin."
docker info >/dev/null 2>&1 || fail "Docker is installed but not running, or this user cannot reach it. Try: sudo systemctl start docker — and check you are in the 'docker' group."
ok "Docker and the Compose plugin are available"

# ── configuration files ──────────────────────────────────────────────────────

head_ "Checking configuration"

MISSING_CONFIG=false

if [ ! -f .env ]; then
  cp .env.example .env
  warn "Created ./.env from the example — read it and set LAWHA_PUBLISHED_PORT"
  MISSING_CONFIG=true
else
  ok "./.env exists"
fi

if [ ! -f lawha.env ]; then
  cp lawha.env.example lawha.env
  warn "Created ./lawha.env from the example — it is NOT filled in yet"
  MISSING_CONFIG=true
else
  ok "./lawha.env exists"
fi

# The published port, read the same way compose will read it, so what this
# script reports and what actually gets bound cannot disagree.
PORT="$(grep -E '^\s*LAWHA_PUBLISHED_PORT\s*=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r' || true)"
PORT="${PORT:-9002}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  fail "LAWHA_PUBLISHED_PORT in ./.env is not a number: '$PORT'"
fi
if [ "$PORT" -eq 80 ]; then
  fail "LAWHA_PUBLISHED_PORT is 80, which belongs to the gateway that maps names onto ports. Taking it removes every other project's name from the network, not just this one — so the symptom is 'the network is broken' rather than anything pointing at Lawha. Pick something in 9001–9099."
fi
if [ "$PORT" -eq 443 ]; then
  fail "LAWHA_PUBLISHED_PORT is 443. That is the HTTPS port, and it belongs to whatever fronts this machine — taking it has the same consequence as taking 80. It is also the wrong setting for the job: this port publishes the PLAIN-http listener, so binding 443 to it would serve cleartext on the port every browser assumes is encrypted. The in-stack HTTPS listener is LAWHA_TLS=on and LAWHA_TLS_PORT (default 9443). Pick something in 9001–9099 for this one."
fi
if [ "$PORT" -lt 9001 ] || [ "$PORT" -gt 9099 ]; then
  warn "LAWHA_PUBLISHED_PORT is $PORT, outside the 9001–9099 band the gateway reserves."
  if [ "$PORT" -ge 32768 ]; then
    fail "$PORT is in Linux's ephemeral outbound range (32768+). A service parked there binds fine most days and occasionally loses the race to a random outbound connection — intermittent, and it looks like the app crashing. Pick something in 9001–9099."
  fi
else
  ok "Publishing on port $PORT"
fi

# Is something already holding it? Better to say so now than to have compose
# fail with a bind error three minutes into a build.
if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
  # Ours from a previous run is fine; anything else is a collision.
  if [ -z "$(dc ps -q 2>/dev/null)" ]; then
    fail "Something is already listening on port $PORT, and it is not this stack. Pick another port in ./.env, or stop whatever holds it."
  fi
fi

# The one secret that has no safe default. An unset master password is a
# supported configuration — it simply disables the skeleton key — so this warns
# rather than failing.
if grep -qE '^\s*LAWHA_MASTER_PASSWORD\s*=\s*\S' lawha.env 2>/dev/null; then
  ok "LAWHA_MASTER_PASSWORD is set"
else
  warn "LAWHA_MASTER_PASSWORD is not set in ./lawha.env — the admin skeleton key is disabled"
  say "    ${DIM}Generate one with:  ./run.sh secret${OFF}"
fi

# ── data directories ─────────────────────────────────────────────────────────
#
# Created BEFORE the first `up`, and by you rather than by Docker. Docker
# creates a missing bind source as root:root, and both containers run as the
# unprivileged `node` user, which then cannot open it.

head_ "Checking data directories"

read_dir() {
  local key="$1" fallback="$2" value
  value="$(grep -E "^\s*${key}\s*=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r' || true)"
  value="${value:-$fallback}"
  # Expand a leading ~ the way compose does.
  printf '%s' "${value/#\~/$HOME}"
}

DATA_DIR="$(read_dir LAWHA_DATA_DIR ~/lawha-data)"
BACKUP_DIR="$(read_dir LAWHA_BACKUP_DIR ~/lawha-backups)"

# A second stack MUST have a second data directory, and this refuses rather
# than warns.
#
# LAWHA_STACK gives this deployment its own container names and its own compose
# project, so docker will start it happily beside the first one — every
# collision docker knows how to report is gone. What is left is the one it
# cannot see: both stacks bind-mounting ~/lawha-data means two servers with two
# WAL connections onto ONE lawha.db. SQLite does not refuse that. It is not a
# port conflict that stops you at startup; it is two deployments interleaving
# writes into one file, and it presents as boards vanishing from whichever
# dashboard you are not looking at.
#
# Checked against the raw ./.env value, not against $DATA_DIR, because
# read_dir has already substituted the default by then and a defaulted value is
# exactly the case being refused.
if [ -n "$STACK" ]; then
  for _pair in "LAWHA_DATA_DIR:$DATA_DIR" "LAWHA_BACKUP_DIR:$BACKUP_DIR"; do
    _key="${_pair%%:*}"
    if [ -z "$(grep -E "^\s*${_key}\s*=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r' || true)" ]; then
      fail "LAWHA_STACK is '$STACK', but ${_key} is not set in ./.env.

  A named stack shares the default directory with every other stack on this
  machine, and two Lawha servers writing one SQLite file is data loss rather
  than an error either of them would report.

  Give this stack its own, in ./.env, beside LAWHA_STACK:

    ${_key}=~/lawha-data-$STACK

  (Both LAWHA_DATA_DIR and LAWHA_BACKUP_DIR are required once LAWHA_STACK is
  set. Unset LAWHA_STACK if this is the only Lawha on the machine — that is
  the ordinary case and needs none of this.)"
    fi
  done
  ok "LAWHA_STACK=$STACK with its own data and backup directories"
fi

mkdir -p "$DATA_DIR" "$BACKUP_DIR"
# The archive holds the configuration mirror, which holds the master password.
chmod 700 "$BACKUP_DIR"
ok "Data:    $DATA_DIR"
ok "Backups: $BACKUP_DIR (0700)"

# `certs/` is gitignored, so a fresh clone does not have one — and `lawha-backup`
# bind-mounts it. Docker then creates the missing source itself, as root:root,
# inside the operator's own working copy. Measured on a clean clone: after the
# first `docker compose up` there is a `drwxr-xr-x root root certs/` sitting in
# the checkout, which `git status` will never mention because it is ignored.
#
# Harmless to running Lawha — ADR 0018 ended TLS in this stack and nothing reads
# it — but it is a root-owned directory the operator did not make, and the next
# person to run `scripts/gen-certs.sh` as themselves gets a bare OpenSSL
# permission error with nothing to connect it to. Creating it here first costs
# one line and means Docker finds it already there.
mkdir -p certs

# ── TLS, if it was asked for ─────────────────────────────────────────────────
#
# docker/nginx-tls.sh already refuses to start without a certificate, and that
# refusal is the real guarantee. This check exists anyway because the two
# failures do not cost the same: the container's version is found by reading
# `docker compose logs lawha-app` after a build, a start and a 180-second health
# wait, while this one arrives in two seconds on the machine that can fix it.
TLS_MODE="$(read_env LAWHA_TLS)"
case "$TLS_MODE" in
  on | true | 1)
    if [ -r certs/lawha-cert.pem ] && [ -r certs/lawha-key.pem ]; then
      ok "LAWHA_TLS=$TLS_MODE, certificate present"
      # An expired leaf is a working stack that every browser refuses, which
      # reads as "the site is down" rather than as a date. Checked, not assumed.
      if command -v openssl >/dev/null 2>&1 &&
        ! openssl x509 -in certs/lawha-cert.pem -noout -checkend 0 >/dev/null 2>&1; then
        warn "certs/lawha-cert.pem has EXPIRED — browsers will refuse it"
        say "    ${DIM}Re-issue it (the CA is reused, so devices keep trusting it):  ./run.sh tls${OFF}"
      fi
    else
      fail "LAWHA_TLS is '$TLS_MODE', but there is no certificate in ./certs.

  nginx would refuse to start, so the stack would not come up at all. Mint one:

    ./run.sh tls

  Or unset LAWHA_TLS in ./.env to go back to plain HTTP behind a gateway,
  which is this stack's default and a supported deployment (ADR 0018)."
    fi
    ;;
  "") ;;
  off | false | 0) ;;
  *)
    # Anything unrecognised is OFF, and silently off is the failure this warns
    # about: `LAWHA_TLS=yes` reads as enabled to a person and as disabled to
    # docker/nginx-tls.sh, and the only symptom is a port that never answers.
    warn "LAWHA_TLS is '$TLS_MODE', which is not 'on' — TLS will be OFF"
    say "    ${DIM}The values that enable it are: on, true, 1${OFF}"
    ;;
esac

# uid 1000 is what `node` is inside both images. If this account is not 1000,
# the bind mounts are unwritable and the server dies on its first write.
if [ "$(id -u)" -ne 1000 ]; then
  warn "This account is uid $(id -u), but the containers run as uid 1000."
  say "    ${DIM}Fix with:  sudo chown -R 1000:1000 '$DATA_DIR' '$BACKUP_DIR'${OFF}"
fi

if [ -f "$DATA_DIR/lawha.db" ]; then
  ok "An existing database is here — it will be kept and migrated, not replaced"
else
  ok "No database yet — this will be a fresh deployment"
fi

# ── ngrok ────────────────────────────────────────────────────────────────────

NGROK_DOMAIN_VALUE="$(read_env NGROK_DOMAIN)"

# The FORMAT check runs whether or not the tunnel was asked for, and that is the
# whole point of it being out here.
#
# `docker-compose.yml` writes `LAWHA_PUBLIC_SHARE_ORIGIN: ${NGROK_DOMAIN:-}` in
# lawha-server's `environment:` block, which applies to EVERY run — the ngrok
# service is behind a profile, this variable is not. `config.ts` then requires an
# exact origin and throws when it does not get one, and `index.ts` calls
# `loadConfig()` at the top level with nothing to catch it.
#
# So somebody who typed their domain without the scheme once, and never used
# `./run.sh public` at all, got a server that refuses to boot — naming a setting
# they had every reason to believe was dormant. This check was gated behind
# `--public` and so never ran on the path where it was needed.
if [ -n "$NGROK_DOMAIN_VALUE" ]; then
  case "$NGROK_DOMAIN_VALUE" in
    https://*) : ;;
    http://*)  fail "NGROK_DOMAIN is http://. ngrok endpoints are https — use https://" ;;
    *)         fail "NGROK_DOMAIN needs the scheme: NGROK_DOMAIN=https://$NGROK_DOMAIN_VALUE

It is set, so it reaches lawha-server as LAWHA_PUBLIC_SHARE_ORIGIN on every run,
not only under ./run.sh public — and the server refuses to start on a value that
is not an exact origin." ;;
  esac
fi

if [ "$PUBLIC" = true ]; then
  head_ "Checking the public tunnel"

  NGROK_TOKEN="$(read_env NGROK_AUTHTOKEN)"

  [ -n "$NGROK_TOKEN" ] || fail "NGROK_AUTHTOKEN is not set in ./.env. Get it from https://dashboard.ngrok.com/get-started/your-authtoken"

  # Being UNSET is only fatal here: without the tunnel there is nothing for it
  # to name, and the format check above has already passed on anything set.
  if [ -z "$NGROK_DOMAIN_VALUE" ]; then
    fail "NGROK_DOMAIN is not set in ./.env.

Without it ngrok mints a fresh random hostname on every start, so the link you
hand out stops working the next time this restarts. Every free ngrok account
has one permanent domain — find yours at https://dashboard.ngrok.com/domains
and put it in ./.env WITH the scheme:

    NGROK_DOMAIN=https://something.ngrok-free.dev"
  fi

  ok "Public URL: $NGROK_DOMAIN_VALUE"

  # Registration is a decision, not a default, once there is a public address.
  # Warned rather than refused: it is a legitimate choice and the operator's to
  # make — but it should not be one nobody noticed.
  if grep -qE '^\s*LAWHA_ALLOW_OPEN_REGISTRATION\s*=\s*false' lawha.env 2>/dev/null; then
    ok "Registration is closed — accounts are created from /admin"
  else
    warn "Registration is OPEN: anyone with the public link can create an account"
    say "    ${DIM}Close it with LAWHA_ALLOW_OPEN_REGISTRATION=false in lawha.env${OFF}"
  fi

  # Sign-in limits off is a LAN decision that does not survive a public address.
  # Same treatment as registration above — warned, never refused, because it is
  # the operator's call. But nobody should discover it from a log afterwards.
  #
  # Matched on `=0` specifically rather than on the setting's presence: absent
  # means the default, and the default is on.
  if grep -qE '^\s*LAWHA_LOGIN_LIMIT_PER_USERNAME\s*=\s*0\s*$' lawha.env 2>/dev/null; then
    warn "Sign-in rate limiting is OFF (LAWHA_LOGIN_LIMIT_PER_USERNAME=0)"
    say "    ${DIM}On a public address that is unlimited password guessing${OFF}"
    say "    ${DIM}against any account whose username someone knows.${OFF}"
    say "    ${DIM}Set it back to 5 in lawha.env before leaving this up.${OFF}"
  else
    ok "Sign-in rate limiting is on"
  fi

  # One number has to be right for both routes in, and it is not the default.
  if grep -qE '^\s*LAWHA_TRUST_PROXY_HOPS\s*=\s*2' lawha.env 2>/dev/null; then
    ok "LAWHA_TRUST_PROXY_HOPS=2 — rate limits key on the real visitor"
  else
    warn "LAWHA_TRUST_PROXY_HOPS is not 2 in lawha.env"
    say "    ${DIM}Both routes in have two proxies (ngrok|portless, then nginx).${OFF}"
    say "    ${DIM}At any other value every visitor shares one rate-limit bucket.${OFF}"
  fi

  # The one that costs somebody else's privacy rather than this box's.
  #
  # LAWHA_PUBLIC_SHARE_ORIGIN is derived from NGROK_DOMAIN automatically.
  # LAWHA_LAN_ORIGINS is derived from nothing, and nothing else prompts for it.
  # With a tunnel up and this unset, the Share panel's only row is the public
  # one — and it REPLACES the same-origin link rather than sitting beside it.
  # So a colleague at the next desk copies the ngrok URL, and their board
  # session leaves the building and comes back for the rest of the afternoon.
  #
  # It is silent because the ngrok link works perfectly. Warned at the moment
  # the tunnel is switched on, which is the only moment anyone would act on it.
  if grep -qE '^\s*LAWHA_LAN_ORIGINS\s*=\s*\S' lawha.env 2>/dev/null; then
    ok "LAWHA_LAN_ORIGINS is set — the Share panel can still offer a LAN link"
  else
    warn "LAWHA_LAN_ORIGINS is not set in lawha.env"
    say "    ${DIM}With the tunnel up, Share will offer ONLY the public link —${OFF}"
    say "    ${DIM}it replaces the LAN one rather than joining it, so people on${OFF}"
    say "    ${DIM}your own network get routed out through ngrok and back.${OFF}"
    say "    ${DIM}Set every address this box answers to, best first:${OFF}"
    say "    ${DIM}LAWHA_LAN_ORIGINS=http://lawha.local,http://192.168.1.50:9002${OFF}"
  fi
fi

if [ "$MISSING_CONFIG" = true ]; then
  printf '\n%sConfiguration was just created from the examples.%s\n' "$YELLOW" "$OFF"
  say "Open ./.env and ./lawha.env, fill them in, then run this again."
  say ""
  say "  ${DIM}./run.sh secret${OFF}   generates a value for LAWHA_MASTER_PASSWORD"
  say ""
  exit 0
fi

if [ "$CHECK_ONLY" = true ]; then
  printf '\n%sPreflight passed.%s Nothing was started.\n\n' "$GREEN" "$OFF"
  exit 0
fi

# ── build and start ──────────────────────────────────────────────────────────

head_ "Building"
dc "${COMPOSE_PROFILE[@]}" build

head_ "Starting"
dc "${COMPOSE_PROFILE[@]}" up -d

head_ "Waiting for the stack to come up"

# Poll the health status rather than sleeping a fixed number of seconds. The
# first boot runs migrations and can genuinely take longer than the second.
DEADLINE=$(( SECONDS + 180 ))
while true; do
  # ngrok's image declares no HEALTHCHECK, so it never reports "(healthy)" and
  # would hold this loop until the deadline. Judged on "Up" instead — its real
  # readiness signal is the endpoint appearing, which is checked further down.
  #
  # $STACK_PREFIX, not a literal `lawha-`: this matches {{.Name}}, which is the
  # CONTAINER name, and those are ${LAWHA_STACK:-lawha}-prefixed now. A literal
  # here would fail in the quietest possible way on a second stack — ngrok
  # never matches, so it is never excluded, so a completely healthy `./run.sh
  # public` sits in this loop for the full 180 seconds and then reports a
  # failure that is not happening.
  UNHEALTHY="$(dc "${COMPOSE_PROFILE[@]}" ps --format '{{.Name}} {{.Status}}' 2>/dev/null \
    | grep -v '(healthy)' \
    | grep -v "^${STACK_PREFIX}-ngrok Up" || true)"
  [ -z "$UNHEALTHY" ] && break

  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    bad "Still not healthy after 180s:"
    printf '%s\n' "$UNHEALTHY"
    say ""

    # Ask the container itself whether it can write, on the failure path only.
    #
    # The preflight above compares THIS account's uid against 1000, and that
    # comparison cannot see the case that matters most on a machine which has
    # never run this before: under rootless Docker or `userns-remap`, the host
    # account is very often uid 1000 — so the check passes — while the
    # container's uid 1000 maps to a different host uid, and the bind mount is
    # unwritable anyway. The only thing that answers the question is a write
    # attempted through the same mapping the containers use.
    #
    # Not run during preflight because it needs the built image, and paying a
    # container start on every healthy run to catch a failure this rare is the
    # wrong trade. Here it costs nothing: the run has already failed.
    if ! dc "${COMPOSE_PROFILE[@]}" run --rm --no-deps \
      --entrypoint sh lawha-server \
      -c 'touch /data/.lawha-write-probe && rm -f /data/.lawha-write-probe' \
      >/dev/null 2>&1; then
      bad "The server cannot write to its data directory."
      say "    ${DIM}$DATA_DIR is not writable by the container's uid 1000.${OFF}"
      say "    ${DIM}On rootless Docker or userns-remap that is true even when${OFF}"
      say "    ${DIM}this account IS uid 1000, because the container's 1000 maps${OFF}"
      say "    ${DIM}to a different host uid. Find the mapped uid with:${OFF}"
      say "    ${DIM}  docker run --rm -v '$DATA_DIR':/d alpine stat -c '%u' /d${OFF}"
      say "    ${DIM}then chown both directories to it:${OFF}"
      say "    ${DIM}  sudo chown -R <uid>:<uid> '$DATA_DIR' '$BACKUP_DIR'${OFF}"
      say ""
    fi

    say "Look at why with:  ${DIM}${DC_HINT} logs${OFF}"
    exit 1
  fi
  sleep 3
done

dc "${COMPOSE_PROFILE[@]}" ps --format 'table {{.Name}}\t{{.Status}}'

# ── report ───────────────────────────────────────────────────────────────────

head_ "Ready"

say "  On this machine:  ${BOLD}http://localhost:$PORT${OFF}"

case "$TLS_MODE" in
  on | true | 1)
    TLS_PORT="$(read_env LAWHA_TLS_PORT)"
    say "  Over TLS:         ${BOLD}https://${STACK_PREFIX}.local:${TLS_PORT:-9443}${OFF}"
    say "    ${DIM}Both ports serve the same app. The plain one is what the gateway${OFF}"
    say "    ${DIM}proxies; this one is for devices that trust certs/lawha-ca.pem.${OFF}"
    ;;
esac

# ── the gateway ──────────────────────────────────────────────────────────────
#
# portless is what turns a port into a name colleagues can type. Checked rather
# than assumed, because the failure is quiet in both directions: a route
# pointing at a port nothing listens on answers 502, and a route that was never
# registered answers 404 — and neither says "Lawha".
if command -v portless >/dev/null 2>&1; then
  ROUTES="$(portless list 2>/dev/null || true)"

  # BOTH SPELLINGS. portless used to name its routes `lawha.localhost` and now
  # names them `lawha.local`, and matching only the old one made this report
  # "no 'lawha' route" on a route that was registered, correct, and answering
  # 200 — the exact false alarm this block exists to avoid, wearing the other
  # hat. The trailing boundary matters too: without it `lawha.local` is a
  # prefix of `lawha.localhost` and the two cases below cannot be told apart.
  #
  # The name is $STACK_PREFIX rather than a literal, because two stacks on one
  # machine need two names — `lawha.local` and, say, `lawha2.local` — and a
  # second stack that reported on the first one's route would be worse than
  # reporting nothing. The variable expands; the rest stays single-quoted so
  # the regex metacharacters reach grep intact.
  readonly ROUTE_RE="${STACK_PREFIX}"'\.local(host)?([[:space:]]|$)'

  # And on the port, `([^0-9]|$)` rather than nothing: PORT=900 would otherwise
  # match `localhost:9002` and report a route to a port nothing is bound to.
  if printf '%s' "$ROUTES" | grep -qE "${ROUTE_RE}.*localhost:${PORT}([^0-9]|$)"; then
    ok "portless route: $STACK_PREFIX → $PORT"
  elif printf '%s' "$ROUTES" | grep -qE "$ROUTE_RE"; then
    warn "portless has a '$STACK_PREFIX' route, but NOT to port $PORT:"
    printf '%s\n' "$ROUTES" | grep -E "$ROUTE_RE" | sed 's/^/      /'
    say "    ${DIM}Repoint it:  portless alias $STACK_PREFIX $PORT --force${OFF}"
  else
    warn "portless is installed but has no '$STACK_PREFIX' route"
    say "    ${DIM}portless alias $STACK_PREFIX $PORT${OFF}"
  fi

  # The proxy has to be RUNNING, on port 80, in LAN mode, or the name resolves
  # nowhere. Without sudo it silently falls back to 1355 and the clean URL —
  # the whole point of it — is the one thing it does not deliver.
  if ss -ltn 2>/dev/null | grep -qE ':80\s'; then
    say "  On the network:   ${BOLD}http://${STACK_PREFIX}.local${OFF}"
  else
    warn "nothing is listening on port 80, so http://${STACK_PREFIX}.local will not resolve"
    say "    ${DIM}sudo portless service install --lan --no-tls${OFF}"
    say "    ${DIM}--lan advertises the .local name; --no-tls puts it on port 80 as plain http${OFF}"
  fi
else
  say ""
  say "  To give it a name on the network, install the gateway:"
  say "    ${DIM}npm i -g portless${OFF}"
  say "    ${DIM}portless alias $STACK_PREFIX $PORT${OFF}"
  say "    ${DIM}sudo portless service install --lan --no-tls${OFF}"
  say "  which makes it reachable at ${BOLD}http://${STACK_PREFIX}.local${OFF}"
fi

if [ "$PUBLIC" = true ]; then
  say "  From anywhere:    ${BOLD}${NGROK_DOMAIN_VALUE}${OFF}"
  say ""
  # ASK THE ENDPOINT, don't read the logs.
  #
  # This grepped `docker compose logs ngrok` for a success line, and reported a
  # warning on a tunnel that was working perfectly: the image emits nothing at
  # all unless `--log` is passed, so the grep matched nothing and the absence
  # of evidence was reported as evidence of absence. Fetching /healthz through
  # the public URL tests the actual thing — DNS, the tunnel, nginx and
  # lawha-server, end to end from outside.
  say ""
  if curl -fsS -o /dev/null -m 20 -H "ngrok-skip-browser-warning: 1" \
       "${NGROK_DOMAIN_VALUE%/}/healthz" 2>/dev/null; then
    ok "tunnel verified — the public URL answers /healthz from outside"
  else
    warn "the public URL did not answer /healthz yet"
    say "    ${DIM}It can take a few seconds. Then: ${DC_HINT} logs ngrok${OFF}"
    say "    ${DIM}A domain that belongs to a different account fails here.${OFF}"
  fi
  say ""
  say "  ${YELLOW}This deployment is now reachable from the internet.${OFF}"
  say "  ${DIM}Free-plan ceilings: 1 GB transfer and 20k requests a month. A${OFF}"
  say "  ${DIM}collaborative canvas is not a light user of either — watch${OFF}"
  say "  ${DIM}https://dashboard.ngrok.com if colleagues report it going quiet.${OFF}"
  say "  ${DIM}Stop the tunnel without stopping Lawha:  ${DC_HINT} stop ngrok${OFF}"
fi

# The first-boot administrator password is printed once, to the log, and is not
# recoverable afterwards. Surfacing it here is the difference between a working
# deployment and one nobody can sign in to.
if dc logs lawha-server 2>/dev/null | grep -q "first boot"; then
  head_ "First-boot administrator"
  # -A14, not -A4. The banner is thirteen lines and the PASSWORD is on the
  # sixth — so the original truncated one line above the only line anyone
  # opens this section to read, and did it silently, printing a box that
  # looked complete. The whole point of surfacing this is that the password is
  # shown once and never again.
  dc logs lawha-server 2>/dev/null | grep -A14 "first boot" | sed 's/^/  /'
  say ""
  say "  ${YELLOW}Write this down now.${OFF} It is not stored in readable form and is not shown again."
fi

say ""
