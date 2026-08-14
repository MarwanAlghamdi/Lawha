import { useNavigate } from "react-router-dom";

import { LawhaPageShell } from "../pages/LawhaPageShell";

import { LawhaAccountPanel } from "./LawhaAccountPanel";

/**
 * `/account` as a standalone page.
 *
 * The same panel also opens as a dialog over the canvas, which is where it is
 * normally reached from. This route exists for the cases where there is no
 * canvas to overlay: a bookmarked link, and the Phase 3 dashboard.
 */
export const LawhaAccountRoute = () => {
  const navigate = useNavigate();

  return (
    <LawhaPageShell
      variant="page"
      caption="account"
      back={{ label: "Back to canvas", onClick: () => navigate("/") }}
    >
      {/* Signing out or deleting leaves this route unreachable, so leave it. */}
      <LawhaAccountPanel onSignedOut={() => navigate("/", { replace: true })} />
    </LawhaPageShell>
  );
};
