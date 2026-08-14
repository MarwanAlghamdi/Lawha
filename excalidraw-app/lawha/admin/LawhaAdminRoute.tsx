import { useNavigate } from "react-router-dom";

import { useLawhaSession } from "../auth/useLawhaSession";
import { LawhaPageShell } from "../pages/LawhaPageShell";
import { useShareOrigins } from "../share/useShareOrigins";

// Imported, not edited: this page reuses the account panel's card, section and
// field primitives. Its own styles are beside it in LawhaAdmin.scss.
import "../account/LawhaAccount.scss";

import { LawhaAdminAccounts } from "./LawhaAdminAccounts";
import { LawhaAdminAudit } from "./LawhaAdminAudit";
import { LawhaAdminBackup } from "./LawhaAdminBackup";
import { LawhaServerConfigCard } from "./LawhaServerConfigCard";

import "./LawhaAdmin.scss";

/**
 * `/admin` as a standalone, unlisted page.
 *
 * Nothing links here. That is deliberate and it is the whole feature: the
 * recovery controls used to sit inline in the account panel, so every
 * administrator was shown a "set anyone's password" form every time they went
 * to change their own display name. Moving them to an address you have to know
 * makes reaching them an act rather than an accident.
 *
 * "Unlinked" is not "secret", and as of `docs/adr/0009` it is not even
 * unlisted: anyone who reaches this address without the role gets
 * `LawhaAdminGate`, which names the page and asks for one of the two
 * credentials that open it. `RequireAdmin` in `routes/SessionGate.tsx` decides
 * that, and `GET /api/admin/users` refuses non-administrators regardless of
 * what the client renders — the gate removes a foot-gun and grants no access
 * control the server was not already enforcing (invariant 21).
 *
 * **There is still no page-unlock flow, and neither this page nor the gate in
 * front of it pretends otherwise.** `LAWHA_MASTER_PASSWORD` remains a login
 * credential: it stands in for one account's password, it needs that account's
 * username beside it, and the session it mints carries `viaMaster` and is
 * written to the server log. Typing it alone into this address does nothing.
 * The decision recorded in roadmap §4.8 is unchanged; only who gets told what
 * has moved.
 */
export const LawhaAdminRoute = () => {
  const navigate = useNavigate();
  const { user, viaMaster, masterAdmin } = useLawhaSession();

  /**
   * Every address this deployment answers to, for the reset link.
   *
   * The second caller of a hook whose own comment says the share panel is the
   * only surface that asks — and the reason it is now two is that both
   * surfaces hand somebody else a URL, which is the same question about a
   * different path. It stays a per-surface read rather than a boot one: `/admin`
   * asks when `/admin` is opened, and a page nobody has visited makes no
   * request. `useShareOrigins` degrades to the boot config on any failure,
   * including the 401 a master-password session gets from the account-gated
   * `/auth/origins`, so nothing here throws when a deployment publishes
   * nothing — the reset panel simply keeps the single ambient link it always
   * had.
   */
  const origins = useShareOrigins();

  // No early return on `!user` any more, and that is the whole shape of the
  // change: a master-password session has no account behind it (migration 007)
  // and is still entitled to be here. `RequireAdmin` has already decided that;
  // this component only has to stop assuming there is somebody to name.

  return (
    <LawhaPageShell
      variant="page"
      caption="administration · unlinked"
      // `/home` rather than `/`: the dashboard by name. `/` is LandingRoute,
      // which now sends a signed-out visitor to /signin, and "Back" from the
      // administration page means "back to my boards" every time.
      back={{ label: "Back to boards", onClick: () => navigate("/home") }}
    >
      <div className="lw-admin-page">
        {masterAdmin ? (
          <p className="lw-card lw-master-banner" role="status">
            <strong>Opened with the master password.</strong> This session is
            not an account: it reaches this page and nothing else, no board is
            readable from it, and it ends on its own after twelve hours. Every
            change made here is recorded in the log without a name attached, so
            note down anything worth remembering.
          </p>
        ) : viaMaster && user ? (
          <p className="lw-card lw-master-banner" role="status">
            <strong>Signed in with the master password.</strong> You are acting
            as {user.username}, and that is what gets you in here rather than
            the account's own role. Every use of it is recorded in the log.
          </p>
        ) : null}

        {/*
         * Accounts first, config second, log last. The old page led with the
         * server's configuration, which is the thing an administrator reads
         * once and the accounts are what they came for — see ADR 0015.
         */}
        <LawhaAdminAccounts
          currentUserId={user?.id ?? null}
          origins={origins}
        />

        <LawhaServerConfigCard />

        {/*
         * Backups between the configuration and the log, because that is the
         * order of the questions: what is this server, is it safe, what has
         * been done to it. Below the fold on purpose — this is the one card
         * whose button hands over the whole database, and it should take a
         * deliberate scroll to reach rather than sitting under the cursor of
         * somebody who came to reset a password.
         */}
        <LawhaAdminBackup />

        <LawhaAdminAudit />
      </div>
    </LawhaPageShell>
  );
};
