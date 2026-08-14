import { Footer } from "@excalidraw/excalidraw/index";
import React from "react";

import { DebugFooter, isVisualDebuggerEnabled } from "./DebugCanvas";

/**
 * The editor's bottom-left cluster.
 *
 * It used to also carry `LawhaSyncPill`, a sentence reading "reconnect merges,
 * never overwrites" that appeared only during a collaboration session. It was
 * removed rather than moved: the claim was true but it was a slogan, not a
 * readout — it held no state, changed with nothing, and duplicated ground that
 * `LawhaSaveStatus` already covers with an actual value. Offline in particular
 * is reported there and deliberately outranks the save state, because a queued
 * write is not a saved one (App.tsx). Nothing was lost by deleting it, and the
 * footer stops competing with the app bar for the same message.
 */
export const AppFooter = React.memo(
  ({ onChange }: { onChange: () => void }) => {
    return (
      <Footer>
        <div
          style={{
            display: "flex",
            gap: ".5rem",
            alignItems: "center",
          }}
        >
          {isVisualDebuggerEnabled() && <DebugFooter onChange={onChange} />}
        </div>
      </Footer>
    );
  },
);
