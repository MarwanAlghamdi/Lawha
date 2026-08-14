-- Drops email again, and adds the admin role that replaces it.
--
-- 002 added an email column so that people could reset their own passwords.
-- That was reversed a few hours later: this deployment is a private network
-- with an administrator on the other end of a phone, so the recovery path is
-- "call the admin", not "check your inbox". An address nobody sends to is a
-- field to mistype and a record to keep safe for no benefit.
--
-- Written as a third migration rather than by editing 002, which has already
-- run against live databases. An applied migration is history; rewriting it
-- would leave anyone who ran the old one with the columns still in place and
-- the ones below missing.

DROP INDEX IF EXISTS idx_users_email_lower;

ALTER TABLE users DROP COLUMN email;
ALTER TABLE users DROP COLUMN email_lower;

-- Password recovery is now a person. Admins can set anyone's password and
-- promote others; the master password below can act as any user without one.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- Records that a session was opened with the master password rather than the
-- account's own. The UI shows it, so acting as someone else is never silent,
-- and it is the one thing that makes the feature auditable after the fact.
ALTER TABLE sessions ADD COLUMN via_master INTEGER NOT NULL DEFAULT 0;

-- Reset tokens went with the email flow. Kept as a table rather than dropped:
-- see 004 if this ever needs to come back.
DROP TABLE IF EXISTS password_resets;
