import { Navigate, useLocation } from "react-router-dom";

import { canReachAdmin, LawhaAdminGate } from "../lawha/admin/LawhaAdminGate";
import { useLawhaSession } from "../lawha/auth/useLawhaSession";

import type { ReactNode } from "react";

/**
 * Held while the first /auth/me is in flight.
 *
 * Deliberately blank rather than a spinner: the round trip is same-origin and
 * usually sub-frame, and a spinner that flashes for 20ms reads as a glitch.
 * What this does prevent is rendering a signed-out page to a signed-in user for
 * one frame and then yanking it away.
 */
const Pending = () => <div className="lw-route-pending" aria-busy="true" />;

/** Guards a route that has no meaning without an account. */
export const RequireSession = ({ children }: { children: ReactNode }) => {
  const { status } = useLawhaSession();
  const location = useLocation();

  if (status === "loading") {
    return <Pending />;
  }

  if (status === "anonymous") {
    // `from` lets the sign-in screen return the user where they were headed,
    // rather than dumping everyone on the canvas.
    return (
      <Navigate to="/signin" replace state={{ from: location.pathname }} />
    );
  }

  return <>{children}</>;
};

/**
 * Guards `/admin`.
 *
 * Two branches now, and it used to be three. The one that went was
 * `<Navigate to="/" replace />` for a visitor who was signed in but not an
 * administrator — a silent bounce, chosen so that guessing this address was
 * indistinguishable from mistyping one. That property was real and it has been
 * deliberately spent; `docs/adr/0009` records the trade. A redirect with no
 * explanation is also indistinguishable from a *bug*, and it was reported as
 * one ("when i go to /admin it takes me to main dashboard page").
 *
 * So: anyone may reach `/admin`, and anyone who cannot see it is *told*, by
 * `LawhaAdminGate`, and offered the two credentials that would get them in —
 * an administrator's account, or the master password. Nothing about the page
 * is hidden any more, and nothing about it was ever protected by hiding.
 *
 * - loading — the same blank `Pending` as everywhere else. Skipping it would
 *   evaluate the predicate against a session that has not arrived yet and put
 *   a real administrator in front of a sign-in form they do not need.
 * - not through — the gate, rendered *here*, at this address, with no
 *   navigation. The session atom is shared, so a successful sign-in re-renders
 *   this guard and the branch below is the honest answer to it; navigating
 *   from inside the card would race that.
 *
 * The predicate is `canReachAdmin`, declared beside the gate and used by both
 * — see the note there for why it is not written out twice. It mirrors
 * `requireAdmin` in `lawha-server/src/http/routes/admin.ts`, which is where
 * this is actually enforced (invariant 21); everything here is a courtesy that
 * decides what to render, never what is allowed.
 *
 * The master password is the exception to "a session is an account". It opens
 * an administration session with nobody behind it — its own cookie, its own
 * table, twelve hours, no board reachable from it — so `user` stays null while
 * `masterAdmin` is true. `canReachAdmin` checks that first for the same reason
 * the server does: every account-shaped test would otherwise answer "no" to a
 * caller who is entitled to be here.
 */
export const RequireAdmin = ({ children }: { children: ReactNode }) => {
  const { status, user, viaMaster, masterAdmin } = useLawhaSession();

  if (status === "loading") {
    return <Pending />;
  }

  if (!canReachAdmin(user, viaMaster, masterAdmin)) {
    return <LawhaAdminGate />;
  }

  return <>{children}</>;
};

/** Guards the sign-in and sign-up screens, which are pointless once signed in. */
export const RedirectIfSignedIn = ({ children }: { children: ReactNode }) => {
  const { status } = useLawhaSession();

  if (status === "loading") {
    return <Pending />;
  }

  if (status === "authenticated") {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};
