import {
  Navigate,
  createBrowserRouter,
  Outlet,
  RouterProvider,
} from "react-router-dom";

import { ExcalidrawPlusIframeExport } from "../ExcalidrawPlusIframeExport";
import { LawhaAccountRoute } from "../lawha/account/LawhaAccountRoute";
import { LawhaAdminRoute } from "../lawha/admin/LawhaAdminRoute";
import { HomeRoute } from "../lawha/home/HomeRoute";
import { JoinRoute } from "../lawha/join/JoinRoute";
import { ResetRoute } from "../lawha/reset/ResetRoute";
import { SignInRoute } from "../lawha/auth/SignInRoute";
import { SignUpRoute } from "../lawha/auth/SignUpRoute";

import { BoardRoute } from "./BoardRoute";
import { LandingRoute } from "./LandingRoute";
import { LawhaProviders } from "./LawhaProviders";
import {
  RedirectIfSignedIn,
  RequireAdmin,
  RequireSession,
} from "./SessionGate";

const RootLayout = () => (
  <LawhaProviders>
    <Outlet />
  </LawhaProviders>
);

/**
 * Lawha's route table.
 *
 * `/` is the dashboard for anyone signed in, and the canvas for anyone who is
 * not — see `LandingRoute`. `/home` is kept as an explicit alias so the links
 * that point at it, and anyone who bookmarked it, still land somewhere.
 *
 * Note what is *not* routed: the share popover, the account dialog, and the AI
 * menu are canvas state, not locations. Consolidation means those surfaces live
 * inside the editor; giving them URLs would pull them back out of it.
 */
const router = createBrowserRouter([
  {
    // Outside the providers, exactly as it was before routing existed: this is
    // a bare postMessage bridge rendered into an iframe, not part of the app.
    path: "/excalidraw-plus-export",
    element: <ExcalidrawPlusIframeExport />,
  },
  {
    element: <RootLayout />,
    children: [
      { path: "/", element: <LandingRoute /> },
      {
        path: "/home",
        element: (
          <RequireSession>
            <HomeRoute />
          </RequireSession>
        ),
      },
      { path: "/b/:boardId", element: <BoardRoute /> },
      /**
       * Spending an invite code (ADR 0014). Two paths, one page: `/join/:code`
       * for somebody who followed a copied link, `/join` for somebody who was
       * told three words and is typing them.
       *
       * Behind `RequireSession` deliberately. A code grants *membership*, and
       * membership needs an account to belong to — that is the whole
       * difference between a code and a link, so signing in first is the
       * feature rather than a hurdle in front of it.
       */
      {
        path: "/join",
        element: (
          <RequireSession>
            <JoinRoute />
          </RequireSession>
        ),
      },
      {
        path: "/join/:code",
        element: (
          <RequireSession>
            <JoinRoute />
          </RequireSession>
        ),
      },
      /**
       * Spending a password reset code (design spec §5).
       *
       * **No gate at all, and that is the point of the route.** Not
       * `RequireSession`: whoever is here cannot sign in — either they have
       * forgotten the password or an administrator locked the account — so a
       * gate would send them to the one screen they cannot get past, and the
       * only way back into the account would be gone. Not `RedirectIfSignedIn`
       * either, which is the less obvious half: an "I forgot it" reset does
       * not lock anything, so the person may well still be signed in on this
       * browser, and bouncing them to `/` would make the code they were just
       * handed unusable with nothing on screen to say why.
       *
       * One path, unlike `/join`. There is no `/reset` without a code, because
       * a code is 43 base64url characters read off a screen and nobody is
       * going to type one.
       *
       * The server refuses independently and knows nothing about this route
       * (invariant 21): `POST /api/auth/reset/:code` is unauthenticated by
       * construction, and the code in the path is the entire credential.
       */
      { path: "/reset/:code", element: <ResetRoute /> },
      {
        path: "/signin",
        element: (
          <RedirectIfSignedIn>
            <SignInRoute />
          </RedirectIfSignedIn>
        ),
      },
      {
        path: "/signup",
        element: (
          <RedirectIfSignedIn>
            <SignUpRoute />
          </RedirectIfSignedIn>
        ),
      },
      {
        path: "/account",
        element: (
          <RequireSession>
            <LawhaAccountRoute />
          </RequireSession>
        ),
      },
      {
        /**
         * Unlinked, not hidden. No nav item and no button anywhere in the app
         * points here, so reaching it stays an act rather than an accident —
         * but anyone who types the address gets a page that says what it is
         * and offers the two ways in, an administrator's account or the master
         * password. `RequireAdmin` renders `LawhaAdminGate` for everybody else.
         *
         * This route used to redirect a signed-in non-administrator to `/`, so
         * that guessing the address was indistinguishable from mistyping one.
         * `docs/adr/0009` records why that was given up: the same silence is
         * indistinguishable from a bug, and it was reported as one. What is
         * lost is obscurity, which was never the control — `requireAdmin` in
         * `lawha-server/src/http/routes/admin.ts` refuses every route behind
         * this regardless of what the client chooses to render (invariant 21).
         *
         * Still absent from `robots.txt`, and still for the original reason: a
         * Disallow line is a directory of the things you did not want found.
         */
        path: "/admin",
        element: (
          <RequireAdmin>
            <LawhaAdminRoute />
          </RequireAdmin>
        ),
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

export const LawhaRouter = () => <RouterProvider router={router} />;
