# 0017 — A backup you can take and carry away, without a shell

**Status:** accepted **Date:** 2026-08-05

## The gap

Lawha has had good backups since the `lawha-backup` service landed: verified through SQLite's online backup API, retained, blob-mirrored, config-mirrored, health-reported. What it did not have was any way to reach one without an SSH session and a working knowledge of `scripts/backup.mjs`.

That gap shows up in two places. The obvious one is "I want a copy of this before I do something risky". The one that actually mattered is `docs/deploy.md`'s move-to-a-new-device procedure, which asked an operator to copy three separate things — the newest `lawha-*.db`, the whole `~/lawha-data/files/` tree, and `lawha.env` — and got it wrong quietly if they missed the middle one, because a database restores perfectly well with every image gone.

## What was decided

**The archive is mounted into `lawha-server` read-only.** `/admin` can list the scheduled backups and hand one back. It cannot create, alter or delete one.

This is the load-bearing decision and it cost something real: a forced backup therefore cannot join the retention rotation, and "Back up now" produces a copy that is streamed and deleted rather than kept. That was accepted, because the alternative is worse than the inconvenience. `lawha-server` is the container with a port on it — the process an attacker reaches first. A writable archive mount there means one compromise reaches every backup, including the ones that exist to recover from a compromise, which is precisely the move ransomware makes. Writing stays with `lawha-backup`, which listens on nothing.

`backupCoverage.test.ts` asserts the `:ro`, and asserts that no second writable mount of the same path exists beside it.

**A download is a tar of the database _and_ the blobs.** `backup.mjs` is right to keep them apart — blobs are content-addressed and belong in an append-only mirror rather than duplicated into every nightly snapshot. But a person clicking Download means "give me the thing that restores this", and half of it with a note attached is how a restore fails at the worst possible moment.

Archived backups are paired with the backup container's mirror rather than the live `files/` directory, because the mirror never deletes: an old database can reference a blob the live deployment has since dropped, and pairing a three-month-old database with today's blobs restores boards whose images have quietly gone.

**Three steps, because of how browsers download.** The step-up password must travel in a POST body — a password in a URL lands in browser history and the nginx access log. But a POST cannot produce a save-to-disk download, and reading the response with `fetch` to build an object URL holds the entire archive in the tab's memory. So: POST proves who is asking and returns a single-use ticket, a plain GET redeems it and streams to disk, and the ticket is dead in sixty seconds and bound to the session that asked.

The GET is fired into a hidden iframe rather than by assigning `location`. A ticket that expires in the seconds between the two answers with JSON, and on the top level that JSON replaces the admin page.

**The password is asked for again.** Not authorization — the server already decided that, and the same session can reset anyone's password from the row above. It is the gap between an admin session existing and an admin being present. This one button is every board, every password hash and every live session in one file, and it is the only control on the page where an unattended laptop costs the same as a stolen cookie.

**The schedule stays read-only.** Interval and retention live in `lawha.env` with every other operator knob. Making them editable would need shared state between `lawha-server` and a container that reads its settings once at startup — a lot of machinery to move two numbers out of the file where an operator already expects to find them.

## The duplication this introduced

`scripts/backup.mjs` cannot be imported. It has no exports and no main guard; argv parsing, a top-level `await` and `process.exit()` all fire on load, and it must stay that way because it runs under plain `node` in an image where `tsx` does not exist. So `src/lib/backupVerify.ts` is a second implementation of the same `integrity_check`-plus-four-tables rule.

That is a real DRY violation and it is held together by `tests/integration/backupVerifyParity.test.ts`, which reads `backup.mjs` as text and fails if the constants drift. The failure it prevents is quiet: add a fifth table in a migration, update the script, forget the TypeScript copy, and the admin panel starts handing out "verified" snapshots missing a table the scheduled backups would have refused to ship. Both paths report success and the gap appears on restore day.

## One thing that was nearly shipped broken

The first implementation streamed two tars into the same response — one for the database, one for the blobs — because tar's `cwd` is fixed per call and the two sources live under different parents.

A tar ends with two 512-byte zero blocks, so a concatenated pair has an end-of-archive marker in the middle of it and every default reader stops there. Measured rather than assumed: `tar -tf` on the result listed the database and nothing else, while `tar -itf` on the same bytes listed all of it. An operator would have extracted that, seen a database, and found out about the missing images on the day the boards came back blank.

The fix is a scratch directory of symlinks to both sources with `follow: true`, so one `tar.create` call sees one parent. `adminBackup.test.ts` asserts it by extracting the response and looking for both halves, because nothing short of extracting the bytes would have caught it.

Which is the same lesson as roadmap §4: **assert on the artefact, not on a proxy for it.** A Content-Type check would have passed.

## Consequences

- `docker-compose.yml` gains a read-only `/backups` mount and `LAWHA_BACKUP_ARCHIVE_DIR` on `lawha-server`. Unset — `yarn dev` — means the card reports "not configured" and the archive endpoints 404, which is honest.
- `docker/nginx.conf` gains a `location /api/admin/backup/` with `proxy_buffering off`, **before** the general `/api/` block because nginx takes the longest matching prefix. Buffering on would write the whole archive to a temp file before the client saw a byte, and fail past `proxy_max_temp_file_size`.
- `lawha-server` gains a dependency on `tar`, and `lawha-server/yarn.lock` was regenerated standalone per the note at the top of `lawha-server/Dockerfile`.
- `AuditAction` gains `backup.downloaded`, recorded when the bytes start moving rather than when the password is accepted — a ticket issued and never redeemed is somebody who changed their mind.
- Snapshots are single-flight and refuse when free space is under 1.2× the database. A backup that fills the disk takes the live database with it, and they are on the same volume.
