# Backups and restore

The `lawha-backup` service takes verified snapshots on a timer. Automated backups are the default; both automatic and manual restore procedures exist. But first, the one-sentence hazard.

## The hazard — read this first

**`lawha.db` runs in WAL mode and spends its life as a 4KB header plus a multi-megabyte `-wal` file. A copy made with `cp`, `tar`, or `rsync` produces a database with zero tables that opens, restores silently, and contains nothing.** This deployment lost its accounts to exactly this mistake once. The fix is `scripts/backup.mjs`, which uses SQLite's online backup API, verifies the artefact, and stops if verification fails.

Never copy `lawha.db` yourself. Ever. Not `cp`, not `tar`, not `rsync`, not a volume snapshot. Use `backup.mjs` (automatic or by hand) or you will have a database that looks fine and has no data.

---

## Automatic backups

The `lawha-backup` service runs on its own and needs nothing from you. Settings go in `lawha.env`:

- **`LAWHA_BACKUP_INTERVAL_HOURS`** — how often (default 24). `0` disables automatic backups.
- **`LAWHA_BACKUP_KEEP`** — how many to retain (default 14). Retention verifies every candidate before counting it.
- **`LAWHA_BACKUP_FILES`** — mirror the uploaded images (default `true`). `false` gives you restorable boards with permanently grey pictures.
- **`LAWHA_BACKUP_CONFIG`** — mirror `.env`, `lawha.env` and `certs/` (default `true`). The archive is incomplete without them, but this makes the archive secret-bearing.

The first backup happens within seconds of `docker compose up -d`, not at the interval. Backups go to `~/lawha-backups` on the host, with names like `lawha-20260805-165134.db`.

### Health

The backup container reports itself **unhealthy** if the last run failed or if no run has finished within the interval plus an hour. Check it:

```bash
docker compose ps
cat ~/lawha-backups/.lawha-backup-status    # the verdict, in plain text
```

---

## Download from the admin panel

Open `/admin` → **Backups**. The card shows the schedule and health, and offers two operations:

- **Back up now and download** — takes a copy immediately, streams it, and deletes it. Does **not** enter the retention rotation. Re-enters your password (an unattended laptop should not be enough to walk away with every board and password hash).
- **Download** on any kept backup — both ask for your password again and both are written to the audit log.

Both hand back a `.tar` containing the database **and** the images. The archive is safe to extract with ordinary `tar` — what is inside is not the live database, but a copy taken through SQLite's online backup API, verified, and forced to `journal_mode = DELETE` so it has no sidecars left to lose.

---

## By hand

```bash
LAWHA_DB_PATH=~/lawha-data/lawha.db \
  corepack yarn --cwd lawha-server backup ~/lawha-backups
```

Read the row counts it prints. **Zero users means you did not back up what you thought you did.**

If you have set `LAWHA_DB_KEY` (encryption), this command needs it:

```bash
LAWHA_DB_KEY='<the value from lawha.env>' \
LAWHA_DB_PATH=~/lawha-data/lawha.db \
  corepack yarn --cwd lawha-server backup ~/lawha-backups
```

The key reaches the **containers** only. The scheduled backup and the `/admin` download read it from `lawha.env` and keep working. A backup you run by hand on the host does not see it and refuses by name — export it for that command.

---

## Restore

Stop everything that has the database open, restore, and start again:

```bash
docker compose stop lawha-server lawha-backup
LAWHA_DB_PATH=~/lawha-data/lawha.db \
  corepack yarn --cwd lawha-server restore ~/lawha-backups/lawha-20260805-165134.db
cp -an ~/lawha-backups/files/. ~/lawha-data/files/
docker compose start lawha-server lawha-backup
```

If you have set `LAWHA_DB_KEY`, prefix the `restore` command:

```bash
LAWHA_DB_KEY='<the value>' LAWHA_DB_PATH=~/lawha-data/lawha.db \
  corepack yarn --cwd lawha-server restore <backup-file>
```

### What `restore` does

1. Takes an exclusive lock on the database so nobody else has it open — if `lawha-backup` happens to be running, the command waits (that is why `docker compose stop lawha-backup` is first).
2. Verifies the artefact by opening it, running `integrity_check`, and counting rows.
3. Moves the current database aside as `lawha.db.pre-restore-<stamp>` — nothing is deleted.
4. Installs the restored copy.

**Nothing deletes anything.** The current database is kept and stays there until you remove it by hand, so a restore is always reversible.

### After restore

Check the logs:

```bash
docker compose logs lawha-server | head -20
```

**Do NOT see a first-boot administrator banner.** That banner means the server found zero accounts, which means it is not looking at your data. If you see it, the restore did not work — check the database path before doing anything else.

---

## Starting over with an empty database

There is no "reset" command. The procedure is explicit:

```bash
# 1. Take a final verified backup you can come back to.
LAWHA_DB_PATH=~/lawha-data/lawha.db \
  corepack yarn --cwd lawha-server backup ~/lawha-backups
cp -a ~/lawha-data/files ~/lawha-backups/files-$(date +%Y%m%d-%H%M%S)

# 2. Stop everything that has the database open.
./run.sh stop

# 3. Remove the database and its sidecars. Both sidecars matter: a leftover
#    -wal against a new database is a corrupt database.
rm -f ~/lawha-data/lawha.db ~/lawha-data/lawha.db-wal ~/lawha-data/lawha.db-shm

# 4. Optional — also drop the uploaded images.
rm -rf ~/lawha-data/files && mkdir -p ~/lawha-data/files

# 5. Start again. This is now a first boot.
./run.sh
```

The server will create a new first-boot administrator. **Write down the generated password.** The backup archive is untouched, so the old deployment is still restorable.

---

## Encrypted backups

Both encryption settings in `lawha.env` are optional and off by default. See [Configuration](configuration.md#encryption-at-rest) for details.

**`LAWHA_BACKUP_RECIPIENT`** encrypts the entire archive with an `age` public key. Only the private half ever lives off this machine, so the server can write ciphertext it can never read back. Restore with:

```bash
corepack yarn --cwd lawha-server restore ~/lawha-backups/lawha-….db.age \
  --identity ./lawha-backup.key
```

Losing the private key loses every backup. There is no recovery path.
