import { Navigate } from "react-router-dom";

import { ExcalidrawWrapper } from "../App";
import { useLawhaSession } from "../lawha/auth/useLawhaSession";
import { HomeRoute } from "../lawha/home/HomeRoute";

/**
 * Links that carry their scene in the fragment.
 *
 * These are entry points into the editor rather than places in the app, so they
 * have to reach the canvas whoever follows them. `#room=` is Excalidraw's
 * legacy collaboration link, still honoured; `#json=` and `#url=` are imports.
 */
const HASH_ENTRY_POINT = /^#(room|json|url)=/;

/**
 * What `/` is.
 *
 * The dashboard for anyone with an account, and the sign-in screen for anyone
 * without one.
 *
 * The signed-out half used to be the canvas — the reasoning being that a
 * working canvas with a "Sign in" button on it serves a visitor better than a
 * redirect. It did not survive contact with the product. A scratch canvas
 * handed to everyone who lands on the address is where "Untitled-2026-08-03"
 * comes from: work gets started somewhere it cannot be saved, by someone with
 * nowhere to save it to, and either it is lost or it is persisted under an
 * account-less session that the dashboard will never show anybody.
 *
 * `LAWHA_REQUIRE_AUTH=false` deployments keep working, because on those there
 * *is* a session — the server issues the shared anonymous identity rather than
 * a 401, so `status` is `authenticated` and this never reaches the redirect.
 *
 * Two things deliberately still open without an account, and neither comes
 * through here: `#room=`/`#json=`/`#url=` links, which carry their scene in the
 * fragment and are entry points rather than places; and `/b/<id>`, where the
 * board's own `link_access` decides. Sending a share link to somebody and then
 * demanding they register is not sharing.
 */
export const LandingRoute = () => {
  const { status } = useLawhaSession();

  // Read once, at mount. The editor watches for later hash changes itself.
  if (HASH_ENTRY_POINT.test(window.location.hash)) {
    return <ExcalidrawWrapper />;
  }

  // Blank rather than a spinner while /auth/me is in flight: same-origin and
  // usually sub-frame, and flashing one screen before swapping in the other is
  // worse than a beat of nothing.
  if (status === "loading") {
    return <div className="lw-route-pending" aria-busy="true" />;
  }

  // `replace`, so the back button does not bounce between here and /signin.
  // No `from`: this *is* where they were going, and the sign-in screen's own
  // default destination is "/".
  return status === "authenticated" ? (
    <HomeRoute />
  ) : (
    <Navigate to="/signin" replace />
  );
};
