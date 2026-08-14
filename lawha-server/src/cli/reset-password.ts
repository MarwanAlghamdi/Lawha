/**
 * Password recovery for a server with no email.
 *
 *   yarn --cwd lawha-server reset-password <username> <new-password>
 *
 * This is the whole recovery story by design. Do not add SMTP.
 */
import { loadConfig } from "../config.js";
import { createContext } from "../context.js";
import { hashPassword } from "../lib/password.js";
import { passwordSchema } from "../lib/validation.js";

const [username, newPassword] = process.argv.slice(2);

if (!username || !newPassword) {
  process.stderr.write(
    "usage: yarn --cwd lawha-server reset-password <username> <new-password>\n",
  );
  process.exit(1);
}

const config = loadConfig();
const ctx = createContext(config);

const user = ctx.users.findByUsername(username);

if (!user) {
  process.stderr.write(`lawha: no such user "${username}"\n`);
  ctx.db.close();
  process.exit(1);
}

const validation = passwordSchema.safeParse(newPassword);

if (!validation.success) {
  process.stderr.write(`lawha: ${validation.error.errors[0]?.message}\n`);
  ctx.db.close();
  process.exit(1);
}

// No escrow to carry across. This used to re-wrap the account's master key
// before touching the password, and to refuse outright for an account the
// server had no copy for — so the one CLI meant to rescue somebody could not
// help exactly the accounts most likely to need it. Nothing is derived from a
// password any more (ADR 0012), so a reset is a password write.
ctx.users.updatePassword(user.id, await hashPassword(newPassword));
const revoked = ctx.sessions.revokeAllForUser(user.id);

process.stdout.write(
  `lawha: password reset for "${user.username_display}"; revoked ${revoked} session(s)\n`,
);

ctx.db.close();
