import { useEffect, useMemo, useState } from "react";

import {
  LawhaApiError,
  adminDeleteAccount,
  adminIssueResetCode,
  adminRestoreAccount,
  adminRevokeSessions,
  adminSetDisabled,
  adminSetRole,
  fetchAllUsers,
} from "../auth/authApi";

import { LawhaAdminAccountRow } from "./LawhaAdminAccountRow";
import { LawhaAdminCreate } from "./LawhaAdminCreate";
import { LawhaAdminResetCode } from "./LawhaAdminResetCode";
import { LawhaAdminSecret } from "./LawhaAdminSecret";

import type { RowAction } from "./LawhaAdminAccountRow";
import type { LawhaUser } from "../auth/authApi";
import type { ShareOrigins } from "../share/shareOrigins";

const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * The accounts on this server, and what can be done to them. See ADR 0015.
 *
 * This replaces `account/LawhaAdminCard.tsx`, which had grown to 478 lines of
 * list, form, reveal panel and confirmation in one component — over the 400
 * this codebase treats as the point to split — and which lived in the account
 * directory because that is where the controls were first written, years of
 * commits after they stopped belonging there.
 *
 * There is no email and no self-service reset on this server, so this page is
 * the whole recovery story. What it now covers that it did not:
 *
 *   * **signing somebody out without resetting them** — those used to be the
 *     same button, so a lost laptop cost the owner their password;
 *   * **turning an account off** — reversible, destroys nothing, and the
 *     honest answer to "they have left" where the alternatives were resetting
 *     their password and hoping, or deleting the account and its boards;
 *   * **creating an account**, which is the only way to onboard anyone on a
 *     server with open registration off.
 */
export const LawhaAdminAccounts = ({
  currentUserId,
  origins,
}: {
  /**
   * Whose row to mark "you", or null for a master-password administration
   * session — which is not an account, so none of these rows is you.
   */
  currentUserId: string | null;
  /**
   * Every address this deployment answers to, passed straight through to the
   * reset-code panel.
   *
   * Drilled rather than fetched here for the reason `LawhaAdminResetCode`
   * states: the panel exists only once a credential does, and rows arriving
   * after it would grow the list under the hand of somebody already copying.
   * `LawhaAdminRoute` owns the read, which also keeps `/admin`'s one request
   * for this in the place a reader looks for the page's requests.
   */
  origins: ShareOrigins;
}) => {
  const [users, setUsers] = useState<LawhaUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * A credential the server has just minted, held for exactly as long as it is
   * on screen.
   *
   * Component state and nothing else: never written to storage, never put in a
   * URL, never sent anywhere. The server's response is the only place it has
   * ever existed and closing this is the end of it, because a secret that can
   * be shown twice will be, from somewhere nobody audited.
   */
  const [secret, setSecret] = useState<{
    who: string;
    password: string;
  } | null>(null);

  /**
   * A reset code the server has just minted, held under the same contract as
   * `secret` above and for a sharper reason.
   *
   * Not folded into `secret`: that one is a password the recipient can be told
   * whenever somebody gets round to it, and this one is a link with an hour to
   * live that may be the only way back into a locked account. They also carry
   * different facts — whether the account was locked, how many sessions ended,
   * when it expires — and a union type whose branches have nothing in common is
   * two states wearing one name.
   *
   * Exactly one of the two is on screen at a time. Whichever is minted last
   * replaces the other, because two credential panels stacked above the list is
   * a screen where the administrator copies the wrong one.
   */
  const [resetCode, setResetCode] = useState<{
    who: string;
    code: string;
    expiresAt: number;
    locked: boolean;
    revokedSessions: number;
  } | null>(null);

  /**
   * Narrows the list by name.
   *
   * Not premature: the deployment this was built against has 48 accounts,
   * most of them throwaways from test runs, and every one rendered as a full
   * row with four buttons. Finding the person who phoned meant scrolling past
   * thirty `pw-visual-…` rows — and the row you act on being the row you
   * meant is the whole point of putting the actions inside it.
   */
  const [filter, setFilter] = useState("");

  const reload = () =>
    fetchAllUsers()
      .then((loaded) => {
        setUsers(loaded);
        setLoadError(null);
      })
      .catch((caught: unknown) => {
        setLoadError(
          caught instanceof LawhaApiError && caught.status === 403
            ? "This account is not an administrator."
            : messageOf(caught, "Could not load the account list."),
        );
      });

  useEffect(() => {
    void reload();
    // Loaded once on mount; every mutation below applies its own result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Whether exactly one administrator could still sign in.
   *
   * Counts the role *and* an active account, matching `countActiveAdmins` on
   * the server. A disabled administrator is not an administrator, and a client
   * that counted only the role would offer to demote the last usable one and
   * then show the refusal.
   */
  // Mirrors `countActiveAdmins` on the server, including its deleted clause:
  // the two decide the same thing and a client that counted differently would
  // offer a control the server refuses, or hide one it would have allowed.
  const isLastAdmin = useMemo(
    () =>
      (users ?? []).filter(
        (user) =>
          user.isAdmin && user.disabledAt === null && user.deletedAt === null,
      ).length <= 1,
    [users],
  );

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (users ?? []).filter((user) =>
      needle === "" ? true : user.username.toLowerCase().includes(needle),
    );
  }, [users, filter]);

  const replace = (updated: LawhaUser) =>
    setUsers(
      (current) =>
        current?.map((row) => (row.id === updated.id ? updated : row)) ?? null,
    );

  const onAction = async (
    action: RowAction,
    user: LawhaUser,
    confirmed?: string,
  ) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      switch (action) {
        /*
         * Both halves of "Reset password". One request, one flag, and the flag
         * is the entire difference between "I forgot it" and "it leaked" —
         * see `adminIssueResetCode`.
         */
        case "resetCode":
        case "lockAndReset": {
          const locked = action === "lockAndReset";
          const issued = await adminIssueResetCode(user.id, locked);
          setSecret(null);
          setResetCode({ who: user.username, locked, ...issued });
          break;
        }
        case "signOut": {
          const revoked = await adminRevokeSessions(user.id);
          setNotice(
            `${user.username} was signed out of ${revoked} device${
              revoked === 1 ? "" : "s"
            }. Their password still works.`,
          );
          break;
        }
        case "disable":
        case "enable": {
          const updated = await adminSetDisabled(user.id, action === "disable");
          replace(updated);
          setNotice(
            action === "disable"
              ? `${user.username} is turned off and signed out everywhere.`
              : `${user.username} can sign in again.`,
          );
          break;
        }
        case "delete": {
          // What the administrator actually typed, carried up from the row.
          // NOT `user.username`: reading the name off the same object as the
          // id would make them incapable of disagreeing, so the server's check
          // would accept every request this panel can generate and the guard
          // would exist only on the client — which is where guards do not
          // count (invariant 21).
          const updated = await adminDeleteAccount(user.id, confirmed ?? "");
          replace(updated);
          setNotice(
            `${user.username} is deleted, with every board they owned. You can restore them from here until the retention window closes.`,
          );
          break;
        }
        case "restore": {
          const updated = await adminRestoreAccount(user.id);
          replace(updated);
          setNotice(
            updated.disabledAt === null
              ? `${updated.username} is back, boards and all.`
              : // Restoring undoes the deletion and nothing else. Saying so
                // here is the difference between an administrator knowing the
                // account is still locked out and finding out from the person
                // who tried to sign in.
                `${updated.username} is back, boards and all — still turned off, which the restore did not change.`,
          );
          break;
        }
        case "role": {
          const updated = await adminSetRole(user.id, !user.isAdmin);
          replace(updated);
          setNotice(
            updated.isAdmin
              ? `${updated.username} is now an administrator.`
              : `${updated.username} is no longer an administrator.`,
          );
          break;
        }
      }
    } catch (caught) {
      const said = messageOf(caught, "That did not work.");
      /*
       * The one refusal that leaves the account in a different state from the
       * one the administrator is looking at. `admin.ts` invalidates the
       * password and revokes the sessions BEFORE it mints the code — on
       * purpose, so there is never a moment when the old credential and the new
       * code are both live — which means a failure after that point is somebody
       * locked out with no way back and an administrator who was told only that
       * something went wrong. Say what may have happened and what fixes it.
       */
      setError(
        action === "lockAndReset"
          ? `${said} ${user.username} may already be locked out — the account is locked before the code is made. Press Lock and reset again to get one.`
          : said,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lw-card lw-admin">
      <div className="lw-section">
        <span className="lw-section__title">Accounts</span>
        <span className="lw-section__caption">
          There is no email recovery on this server, so this is how a forgotten
          password gets fixed — and how somebody who has left stops being able
          to sign in.
        </span>
      </div>

      {loadError ? (
        <p className="lw-inline-error" role="alert">
          {loadError}
        </p>
      ) : null}

      {users === null && !loadError ? (
        <span className="lw-field__hint">Loading accounts…</span>
      ) : null}

      {/*
        Pinned above the list rather than beside the control that spoke. The
        page scrolls once there are more than a few accounts, and a message
        parked next to a row that has scrolled away is a message nobody reads.
      */}
      {error ? (
        <p className="lw-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="lw-inline-ok" role="status">
          {notice}
        </p>
      ) : null}

      {secret ? (
        <LawhaAdminSecret
          who={secret.who}
          password={secret.password}
          onDone={() => setSecret(null)}
        />
      ) : null}

      {resetCode ? (
        <LawhaAdminResetCode
          who={resetCode.who}
          code={resetCode.code}
          expiresAt={resetCode.expiresAt}
          locked={resetCode.locked}
          revokedSessions={resetCode.revokedSessions}
          origins={origins}
          // Pressing Done is the end of the code, which is why it is the only
          // thing that clears this. No other action on the page does — a panel
          // that vanished because somebody signed a different account out
          // would take a live credential with it.
          onDone={() => setResetCode(null)}
        />
      ) : null}

      {users !== null && users.length > 8 ? (
        <label className="lw-field lw-admin__filter">
          <span className="lw-field__label">Find an account</span>
          <input
            className="lw-field__input"
            value={filter}
            placeholder="Type a name"
            autoComplete="off"
            onChange={(event) => setFilter(event.target.value)}
          />
          {/*
            The count is shown while filtering, not always. "48 accounts" is
            not information anybody came here for; "3 of 48" tells you whether
            the person you are looking for is missing or merely not matched.
          */}
          {filter.trim() ? (
            <span className="lw-field__hint">
              {shown.length} of {users.length}
            </span>
          ) : null}
        </label>
      ) : null}

      {users !== null && shown.length === 0 && users.length > 0 ? (
        <span className="lw-field__hint">No account matches “{filter}”.</span>
      ) : null}

      {users !== null ? (
        <ul className="lw-admin__accounts">
          {shown.map((user) => (
            <LawhaAdminAccountRow
              key={user.id}
              user={user}
              isYou={user.id === currentUserId}
              busy={busy}
              isLastAdmin={isLastAdmin}
              onAction={(action, target) => void onAction(action, target)}
            />
          ))}
        </ul>
      ) : null}

      <LawhaAdminCreate
        busy={busy}
        onCreated={(user, password) => {
          setUsers((current) => [...(current ?? []), user]);
          setNotice(null);
          setError(null);
          if (password) {
            setResetCode(null);
            setSecret({ who: user.username, password });
          } else {
            setNotice(
              `${user.username} can sign in with the password you set.`,
            );
          }
        }}
        onError={setError}
      />
    </div>
  );
};
