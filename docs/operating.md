# Operating Lawha

Day-to-day administration: accounts, invites, sharing, and what to do when somebody forgets their password.

## Access the admin panel

Navigate to `/admin` — it is **unlinked**, so nothing in the UI points to it. The URL is typed by hand. It is kept unlinked so account controls do not appear in front of every administrator who came to change their display name; the security boundary is the API, which refuses a non-administrator regardless of what the client renders.

To reach it, an account must have the administrator role. If you do not:

- **Master password** (if set) — sign in with that alone, no username needed. Every session opened this way is flagged `via_master` and logged.
- **Create an account** at `/signup` (if open registration is enabled), then have another administrator promote you from `/admin`.

---

## Accounts

### Create an account

**Option 1: Registration** — open registration is on by default. Share the sign-up URL (`/signup`) with people and they create their own accounts. To close it: `LAWHA_ALLOW_OPEN_REGISTRATION=false` in `lawha.env`, then force-recreate the server.

**Option 2: `/admin`** — any administrator can create an account. Navigate to **Accounts** → **Create**, choose a username, and the system generates a 24-character password. Read it out and hand it over.

### Make someone an administrator

**Option 1: `/admin`** — open **Accounts**, find the person, press the role button to toggle the administrator role. The change takes effect immediately; they do not have to sign in again.

**Option 2: `LAWHA_ADMIN_USERNAME`** — set this in `lawha.env` to a username (yours, ideally). That account is promoted to administrator on every boot, which is your insurance against accidentally demoting yourself — set it, restart, and the role is back.

**There is no "last administrator" race condition.** The server refuses to remove the last administrator, so you cannot lock yourself out.

### Sign in when locked out

If every account with the administrator role is locked (password changed, sessions revoked, account disabled):

- **Master password** — `/admin` → **Master password** segment. No username needed; the server creates a session for its designated administrator account. Every session opened this way is flagged `via_master` and printed to the server log.

---

## Sharing and invites

### Invite codes

Three words, like `brave-otter-lantern`. They grant someone membership on a board as a viewer or an editor.

- **Invite someone** — open the board → **Share** → **Add people** → type a name or search, choose **Viewer** or **Editor**, press **Invite**.
- **Set an expiry** — before creating the code, set **Expires in** to minutes, hours, or days. Empty means it never expires.
- **Limit use** — set **Use limit** to a number, or leave it empty for unlimited.
- **Revoke an invite** — press the button next to the code.
- **Every redemption is recorded** — the audit log shows which code was used, by whom, and when.

### Share links

For people who should see a board without joining it. Link visitors are a narrower principal than members: they get a server-minted pass scoped to that single board, and it is a key to nothing else on the server.

- **Create a link** — open the board → **Share** → **Link access** → choose one of four, press **Create link**:

  | Option | Who can draw |
  | --- | --- |
  | **Off** | The link is dead. |
  | **Can view** | Nobody. Everyone with the link watches. |
  | **Can edit** | Anyone with the link **who is signed in**. Visitors without an account still only watch. |
  | **Can edit, including visitors** | Anyone with the link, account or not. |

  The fourth option is off by default and is chosen per board — existing boards keep whatever they were set to (ADR 0024). In every case a link visitor can edit _that board_ and nothing else: not your other boards, not permissions, not the admin panel. If someone should be a durable, named collaborator, give them an invite code instead — it makes them a member with a real role.

- **Copy the link** — the Share panel shows the link in every address this deployment publishes (LAN addresses and the ngrok URL if it is running).
- **Revoke a link** — press the button.

---

## Reset a password

There is **no email in Lawha**. There is no SMTP, no address column, and no password-reset link in the mail. The recovery path is the administrator and the master password. When someone is locked out, you hand them a link to set their own password.

### Make a reset code

1. Navigate to `/admin` → **Accounts** → find the person
2. **Make a reset code** — "I forgot it." Their password and every device they are signed in on keep working right up until they use the link. Nothing is revoked.
   - OR **Lock and reset** — "it leaked" or they left. Their password stops working **now**, every session is revoked, and any board they have open is disconnected.
3. Both ask for confirmation, then show one panel with the link.

### What the person does

They open the link and choose their own password. Every other session of theirs ends at that moment, which stops a password handed over on a call from being quietly used by whoever was already signed in on some other machine.

### Four things to know

- **It is shown once.** The code is stored hashed, so nothing can show it again — not `/admin`, not the audit log, not the database. Lose it and you mint another.
- **It expires in one hour and works once.** The panel prints the clock time it dies at.
- **Minting a second code kills the first.** At most one code per account is live. If you paste a link into the wrong chat, the recall procedure is simply to press the button again — the new code invalidates the one you leaked before it can be redeemed.
- **A turned-off account refuses its own codes** — turn it back on first. The buttons say so when they are disabled.

Both ends are written to `/admin` → **Audit**: `password.reset.issued` names you (the admin who minted it), and `password.reset.redeemed` names them (the account holder). If the redeemer carried an admin session, the audit row says so — which is the one thing that distinguishes an administrator redeeming a code they intercepted from the account holder redeeming their own.

### By command line

When the UI is unreachable:

```bash
docker compose exec lawha-server node dist/cli/reset-password.js <username> <new-password>
```

This revokes every session for the user.

---

## Everyday administration

| Task | How |
| --- | --- |
| See what happened | `/admin` → **Audit** |
| Disable an account | `/admin` → **Accounts** → toggle the enabled switch. Disabled accounts cannot sign in; all their sessions are revoked. |
| Disable all sessions for one account | `/admin` → **Accounts** → the account → **Sign out everywhere** |
| See all open sessions on the server | `/admin` → **Sessions** — shows username, device, and when the session was issued and last active |
| Delete a session | `/admin` → **Sessions** → the session → delete button |
| Back up now and download | `/admin` → **Backups** → **Back up now and download**. Re-enter your password when it asks. What comes back is a single `.tar` holding the verified database and the uploaded images. |
| Restore a backup | See [Backups](backups.md#restore) |
| Close registration | `LAWHA_ALLOW_OPEN_REGISTRATION=false` in `lawha.env`, then recreate the server. Nobody new can sign up; accounts are admin-only after this. |

---

## The audit log

Every administrative action is written to a table that has no delete. The log lives at `/admin` → **Audit** and includes:

- Accounts created, roles changed, passwords reset
- Invites issued and redeemed, share links created
- Backups taken, downloads served
- Master password use
- Any administrative action you take is signed with your username

The rows exist so you can answer the question: "Who had access to what, when?"
