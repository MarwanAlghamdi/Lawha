import { useExcalidrawSetAppState } from "@excalidraw/excalidraw/components/App";
import { eyeIcon, LibraryIcon } from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { MainMenu } from "@excalidraw/excalidraw/index";
import React from "react";

import {
  DEFAULT_SIDEBAR,
  isDevEnv,
  LIBRARY_SIDEBAR_TAB,
} from "@excalidraw/common";

import type { Theme } from "@excalidraw/element/types";

import { LanguageList } from "../app-language/LanguageList";

import { saveDebugState } from "./DebugCanvas";

/**
 * The way into the shape library, now that the corner button is gone.
 *
 * Upstream advertises the sidebar with a trigger floating in the canvas's
 * top-right, next to a second button of its own. Lawha's canvas already has a
 * top bar carrying the board, presence, Share and the account, so that pair sat
 * apart from everything else it belonged with — a leftover from a different
 * layout, in the corner most likely to be under someone's cursor.
 *
 * The button is hidden in `lawha-editor.scss` and the sidebar is reached from
 * here instead. Written as a state change rather than a portal because the
 * trigger must not move: `DropdownMenuContent` decides outside-clicks by
 * containment, so relocating it would make a press on it read as a click
 * outside and break click-to-close.
 */
const LibraryMenuItem = () => {
  const setAppState = useExcalidrawSetAppState();
  const { openSidebar } = useUIAppState();

  const isOpen =
    openSidebar?.name === DEFAULT_SIDEBAR.name &&
    openSidebar?.tab === LIBRARY_SIDEBAR_TAB;

  return (
    <MainMenu.Item
      icon={LibraryIcon}
      data-testid="main-menu-library"
      // Toggles, so a second visit to the menu closes what the first opened.
      // The sidebar covers a column of canvas; an item that can only ever open
      // it leaves the only way back a button inside the thing you wanted gone.
      onSelect={() =>
        setAppState({
          openSidebar: isOpen
            ? null
            : { name: DEFAULT_SIDEBAR.name, tab: LIBRARY_SIDEBAR_TAB },
        })
      }
    >
      Shape library
    </MainMenu.Item>
  );
};

export const AppMainMenu: React.FC<{
  theme: Theme | "system";
  refresh: () => void;
}> = React.memo((props) => {
  return (
    <MainMenu>
      <MainMenu.DefaultItems.LoadScene />
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      {/*
        No "Live collaboration" item.

        There were two ways to start a session and they did different things.
        This one opened upstream's ShareDialog, which calls
        `collabAPI.startCollaboration(null)` and hands out a link with **no
        owner check at all** — while Lawha's own share panel gates link access
        on `isOwner` and the server refuses a non-owner's change outright
        (`http/routes/boards.ts`, "Only the owner can change sharing"). So the
        menu item was the one path around a rule enforced everywhere else.

        Worse for everyday use: its "Stop session" only left the room. Sharing
        stayed on. Someone who pressed it believed they had stopped sharing a
        board that was still reachable by anyone holding the link.

        Sharing lives in the top bar's Share panel now, and only there. Opening
        a board still joins its room automatically (invariant 25) — joining is
        not sharing, and only the handing out is gated.
      */}
      <MainMenu.DefaultItems.CommandPalette className="highlighted" />
      <MainMenu.DefaultItems.SearchMenu />
      <LibraryMenuItem />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      {/*
        The Excalidraw+ link, the socials, and the sign-up upsell are gone:
        Lawha is self-hosted, so there is no hosted service to link out at and
        nothing to sign up to.
      */}
      {isDevEnv() && (
        <MainMenu.Item
          icon={eyeIcon}
          onSelect={() => {
            if (window.visualDebug) {
              delete window.visualDebug;
              saveDebugState({ enabled: false });
            } else {
              window.visualDebug = { data: [] };
              saveDebugState({ enabled: true });
            }
            props?.refresh();
          }}
        >
          Visual Debug
        </MainMenu.Item>
      )}
      <MainMenu.Separator />
      <MainMenu.DefaultItems.Preferences />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={props.theme} />
      <MainMenu.ItemCustom>
        <LanguageList style={{ width: "100%" }} />
      </MainMenu.ItemCustom>
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  );
});
