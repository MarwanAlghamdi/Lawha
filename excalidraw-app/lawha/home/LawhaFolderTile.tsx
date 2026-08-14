import { folderColor } from "./folderTree";
import { plural } from "./homeText";

import type { BoardDrag } from "./useBoardDrag";
import type { FolderSummary } from "../../data/boards";

interface LawhaFolderTileProps {
  folder: FolderSummary;
  /** Boards inside, subfolders included. */
  count: number;
  /** How many folders sit directly inside this one. */
  subfolderCount: number;
  onOpen: () => void;
  drag: BoardDrag;
}

/**
 * A subfolder, shown above the grid of the folder you are standing in.
 *
 * The tiles exist so that going down a level is a click on the thing you are
 * looking at rather than a hunt for the same name in the sidebar. They show
 * only the *direct* children of the current folder — a tile per descendant
 * would turn a deep tree into a wall of tiles and make the sidebar the only
 * place the shape of the tree is legible.
 *
 * A drop target, like every other folder surface. The glyph is a folder drawn
 * in the folder's own colour rather than an icon font: it is two divs, it
 * inherits the 1.5px border that is this product's signature, and
 * `color-mix` gives it a wash that works in both themes from the single stored
 * colour.
 */
export const LawhaFolderTile = ({
  folder,
  count,
  subfolderCount,
  onOpen,
  drag,
}: LawhaFolderTileProps) => {
  const colour = folderColor(folder.colorIndex);
  const over = drag.isOver(folder.id);

  return (
    <button
      type="button"
      className={`lw-folder-tile${over ? " lw-folder-tile--over" : ""}`}
      onClick={onOpen}
      {...drag.targetProps(folder.id)}
    >
      <span
        className="lw-folder-tile__glyph"
        style={{
          borderColor: colour,
          background: `color-mix(in oklab, ${colour} 16%, transparent)`,
          boxShadow: `inset 0 4px 0 -2px ${colour}`,
        }}
        aria-hidden="true"
      />
      <span className="lw-folder-tile__text">
        <span className="lw-folder-tile__name">{folder.name}</span>
        <span className="lw-folder-tile__sub">
          {plural(count, "board")}
          {subfolderCount > 0
            ? ` · ${subfolderCount} ${
                subfolderCount === 1 ? "subfolder" : "subfolders"
              }`
            : ""}
        </span>
      </span>
    </button>
  );
};
