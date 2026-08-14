import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { LinkIcon } from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { useEffect } from "react";

import { atom, useAtom } from "../app-jotai";

import "./ShareDialog.scss";

type OnExportToBackend = () => void;

/**
 * Upstream's export-to-shareable-link dialog, and **only** that.
 *
 * It used to be two things behind one atom: a `collaborationOnly` mode that
 * started and stopped live sessions, and a `share` mode that exported a
 * read-only snapshot to a link. The first is gone — see AppMainMenu.tsx for
 * why, in short: it handed out a link with no owner check, and its "Stop
 * session" left sharing switched on. Sharing lives in the top bar's Share
 * panel now, and in one place only.
 *
 * What is left is a feature that does not work on this deployment either, and
 * that is a separate decision recorded in `.env.production`: the four off-box
 * URLs are deliberately blank, so `exportToBackend` fails locally and
 * immediately rather than posting a whole scene to excalidraw.com. Removing the
 * entry point was explicitly *not* that change, and it is not this one — this
 * change is about there being one way to share a live board, which there now
 * is. Left standing so the two decisions stay separable.
 */
export const shareDialogStateAtom = atom<{ isOpen: boolean }>({
  isOpen: false,
});

export type ShareDialogProps = {
  handleClose: () => void;
  onExportToBackend: OnExportToBackend;
};

const ShareDialogInner = (props: ShareDialogProps) => {
  const { t } = useI18n();

  return (
    <Dialog size="small" onCloseRequest={props.handleClose} title={false}>
      <div className="ShareDialog">
        <div className="ShareDialog__picker__header">
          {t("exportDialog.link_title")}
        </div>
        <div className="ShareDialog__picker__description">
          {t("exportDialog.link_details")}
        </div>

        <div className="ShareDialog__picker__button">
          <FilledButton
            size="large"
            label={t("exportDialog.link_button")}
            icon={LinkIcon}
            onClick={async () => {
              await props.onExportToBackend();
              props.handleClose();
            }}
          />
        </div>
      </div>
    </Dialog>
  );
};

export const ShareDialog = (props: {
  onExportToBackend: OnExportToBackend;
}) => {
  const [shareDialogState, setShareDialogState] = useAtom(shareDialogStateAtom);

  const { openDialog } = useUIAppState();

  useEffect(() => {
    if (openDialog) {
      setShareDialogState({ isOpen: false });
    }
  }, [openDialog, setShareDialogState]);

  if (!shareDialogState.isOpen) {
    return null;
  }

  return (
    <ShareDialogInner
      handleClose={() => setShareDialogState({ isOpen: false })}
      onExportToBackend={props.onExportToBackend}
    />
  );
};
