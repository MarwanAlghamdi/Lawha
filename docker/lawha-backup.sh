#!/usr/bin/env bash
#
# The scheduler that turns `lawha-server/scripts/backup.mjs` from a command
# somebody remembers to run into a policy that runs itself.
#
# `backup.mjs` was written with a cron wrapper in mind — it exits non-zero on
# every failure, quarantines a bad artefact as `.rejected`, and prunes with
# `--keep N` — and that wrapper was never written, so for months the backup
# policy of this deployment was "an operator types the command". This file is
# the wrapper, and it runs as its own compose service so that a backup exists
# from the first `docker compose up` rather than from the first time somebody
# reads the README to the end.
#
# ─────────────────────────────────────────────────────────────────────────────
# READ THIS BEFORE YOU CHANGE HOW THE DATABASE IS COPIED
#
# This script must never `cp`, `tar`, `rsync` or volume-snapshot `lawha.db`.
# The database runs in WAL mode: on disk it is usually a 4KB header while every
# table lives in `lawha.db-wal`. A file copy therefore yields a database with
# ZERO TABLES that restores silently and contains nothing — and that is not a
# theory, it is how this deployment lost its accounts once already. A `tar` of
# the data directory has the mirror-image failure: it catches the `-wal`
# mid-transaction and the archive holds a `-wal` that disagrees with the `.db`
# beside it, which you discover at restore time.
#
# The ONLY correct way to copy this database while the server is running is
# SQLite's online backup API, which is what `backup.mjs` calls. If you are here
# to "simplify" this file into a `cp` or a `tar` in a cron container: that is
# the exact change that caused the outage this whole apparatus exists to
# prevent. The blob and config mirrors further down use `cp` (or `age`, when
# LAWHA_BACKUP_RECIPIENT is set — see the comments there) and are allowed to,
# because those files are immutable or small config, and are not SQLite.
# ─────────────────────────────────────────────────────────────────────────────
#
# WHY A LOOP AND NOT CRON. The runtime image is `node:22-slim`, which ships no
# cron daemon; installing one means apt, root, and a second process supervisor
# in a container that has one job. It also means cron's environment, which is
# scrubbed to almost nothing — and `LAWHA_DB_PATH` missing is not a harmless
# omission here, because `backup.mjs` then falls back to its `./lawha-data`
# default, which is not where the data is. A loop in the container's own
# environment cannot lose a variable it never had to re-declare.
#
# WHY NOT A HOST SYSTEMD TIMER. Because a backup policy that needs a second
# install step is a backup policy that is not installed. This starts with the
# stack, stops with it, and is described in the same file as everything else.

# Deliberately NOT `set -e`. A scheduler whose whole job is to keep running
# must survive a failed run; a backup that fails at 03:00 must not stop the one
# at 03:00 tomorrow. Failures are handled where they happen and shouted about.
set -uo pipefail

# ── Mount points, not settings ───────────────────────────────────────────────
#
# These three are where docker-compose.yml mounts things, so they are pinned
# here and are not configurable. Pointing BACKUP_DIR somewhere that is not a
# mount would write every backup to the container's writable layer, where
# `docker compose down` takes the lot — the failure mode being exactly "we had
# backups" followed by "we do not have backups".
readonly BACKUP_DIR=/backups
readonly SCRIPTS_DIR=/opt/lawha/scripts
DB_PATH="${LAWHA_DB_PATH:-/data/lawha.db}"
FILES_DIR="${LAWHA_FILES_DIR:-/data/files}"

# The leading dot is load-bearing. `backup.mjs` recognises a backup by
# `^lawha-\d{8}-\d{6}\.db$`, so a name outside that shape can never be counted
# by retention, deleted by it, or offered to `restore.mjs` as a candidate.
readonly STATUS_FILE="$BACKUP_DIR/.lawha-backup-status"

# A second, independent signal that the WRITE to $STATUS_FILE itself is
# failing — deliberately NOT under $BACKUP_DIR. write_status's own log line
# (below) covers "loud in the container log"; this covers "the healthcheck
# can see it" for the disk-full/unwritable-$BACKUP_DIR case that is most
# likely to break the real backup too. A marker written into the SAME
# directory as the write that just failed would fail for the identical
# reason and prove nothing — /tmp is this container's own writable layer,
# never the bind-mounted archive, so `--health` (a fresh process, invoked on
# Docker's own schedule) can still see this even when $BACKUP_DIR cannot be
# written to at all.
readonly WRITE_FAILURE_MARKER=/tmp/.lawha-backup-status-write-failed

# ── Settings, from lawha.env ─────────────────────────────────────────────────
#
# Defaults live HERE and not in the compose file's `environment:` block, and
# that is the whole reason they can be changed at all: compose gives
# `environment:` priority over `env_file:`, so anything listed there is
# unsettable from lawha.env — silently, which is the trap docker-compose.yml
# and lawha.env.example both carry a box about.
INTERVAL_HOURS="${LAWHA_BACKUP_INTERVAL_HOURS:-24}"
KEEP="${LAWHA_BACKUP_KEEP:-14}"
MIRROR_BLOBS="${LAWHA_BACKUP_FILES:-true}"

# An `age` public key (age1...) that backups get encrypted to before this
# script ever writes them into $BACKUP_DIR. Empty is the default — same
# meaning as an unset LAWHA_BACKUP_RECIPIENT in lawha-server itself
# (src/config.ts): an existing deployment stays exactly as it is until it
# opts in. Read straight, not validated here — lawha-server already refuses
# to boot on a malformed value (Zod, at load time), and re-checking the
# shape with a second regex in bash is how the two copies drift apart. What
# this script owns is reporting the CONSEQUENCE of what's set, at startup,
# below.
RECIPIENT="${LAWHA_BACKUP_RECIPIENT:-}"

# Whether to copy the deployment's CONFIGURATION beside its data.
#
# The archive used to hold the database and the blobs and nothing else, and the
# README said so — which meant a verified, complete backup still could not
# rebuild the deployment. `lawha.env` holds LAWHA_MASTER_PASSWORD; `certs/`
# holds the CA every device on the network has been told to trust; `./.env`
# holds the origin. Restore without them and you have everyone's boards behind
# a certificate nobody trusts and an administrator password nobody knows.
#
# THE CONSEQUENCE, stated here because it changes what the archive IS: with
# this on, `$BACKUP_DIR` contains secrets. It was already sensitive — the
# database holds argon2 hashes and every board's ciphertext — but a master
# password and a CA private key are a different category. The directory should
# be 0700 and the copies are written 0600.
#
# When LAWHA_BACKUP_RECIPIENT is set, `mirror_config` (below) encrypts every
# file it copies with `age` instead of writing it in the clear — see the
# comment on that function. This is the single highest-value thing this whole
# encryption feature does: a stolen archive without it is "everyone's boards",
# and with LAWHA_MASTER_PASSWORD and the CA private key sitting in plaintext
# right beside them, it is "everyone's boards AND the credentials to the
# running deployment".
MIRROR_CONFIG="${LAWHA_BACKUP_CONFIG:-true}"
readonly CONFIG_DIR=/config

# A second, off-host copy of the whole archive.
#
# EMPTY BY DEFAULT, and it is the one thing this service cannot do for you.
# `$BACKUP_DIR` defaults to ~/lawha-backups, which is on the same disk as
# ~/lawha-data — so the failure that takes the database takes its backups too,
# and that is not a backup policy, it is a filing system.
#
# It is a MOUNTED PATH rather than an rsync/ssh target, deliberately. The
# runtime image has neither rsync nor ssh in it, and putting them there would
# also mean putting a private key inside a container whose whole job is to hold
# your data. Mount the destination on the HOST — a second disk, a NAS over
# NFS/SMB, sshfs — and hand the path in. The credentials then live where the
# host already keeps credentials, and this loop only ever writes to a
# directory.
OFFSITE_DIR="${LAWHA_BACKUP_MIRROR_DIR:-}"

# How long a failed run waits before trying again. Never longer than the
# interval itself, so that a five-minute interval set for a test does not
# quietly become a fifteen-minute one the moment something fails.
readonly RETRY_SECONDS=900
# The server creates the database on its first boot. Until it exists there is
# nothing to back up and that is not an error, so it is polled rather than
# reported — the server's own healthcheck owns "the database never appeared".
readonly WAIT_SECONDS=300
# How late a backup may be before the healthcheck calls this container sick.
# One hour on top of the interval absorbs a long-running backup and a host that
# was asleep, without absorbing a scheduler that has stopped.
readonly OVERDUE_GRACE_SECONDS=3600

# Local time, because `backup.mjs` stamps its filenames in local time too and a
# log line in UTC beside a filename that is not is a five-minute detour nobody
# should have to take.
log() { printf 'lawha-backup: %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# ── The status file ──────────────────────────────────────────────────────────
#
# Silence is the bug: a scheduler that fails quietly presents as "we have
# backups" right up until somebody needs one. Every decision this loop makes is
# written here, the healthcheck below reads it, and `docker compose ps` then
# shows a red container for a stack whose backups have stopped — a signal that
# reaches an operator who is not reading the logs.
#
# Written through a temporary file and renamed, so a healthcheck that fires
# mid-write reads either the old status or the new one, never half a line.
write_status() {
  local state="$1" detail="$2" tmp="$STATUS_FILE.writing"

  if {
    printf 'status=%s\n' "$state"
    printf 'at=%s\n' "$(date +%s)"
    printf 'at_local=%s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
    printf 'interval_hours=%s\n' "$INTERVAL_HOURS"
    printf 'keep=%s\n' "$KEEP"
    printf 'detail=%s\n' "$detail"
  } >"$tmp" && mv -f "$tmp" "$STATUS_FILE"; then
    rm -f "$WRITE_FAILURE_MARKER"
    return 0
  fi

  # The two `2>/dev/null` this used to carry are gone on purpose — that was
  # the actual HIGH finding. Under disk-full or an unwritable $BACKUP_DIR, the
  # ONE mechanism that reports a broken backup was ALSO silently broken, and
  # every reader of this file (this container's own healthcheck, /admin,
  # `docker compose ps`) went on reporting the last good status for up to
  # INTERVAL_HOURS + OVERDUE_GRACE_SECONDS (~25h at the defaults) before
  # staleness alone would have caught it. Letting the real error reach the log
  # is most of the fix; the marker below is the rest of it.
  log "WARNING — could not write $STATUS_FILE — see the error above. Every"
  log "          reader of that file is now blind to the real backup state"
  log "          until this starts working again."
  : >"$WRITE_FAILURE_MARKER" 2>/dev/null

  return 1
}

read_status_field() {
  local wanted="$1" name value

  while IFS='=' read -r name value; do
    if [ "$name" = "$wanted" ]; then
      printf '%s' "$value"
      return 0
    fi
  done <"$STATUS_FILE"

  return 1
}

# ── --health ─────────────────────────────────────────────────────────────────
#
# The same file serves as the container's HEALTHCHECK so that the definition of
# "healthy backups" cannot drift away from the code that produces them.
#
# Note what is NOT checked: whether the newest file in the archive is a valid
# database. `backup.mjs` already verified it — integrity_check plus the four
# tables — and refused to give it a backup's name otherwise. Re-verifying here
# would mean opening a database on every healthcheck tick, and a second, weaker
# copy of a check that is already the strong one.
health() {
  # Checked before $STATUS_FILE itself — see WRITE_FAILURE_MARKER's own
  # comment for why a write failure needs a signal that does not live beside
  # the write that just failed. This is what turns the container unhealthy on
  # the NEXT healthcheck tick, rather than after the staleness window below.
  if [ -f "$WRITE_FAILURE_MARKER" ]; then
    printf 'the last write to %s FAILED — see the container log\n' "$STATUS_FILE"
    return 1
  fi

  if [ ! -f "$STATUS_FILE" ]; then
    printf 'no status file at %s — the scheduler has not completed a cycle\n' \
      "$STATUS_FILE"
    return 1
  fi

  local state at now age
  state="$(read_status_field status)" || state=""
  at="$(read_status_field at)" || at=0
  now="$(date +%s)"
  age=$((now - at))

  case "$state" in
    disabled)
      # Turned off on purpose is not broken. Reporting it as unhealthy would
      # train an operator to ignore this container's health, which is the one
      # thing that must not happen to it.
      printf 'backups are disabled (LAWHA_BACKUP_INTERVAL_HOURS=0)\n'
      return 0
      ;;
    failed)
      printf 'the last backup FAILED: %s\n' "$(read_status_field detail)"
      return 1
      ;;
    ok | waiting)
      # One staleness rule for both. `waiting` refreshes every WAIT_SECONDS and
      # `ok` every INTERVAL_HOURS, so a status line older than the interval
      # plus the grace means the loop itself has stopped — which is the failure
      # no amount of checking the archive would ever reveal.
      local limit=$((INTERVAL_HOURS * 3600 + OVERDUE_GRACE_SECONDS))
      if [ "$age" -gt "$limit" ]; then
        printf 'last status was %ss ago, over the %ss limit — the scheduler has stalled\n' \
          "$age" "$limit"
        return 1
      fi
      printf 'status=%s, %ss ago\n' "$state" "$age"
      return 0
      ;;
    *)
      printf 'unrecognised status "%s"\n' "$state"
      return 1
      ;;
  esac
}

# ── Signals ──────────────────────────────────────────────────────────────────
#
# This runs as PID 1, where a shell blocked in `sleep` would otherwise ignore
# SIGTERM until the sleep ended and `docker compose down` would sit through its
# ten-second timeout on every stop. Worse, a SIGTERM arriving mid-backup would
# reach only this shell, leaving `backup.mjs` to be SIGKILLed with its handlers
# unrun. So every child runs in the background and is waited on, and the trap
# forwards the signal to it — `backup.mjs` then removes its own partial copy
# and says so, which is the behaviour it was written to have.
child=""

on_signal() {
  local signal="$1" number="$2"

  log "received SIG$signal — stopping"

  if [ -n "$child" ]; then
    # If that child is `backup.mjs` this is the whole point: it has its own
    # handlers for exactly these signals, and they remove the partial copy and
    # say so. Killed without them it would be SIGKILLed on the compose timeout
    # and leave the partial behind — harmless, because it never wears a
    # backup's name, but confusing to find.
    kill -"$signal" "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi

  exit $((128 + number))
}

trap 'on_signal TERM 15' TERM
trap 'on_signal INT 2' INT

# Runs a command in the background and waits, so the traps above can act.
#
# THERE IS DELIBERATELY NO TIMEOUT ON THIS `wait`, and it is worth saying why,
# because a `backup.mjs` wedged on a lock or a stalled mirror write is one of
# only two ways this container reaches Up-but-not-backing-up (the other is an
# operator stopping it, which `restart: unless-stopped` correctly does not
# undo). A wedged child leaves the status line frozen at its last value for
# ever, and Compose has no autoheal.
#
# What was rejected, and the shape it would have taken: `timeout` IS in this
# image (GNU coreutils 9.1, /usr/bin/timeout — checked, not assumed), and
# wrapping ONLY `take_database_backup` — never this function, which also waits
# on sleeps of up to $INTERVAL_HOURS — with a bound of a few hours would kill
# a wedge and let the retry path take over. Two things stopped it. The bound
# is a guess: `backup.mjs` walks the whole database through the online backup
# API, and how long that legitimately takes on a large database over slow
# storage is not something this repository knows, so any number here risks
# killing a real backup on the one deployment big enough to need one — and a
# killed backup that retries every RETRY_SECONDS is a worse failure than a
# stalled one, because it burns disk and never converges. And the wedge is no
# longer silent: `--health` has always caught it after INTERVAL_HOURS + the
# grace, and `readBackupStatus` now applies the SAME rule, so `/admin` says
# "overdue" instead of "Running normally". Both readers now report it; only
# the recovery is still manual (`docker compose restart lawha-backup`).
#
# If this is ever revisited, the missing piece is a way to TEST it — nothing
# here exercises the main loop, only the individual functions.
run_child() {
  "$@" &
  child=$!
  wait "$child"
  local status=$?
  child=""
  return $status
}

# ── The archive ──────────────────────────────────────────────────────────────

# When the newest backup in the archive was taken, as an epoch second, or 0 for
# an empty archive.
#
# Read from the file's MTIME rather than parsed out of its name, and the reason
# is timezones: `backup.mjs` stamps `lawha-YYYYMMDD-HHMMSS.db` in the LOCAL time
# of whatever process wrote it, which is this container (UTC unless you set TZ)
# for these runs and the host's zone for a manual one taken per the README. An
# mtime is absolute and means the same thing for both.
newest_backup_epoch() {
  local newest=0 file mtime

  # TWO globs, not one: `backup.mjs` writes `lawha-<stamp>.db` with no
  # recipient configured and `lawha-<stamp>.db.age` with one, and this
  # function has to recognise whichever one the current run actually
  # produces. A single `lawha-*.db` glob was the exact bug this comment now
  # documents — once a recipient is set, every new artefact is `.db.age`,
  # this loop would see none of them, `newest` would stay 0 forever, and the
  # "a recent backup already exists" guard below (`run_once`'s caller) would
  # never fire: the scheduler would take a fresh backup on every pass through
  # its loop instead of respecting $INTERVAL_HOURS.
  #
  # Both globs still exclude a `.partial` mid-write and a `.rejected` failed
  # verification, for the same reason as always: neither ends in exactly
  # `.db` or exactly `.db.age`, so a partial or rejected file counting as "a
  # recent backup" would suppress the real one. `lawha-*.db` cannot match a
  # `.db.age` name either — a glob match is against the WHOLE string, and
  # "lawha-<stamp>.db.age" does not end in the literal ".db".
  for file in "$BACKUP_DIR"/lawha-*.db "$BACKUP_DIR"/lawha-*.db.age; do
    [ -f "$file" ] || continue
    mtime="$(stat -c %Y "$file" 2>/dev/null)" || continue
    if [ "$mtime" -gt "$newest" ]; then
      newest="$mtime"
    fi
  done

  printf '%s' "$newest"
}

# ── The database ─────────────────────────────────────────────────────────────

take_database_backup() {
  # `--db` is passed explicitly even though LAWHA_DB_PATH is set, because the
  # cost of it being wrong is unbounded and the cost of saying it twice is a
  # line. `backup.mjs`'s built-in default is `./lawha-data/lawha.db`, which is
  # the path in a developer checkout and is NOT where the deployed database
  # lives; a run that silently used it would fail here, but on a machine where
  # such a file happened to exist it would succeed and back up the wrong thing.
  run_child node "$SCRIPTS_DIR/backup.mjs" \
    "$BACKUP_DIR" --db "$DB_PATH" --keep "$KEEP"
}

# ── The blobs ────────────────────────────────────────────────────────────────
#
# The database holds file RECORDS; the bytes are under LAWHA_FILES_DIR. Without
# them a restore comes back with every board intact and every image
# permanently grey, and unlike the scenes there is nothing that can regenerate
# them. So they are covered here.
#
# These files are immutable and content-addressed — written by the server
# with write-then-rename (`http/routes/files.ts`), never modified after —
# which is why copying them with `cp` (below) is correct here in a way it is
# NOT for `lawha.db`: there is no WAL hazard for a file nothing ever writes to
# twice. They are NOT encrypted by anything upstream of this function: ADR
# 0012 removed the client-side scene/board encryption this comment used to
# claim covered them too, and a board's images are exactly as plaintext on
# disk as its scene JSON is. When LAWHA_BACKUP_RECIPIENT is set, THIS function
# is what encrypts them — with `age`, to `<id>.age` — not something upstream.
#
# The mirror is a SINGLE append-only directory, not one dated copy per run.
# File ids are content hashes, so a file that exists is already the right
# bytes and a dated copy would be N identical copies of the same blob. Never
# deleting means the mirror is a superset of every snapshot in the archive: a
# blob the server has since deleted is still there for the older database
# backup that still references it.
#
# ENCRYPTED ONCE, ON FIRST COPY, same rule as everything else that is
# immutable in this file. The `[ -e "$target" ]` check a few lines down is the
# ONLY thing that decides "already mirrored" — and `$target` already carries
# the `.age` suffix when a recipient is configured, so a blob mirrored under
# ONE regime is never revisited under the other. That is a deliberate choice,
# not an oversight: reconciling the two forms (as `mirror_config` below does,
# cheaply, because config is a handful of files rewritten every run) would
# mean re-reading and re-encrypting every blob in the archive the moment
# LAWHA_BACKUP_RECIPIENT is first set, turning a cheap append-only mirror into
# an O(archive) job on that one run and on every run after a recipient is
# added or removed. "Encrypted once, on first copy" means new blobs from the
# moment a recipient exists — not a retroactive sweep of the whole archive.
#
# ORDER MATTERS, and it is database first, blobs second. An upload lands on
# disk before its row is written, so any blob the database snapshot references
# was already on disk when the snapshot was taken and is therefore caught by a
# mirror that runs after it. Mirroring first would leave a window in which a
# blob uploaded between the two steps is referenced by the snapshot and absent
# from the mirror — a board that restores with a hole in it.
mirror_blobs() {
  if [ ! -d "$FILES_DIR" ]; then
    log "no blob directory at $FILES_DIR yet — nothing to mirror"
    return 0
  fi

  local dest="$BACKUP_DIR/files"
  if ! mkdir -p "$dest"; then
    log "WARNING — could not create $dest; blobs were NOT mirrored"
    return 1
  fi

  local copied=0 failed=0 file relative target tmp

  # Listed to a file rather than streamed straight into the loop below, so
  # `find`'s own exit status is available afterwards as a plain `$?`. Fed by
  # process substitution the way this loop used to be, that status is
  # unreachable — the exit code belongs to `read`, not to the producer on the
  # other end of the pipe — and a permission-denied subdirectory makes `find`
  # exit non-zero while it STILL prints every path it could read. Silently
  # mirroring everything but the one directory nobody could read is exactly
  # the "it reported success" this project keeps getting bitten by.
  local filelist enum_status
  filelist="$(mktemp)"
  find "$FILES_DIR" -type f ! -name '*.tmp-*' -print0 >"$filelist"
  enum_status=$?

  while IFS= read -r -d '' file; do
    relative="${file#"$FILES_DIR"/}"
    target="$dest/$relative"
    # See the function header: the suffix IS the "which regime mirrored this"
    # marker. A recipient means every blob copied FROM HERE ON gets the .age
    # name; one already mirrored without a recipient keeps its plaintext name
    # and this loop never looks at it again.
    [ -n "$RECIPIENT" ] && target="$target.age"

    # Content-addressed and immutable: a file that is already here — under
    # THIS run's target name — is already correct. One stat, same as before
    # encryption existed; see the header comment for why this deliberately
    # does not also check the other form.
    [ -e "$target" ] && continue

    if ! mkdir -p "$(dirname "$target")"; then
      failed=$((failed + 1))
      continue
    fi

    # Copied (or encrypted) to a temporary name and renamed, for the same
    # reason the server writes uploads that way and for the same reason
    # `backup.mjs` writes `.partial`: a copy interrupted half-way would
    # otherwise leave a truncated file at the real name, and the `[ -e ]` test
    # above would then preserve that truncation forever. One silently short
    # or corrupt blob is exactly the class of artefact this project keeps
    # being bitten by.
    tmp="$target.copying"
    if [ -n "$RECIPIENT" ]; then
      # `age -r <recipient> -o <out> <in>` reads and writes real files
      # directly — no stdin/stdout pipe needed the way `backup.mjs`'s Node
      # helper needs one, because this loop and `age` share one filesystem.
      # Deliberately the real `age` binary invoked straight from bash, not a
      # `node scripts/backup.mjs` subprocess per blob: spawning a whole Node
      # process per file would turn "one stat per blob" into "one V8 startup
      # per blob", which is a real cost this loop can run over thousands of
      # files.
      if age -r "$RECIPIENT" -o "$tmp" "$file" && mv -f "$tmp" "$target"; then
        copied=$((copied + 1))
      else
        rm -f "$tmp"
        failed=$((failed + 1))
      fi
    else
      if cp -p "$file" "$tmp" && mv -f "$tmp" "$target"; then
        copied=$((copied + 1))
      else
        rm -f "$tmp"
        failed=$((failed + 1))
      fi
    fi
    # `-name '*.tmp-*'` skips the server's own in-flight uploads: it writes
    # `<id>.tmp-<hex>` and renames, so a `.tmp-` file is a partial upload that
    # does not belong to any database row yet.
  done <"$filelist"
  rm -f "$filelist"

  if [ "$enum_status" -ne 0 ]; then
    failed=$((failed + 1))
    log "WARNING — could not fully list $FILES_DIR (find exited $enum_status);"
    log "          some blobs under it may not have been mirrored this run"
  fi

  if [ "$failed" -gt 0 ]; then
    log "WARNING — mirrored $copied new blobs to $dest, but $failed FAILED"
    return 1
  fi

  log "mirrored $copied new blobs to $dest"
  return 0
}

# ── One-time migration: blobs mirrored before RECIPIENT ever existed ────────
#
# `mirror_blobs` above deliberately never revisits an already-mirrored name —
# see its own header comment for why: reconciling both forms on every cycle
# would turn an O(1)-per-blob append-only mirror into an O(archive) job every
# `$INTERVAL_HOURS`. That is the right call for the RECURRING loop and leaves
# a real, permanent gap for anything mirrored plaintext before a recipient
# was ever configured — unlike the database artefact, which cycles old
# plaintext out through `--keep` retention, the blob mirror is explicitly
# never pruned, so a blob copied in the clear stays readable FOREVER unless
# something walks the archive once and fixes it. `warn_unencrypted_blobs`
# (below) is what notices the gap, at container start; this is what closes
# it, by hand, once.
#
# OPERATOR-INVOKED ONLY:
#   docker compose exec lawha-backup /opt/lawha/lawha-backup.sh --encrypt-existing-blobs
# Never called from `run_once` or the main loop — running this every cycle
# would be exactly the O(archive)-every-six-hours cost `mirror_blobs`'s
# "encrypted once, on first copy" design exists to avoid. This is the
# one-time sweep an operator runs after being told it is needed.
#
# Same atomic shape `mirror_config_file` already uses, not a third one:
# encrypt to a `.copying` staging name, rename onto the real `.age` name only
# once that succeeds, and ONLY THEN remove the plaintext original. A failure
# or an interrupt at any point leaves the plaintext exactly where it was —
# there is no window in which the plaintext is gone and no readable
# ciphertext has taken its place, because the plaintext is never touched
# until its replacement already exists under its own final name. Anything
# already named `*.age` is left alone: it is either a blob `mirror_blobs`
# itself already encrypted, or the result of a previous run of this same
# migration — re-processing it would be exactly the retroactive
# re-encryption `mirror_blobs`'s own design refuses to do.
encrypt_existing_blobs() {
  if [ -z "$RECIPIENT" ]; then
    log "FATAL: --encrypt-existing-blobs needs LAWHA_BACKUP_RECIPIENT set —"
    log "       there is no key to encrypt TO. Set it and run this again."
    return 1
  fi

  local dest="$BACKUP_DIR/files"
  if [ ! -d "$dest" ]; then
    log "no blob mirror at $dest — nothing to migrate"
    return 0
  fi

  # Leftovers from an interrupted PRIOR run of this same migration. Always
  # safe to discard outright: a `.copying` name is never authoritative
  # anywhere else in this file either, and one left behind here means the
  # rename that would have made it real never happened.
  find "$dest" -type f -name '*.age.copying' -delete 2>/dev/null

  local encrypted=0 failed=0 file tmp

  # Same reasoning as mirror_blobs: listed to a file so find's own exit status
  # survives past the loop. This function's failure mode is worse if it goes
  # unnoticed, because an operator runs it BY HAND and reads the summary below
  # as the answer — told "migrated N blob(s)" with nothing about the ones a
  # permission error hid, they would reasonably believe the migration is done
  # and never run it again. Per ADR 0020, the blobs it missed stay plaintext
  # in the archive forever.
  local filelist enum_status
  filelist="$(mktemp)"
  find "$dest" -type f ! -name '*.age' ! -name '*.copying' -print0 >"$filelist"
  enum_status=$?

  while IFS= read -r -d '' file; do
    tmp="$file.age.copying"
    if age -r "$RECIPIENT" -o "$tmp" "$file" && mv -f "$tmp" "$file.age"; then
      # Only NOW, with a complete ciphertext safely in place under its own
      # final name, does the plaintext original go. Reversing this order —
      # deleting first, encrypting after — is the one mistake this function
      # exists to never make.
      rm -f "$file"
      encrypted=$((encrypted + 1))
    else
      rm -f "$tmp"
      failed=$((failed + 1))
      log "WARNING — could not encrypt $file; left as plaintext"
    fi
  done <"$filelist"
  rm -f "$filelist"

  log "migrated $encrypted blob(s) under $dest to age"

  if [ "$enum_status" -ne 0 ]; then
    failed=$((failed + 1))
    log "WARNING — could not fully list $dest (find exited $enum_status);"
    log "          some plaintext blobs under it may not have been found, let"
    log "          alone migrated — this run is NOT a complete migration"
  fi

  if [ "$failed" -gt 0 ]; then
    log "WARNING — $failed blob(s) could not be encrypted and remain"
    log "          plaintext — fix the cause (a bad recipient? age missing?)"
    log "          and run --encrypt-existing-blobs again; it is safe to"
    log "          repeat, and skips everything already done."
    return 1
  fi

  return 0
}

# ── The configuration ────────────────────────────────────────────────────────
#
# Copied every run rather than once, because these files change — a reissued
# certificate, a rotated master password — and a stale copy restores a
# deployment nobody can reach.
#
# Overwritten in place rather than kept in dated generations. The database is
# the thing worth having history of; configuration is a current-state file, and
# fourteen generations of a master password is fourteen copies of a secret.
# Copies one configuration file to $target, encrypting it with `age` when
# $RECIPIENT is set, and prints the path it actually wrote — either $target or
# $target.age — so the caller can chmod and count the real artefact rather
# than guessing which form this run produced.
#
# Shared by the lawha.env/.env loop and the certs/ loop in mirror_config
# below, so the encrypt-or-cp decision and its .copying-then-rename atomicity
# are written once. Unlike mirror_blobs, config has no "first copy" concept —
# see MIRROR_CONFIG's own comment above: it is rewritten every run because
# these files change (a reissued certificate, a rotated master password) — so
# there is no cost reason not to reconcile the two forms on every run, and
# every reason to: `rm -f` on the OTHER form below means turning encryption ON
# does not leave a stale plaintext lawha.env sitting right beside its own
# freshly encrypted twin. LAWHA_MASTER_PASSWORD and the CA private key are
# exactly the secrets this whole feature exists to stop leaving in the clear,
# and "encryption is now on" has to mean it, not "for new files only" — the
# reasoning `mirror_blobs` uses to justify the OPPOSITE choice for blobs does
# not apply here, because reconciling a handful of config files costs nothing
# extra while reconciling every blob in the archive would.
mirror_config_file() {
  local source="$1" target="$2"

  if [ -n "$RECIPIENT" ]; then
    if age -r "$RECIPIENT" -o "$target.age.copying" "$source" \
      && mv -f "$target.age.copying" "$target.age"; then
      rm -f "$target"
      printf '%s' "$target.age"
      return 0
    fi
    rm -f "$target.age.copying"
    return 1
  fi

  if cp -p "$source" "$target.copying" && mv -f "$target.copying" "$target"; then
    rm -f "$target.age"
    printf '%s' "$target"
    return 0
  fi
  rm -f "$target.copying"
  return 1
}

mirror_config() {
  if [ ! -d "$CONFIG_DIR" ]; then
    log "no config mount at $CONFIG_DIR — configuration was NOT backed up"
    log "  add it in docker-compose.yml, or set LAWHA_BACKUP_CONFIG=false"
    return 0
  fi

  local dest="$BACKUP_DIR/config"
  if ! mkdir -p "$dest"; then
    log "WARNING — could not create $dest; configuration was NOT backed up"
    return 1
  fi
  chmod 700 "$dest" 2>/dev/null || true

  local copied=0 failed=0 name source target written

  for name in lawha.env .env; do
    source="$CONFIG_DIR/$name"
    [ -e "$source" ] || continue

    # Docker creates a MISSING bind source as an empty DIRECTORY, so a
    # `./lawha.env:/config/lawha.env` mount for a file that does not exist
    # produces a directory here rather than an error. Saying so beats copying
    # nothing and reporting success.
    if [ -d "$source" ]; then
      log "WARNING — $source is a DIRECTORY, which means the host file it"
      log "          mounts does not exist. Create it and recreate this"
      log "          container ('up -d', not 'restart')."
      failed=$((failed + 1))
      continue
    fi

    target="$dest/$name"
    written="$(mirror_config_file "$source" "$target")"
    if [ -n "$written" ]; then
      chmod 600 "$written" 2>/dev/null || true
      copied=$((copied + 1))
    else
      failed=$((failed + 1))
    fi
  done

  # The certificates, including the CA every device on the network trusts.
  # Losing that means reinstalling a new CA on every phone and laptop by hand.
  if [ -d "$CONFIG_DIR/certs" ]; then
    if mkdir -p "$dest/certs" && chmod 700 "$dest/certs" 2>/dev/null; then
      for source in "$CONFIG_DIR"/certs/*; do
        [ -f "$source" ] || continue
        target="$dest/certs/$(basename "$source")"
        written="$(mirror_config_file "$source" "$target")"
        if [ -n "$written" ]; then
          chmod 600 "$written" 2>/dev/null || true
          copied=$((copied + 1))
        else
          failed=$((failed + 1))
        fi
      done
    else
      failed=$((failed + 1))
    fi
  fi

  if [ "$failed" -gt 0 ]; then
    log "WARNING — copied $copied configuration files, but $failed FAILED"
    return 1
  fi

  log "copied $copied configuration files to $dest ($([ -n "$RECIPIENT" ] && echo "encrypted, 0600" || echo "0600"))"
  return 0
}

# ── The off-host copy ────────────────────────────────────────────────────────
#
# Runs LAST, and only after everything above has succeeded. A corrupt artefact
# copied promptly is still a corrupt artefact, and `backup.mjs` has already
# opened, integrity-checked and row-counted the file by the time we get here —
# so what is mirrored is known-good rather than merely new.
mirror_offsite() {
  [ -n "$OFFSITE_DIR" ] || return 0

  if [ ! -d "$OFFSITE_DIR" ]; then
    log "WARNING — LAWHA_BACKUP_MIRROR_DIR=$OFFSITE_DIR is not mounted;"
    log "          the off-host copy did NOT happen. This is the copy that"
    log "          survives losing the disk, so it is a failure, not a skip."
    return 1
  fi

  # cp -a of the whole archive rather than a clever incremental: the blob
  # mirror is append-only and content-addressed, so an existing file is already
  # correct, and `-n` makes the repeat cheap without needing rsync.
  if cp -an "$BACKUP_DIR/." "$OFFSITE_DIR/" 2>/dev/null; then
    :
  else
    log "WARNING — the off-host copy to $OFFSITE_DIR FAILED"
    return 1
  fi

  # The newest database has to be forced: `cp -n` skips a name that already
  # exists, and while backup filenames are unique per second, the retention
  # pass means the off-host copy accumulates rather than mirroring. That is
  # deliberate — an off-host archive that prunes itself in step with the local
  # one shares the local one's mistakes.
  log "mirrored the archive to $OFFSITE_DIR"
  return 0
}

# ── One cycle ────────────────────────────────────────────────────────────────

run_once() {
  if ! take_database_backup; then
    log "the database backup FAILED — see the lines above; nothing was pruned"
    return 1
  fi

  if [ "$MIRROR_BLOBS" = "true" ]; then
    mirror_blobs || return 1
  fi

  if [ "$MIRROR_CONFIG" = "true" ]; then
    mirror_config || return 1
  fi

  mirror_offsite || return 1

  return 0
}

# ── Startup checks ───────────────────────────────────────────────────────────

preflight() {
  if [ ! -f "$SCRIPTS_DIR/backup.mjs" ]; then
    log "FATAL: $SCRIPTS_DIR/backup.mjs is missing."
    log "       docker-compose.yml mounts ./lawha-server/scripts here read-only;"
    log "       if that mount is gone, so is the only correct way to copy this"
    log "       database. Restore the mount rather than replacing it with a cp."
    exit 1
  fi

  if [ ! -d "$BACKUP_DIR" ]; then
    log "FATAL: $BACKUP_DIR is not mounted."
    exit 1
  fi

  # Docker creates a MISSING bind source as root:root, and this container runs
  # as the unprivileged `node` (uid 1000). The symptom without this check is a
  # backup that fails every interval for ever with an EACCES nobody reads.
  # Braces around the redirection, not `: >"$probe" 2>/dev/null`: bash applies
  # redirections left to right, so in that spelling the failure of the first
  # one is reported before the second one can silence it and the operator gets
  # a raw "Permission denied" above the explanation instead of the explanation.
  local probe="$BACKUP_DIR/.lawha-backup-probe.$$"
  if ! { : >"$probe"; } 2>/dev/null; then
    log "FATAL: $BACKUP_DIR is not writable by uid $(id -u)."
    log "       Docker creates a missing bind source as root:root. On the HOST:"
    log "         mkdir -p ~/lawha-backups && sudo chown 1000:1000 ~/lawha-backups"
    log "       then: docker compose up -d lawha-backup"
    exit 1
  fi
  rm -f "$probe"
}

validate_settings() {
  case "$INTERVAL_HOURS" in
    '' | *[!0-9]*)
      log "FATAL: LAWHA_BACKUP_INTERVAL_HOURS must be a whole number of hours"
      log "       (0 turns backups off); got \"$INTERVAL_HOURS\""
      exit 1
      ;;
  esac

  case "$KEEP" in
    '' | *[!0-9]*)
      log "FATAL: LAWHA_BACKUP_KEEP must be a whole number; got \"$KEEP\""
      exit 1
      ;;
  esac

  if [ "$KEEP" -lt 1 ]; then
    # Refused rather than clamped, exactly as `backup.mjs` refuses `--keep 0`:
    # it would delete the backup the same run just took.
    log "FATAL: LAWHA_BACKUP_KEEP must be at least 1; got \"$KEEP\""
    exit 1
  fi

  case "$MIRROR_BLOBS" in
    true | false) ;;
    *)
      log "FATAL: LAWHA_BACKUP_FILES must be true or false; got \"$MIRROR_BLOBS\""
      exit 1
      ;;
  esac

  case "$MIRROR_CONFIG" in
    true | false) ;;
    *)
      log "FATAL: LAWHA_BACKUP_CONFIG must be true or false; got \"$MIRROR_CONFIG\""
      exit 1
      ;;
  esac

  # Refused at startup rather than every interval. An off-host copy that has
  # never worked is the failure this whole setting exists to prevent, and
  # discovering it from a healthcheck four hours later is discovering it late.
  if [ -n "$OFFSITE_DIR" ] && [ ! -d "$OFFSITE_DIR" ]; then
    log "FATAL: LAWHA_BACKUP_MIRROR_DIR=$OFFSITE_DIR is not a directory in"
    log "       this container. It is a MOUNTED path, not a remote target —"
    log "       mount the destination on the host and add it to the"
    log "       lawha-backup volumes in docker-compose.yml."
    exit 1
  fi
}

# Counts blobs sitting in the mirror that predate LAWHA_BACKUP_RECIPIENT —
# see `encrypt_existing_blobs` above for why they exist and why nothing here
# fixes them automatically. Silence about a permanent plaintext gap is
# exactly the bug this codebase's own principle warns against, so this says
# so, loudly, in the same startup block as database/archive/blobs/encrypted/
# schedule below.
#
# Called EXACTLY ONCE, here, before the main loop even starts — never from
# inside it. A walk over the whole blob mirror is the same O(archive) cost
# `mirror_blobs`'s "one stat per blob" design exists to avoid paying every
# cycle; paying it once per container start, rather than every
# `$INTERVAL_HOURS`, is the trade this function makes on purpose.
warn_unencrypted_blobs() {
  [ -n "$RECIPIENT" ] || return 0

  local dest="$BACKUP_DIR/files"
  [ -d "$dest" ] || return 0

  # `pipefail` (set at the top of this file) is what makes $? below find's
  # exit status rather than wc's or tr's: a permission-denied subdirectory
  # makes `find` exit non-zero even though it still printed every path it
  # COULD read, and a count built from a partial listing is exactly the wrong
  # kind of wrong for this function — it can UNDERcount, all the way down to
  # zero, which reads as "nothing to warn about" and defeats the one thing
  # ADR 0020 relies on this function for.
  local count enum_status
  count="$(find "$dest" -type f ! -name '*.age' | wc -l | tr -d '[:space:]')"
  enum_status=$?

  if [ "$enum_status" -ne 0 ]; then
    log "WARNING — could not fully list $dest (find exited $enum_status); the"
    log "          count below, if any, may be an UNDERCOUNT — a permission"
    log "          error hides exactly the blobs this warning exists to find."
    log "          Fix the permissions and restart this container for an"
    log "          accurate count."
  fi

  if [ "${count:-0}" -gt 0 ]; then
    log "WARNING — $count blob(s) under $dest are PLAINTEXT, mirrored before"
    log "          LAWHA_BACKUP_RECIPIENT was set. mirror_blobs never"
    log "          revisits an already-mirrored blob, so they will stay"
    log "          readable FOREVER unless migrated by hand. Run:"
    log "            docker compose exec lawha-backup /opt/lawha/lawha-backup.sh --encrypt-existing-blobs"
  fi
}

# The key beside the lock.
#
# LAWHA_DB_KEY lives in lawha.env, and `mirror_config` copies lawha.env into
# $BACKUP_DIR/config every run — so with no recipient set, the archive holds
# the SQLCipher key in the clear, mode 0600, in the same directory tree as the
# SQLCipher artefacts it opens. Anyone who ends up with a copy of the archive
# has both halves, and the encryption at rest that LAWHA_DB_KEY was turned on
# for buys nothing against them.
#
# This is NOT news about the archive as a whole: it holds LAWHA_MASTER_PASSWORD
# and the CA private key too, and lawha.env.example says so at length. It is
# news about a specific expectation — somebody who set LAWHA_DB_KEY did it to
# make a stolen copy of the database useless, and this is the one place that
# assumption quietly does not hold. Setting LAWHA_BACKUP_RECIPIENT is what
# closes it, because the config mirror is then written as `lawha.env.age` under
# a private key that is deliberately not on this machine.
#
# THE KEY ITSELF IS NEVER PRINTED, only whether there is one — same rule as the
# `db key` start-up line this elaborates. A warning that echoed the value into
# `docker compose logs` would be this same finding again with a wider audience
# than the archive it is complaining about.
warn_db_key_in_the_clear() {
  [ -n "${LAWHA_DB_KEY:-}" ] || return 0
  [ -z "$RECIPIENT" ] || return 0

  log "WARNING — LAWHA_DB_KEY is set and LAWHA_BACKUP_RECIPIENT is not, so"
  log "          the config/ copy of lawha.env in this archive carries the"
  log "          SQLCipher key IN THE CLEAR, beside the encrypted database"
  log "          it opens. Anyone holding the archive holds both halves."
  log "          Set LAWHA_BACKUP_RECIPIENT (see lawha.env.example) to write"
  log "          that copy as config/lawha.env.age instead."
}

# ── Main ─────────────────────────────────────────────────────────────────────

if [ "${1:-}" = "--health" ]; then
  health
  exit $?
fi

if [ "${1:-}" = "--encrypt-existing-blobs" ]; then
  preflight
  encrypt_existing_blobs
  exit $?
fi

preflight
validate_settings
warn_unencrypted_blobs

if [ "$INTERVAL_HOURS" -eq 0 ]; then
  # Off, but still running and still saying so. A container that exited would
  # look identical to one that crashed, and `restart: unless-stopped` would
  # then loop it for ever.
  log "LAWHA_BACKUP_INTERVAL_HOURS=0 — automatic backups are OFF."
  log "Nothing will be backed up until you set it and run: docker compose up -d"
  write_status disabled "LAWHA_BACKUP_INTERVAL_HOURS=0"
  while :; do
    run_child sleep 86400
  done
fi

interval_seconds=$((INTERVAL_HOURS * 3600))
retry_seconds=$((RETRY_SECONDS < interval_seconds ? RETRY_SECONDS : interval_seconds))

log "database  $DB_PATH"
log "archive   $BACKUP_DIR (keep $KEEP)"
log "blobs     $([ "$MIRROR_BLOBS" = "true" ] && echo "$FILES_DIR -> $BACKUP_DIR/files" || echo "not mirrored (LAWHA_BACKUP_FILES=false)")"
log "encrypted $([ -n "$RECIPIENT" ] && echo "yes -> $RECIPIENT" || echo "NO — set LAWHA_BACKUP_RECIPIENT to stop writing plaintext backups")"
# Reported separately from the line above because they are two different keys
# protecting two different things, and a restore may need either, both or
# neither. LAWHA_DB_KEY is SQLCipher on the database ITSELF (src/config.ts):
# when it is set, backup.mjs opens the source with it and the artefact it
# writes is SQLCipher ciphertext from its first byte, so restoring one needs
# the same value. The key is never printed — only whether there is one.
log "db key    $([ -n "${LAWHA_DB_KEY:-}" ] && echo "LAWHA_DB_KEY is set — artefacts are SQLCipher and need it to restore" || echo "none (the database is a plain SQLite file)")"
# A footnote to the line above, and placed here rather than beside
# warn_unencrypted_blobs so it reads as one. Below the INTERVAL_HOURS=0 branch
# on purpose: a disabled scheduler never runs mirror_config, so there is no
# copy of lawha.env in the archive for it to be warning about.
warn_db_key_in_the_clear
log "schedule  every $INTERVAL_HOURS h"

while :; do
  if [ ! -f "$DB_PATH" ]; then
    # A fresh deployment: lawha-server has not created the database yet. This
    # service deliberately does not wait on the server's health — a server that
    # will not start is precisely when its last backup matters most, and
    # coupling the two would mean the backups stop at the same moment the
    # server does.
    log "no database at $DB_PATH yet — lawha-server creates it on first boot; waiting"
    write_status waiting "no database at $DB_PATH yet"
    run_child sleep "$WAIT_SECONDS"
    continue
  fi

  newest="$(newest_backup_epoch)"
  age=$(($(date +%s) - newest))

  if [ "$newest" -ne 0 ] && [ "$age" -lt "$interval_seconds" ]; then
    # The schedule's phase lives in the ARCHIVE, not in this process, and that
    # is what makes it survive a restart. Backing up unconditionally at startup
    # was the obvious first version and it is wrong: `docker compose up -d`
    # during an afternoon of rebuilds would take a dozen backups an hour apart
    # and retention would delete a fortnight of history to keep them. Asking
    # the archive how old the newest backup is answers "is one due?" without
    # this process having to remember anything across restarts.
    remaining=$((interval_seconds - age))
    log "newest backup is ${age}s old — next in ${remaining}s"
    write_status ok "newest backup is ${age}s old"
    run_child sleep "$remaining"
    continue
  fi

  # An empty archive reaches here too, which is the point: the first backup of
  # a new deployment is taken within seconds of `docker compose up`, not in
  # twenty-four hours' time. The window between "we started using this" and "we
  # have a backup" is the window every backup story starts in.
  log "taking a backup"

  if run_once; then
    write_status ok "backup completed"
    run_child sleep "$interval_seconds"
  else
    write_status failed "see the container log; retrying in ${retry_seconds}s"
    log "retrying in ${retry_seconds}s"
    run_child sleep "$retry_seconds"
  fi
done
