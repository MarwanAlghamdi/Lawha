import { WelcomeScreen } from "@excalidraw/excalidraw/index";
import React from "react";

import { LawhaLogo } from "../lawha/chrome/LawhaLogo";

export const AppWelcomeScreen: React.FC = React.memo(() => {
  return (
    <WelcomeScreen>
      <WelcomeScreen.Hints.MenuHint>
        Export, preferences, language
      </WelcomeScreen.Hints.MenuHint>
      <WelcomeScreen.Hints.ToolbarHint />
      {/*
        No HelpHint: it points at the help button in the bottom-right corner,
        which the consolidated UI removes. Shortcuts remain on `?` and in the
        main menu.
      */}
      <WelcomeScreen.Center>
        <WelcomeScreen.Center.Logo>
          <LawhaLogo />
        </WelcomeScreen.Center.Logo>
        <WelcomeScreen.Center.Heading>
          A board is yours alone until you share it.
          <br />
          Share one and it turns live — cursors, names, edits.
        </WelcomeScreen.Center.Heading>
        <WelcomeScreen.Center.Menu>
          <WelcomeScreen.Center.MenuItemLoadScene />
          <WelcomeScreen.Center.MenuItemHelp />
          {/*
            No "Live collaboration" item, for the reason AppMainMenu.tsx sets
            out at length: it was a second way to start a session that handed
            out a link with no owner check, and whose "Stop session" left
            sharing switched on. Share lives in the top bar.

            The Excalidraw+ sign-up link is deliberately absent too: Lawha is
            self-hosted, and there is no upsell to point at.
          */}
        </WelcomeScreen.Center.Menu>
      </WelcomeScreen.Center>
    </WelcomeScreen>
  );
});
