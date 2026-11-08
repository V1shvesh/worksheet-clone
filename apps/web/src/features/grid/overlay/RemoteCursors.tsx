import { memo, useEffect, useReducer } from "react";
import { emailLocalPart, type Peer } from "../../../crdt/presence";
import { usePresence } from "../../../crdt/usePresence";
import { resolveSelection, type IdMapper } from "../interaction";
import type { SheetViewModel } from "../model";
import { rangeContains, type GridView, type Rect } from "../port";
import { visibleRangeRect } from "./geometry";

const px = (r: Rect) => ({ left: r.x, top: r.y, width: r.width, height: r.height });
const TAG_HEIGHT = 16;

interface RemoteCursorsProps {
  view: GridView;
  model: SheetViewModel;
}

/**
 * Collaborators' selections on this sheet: a tint over the range, an outline on the active
 * cell (the anchor) and a name tag. Placed only through `getCellRect`; ids that no longer exist
 * (a collaborator deleted the row) hide the cursor. Memoised, with its own scroll/size
 * subscriptions, so local selection changes don't re-render it.
 */
export const RemoteCursors = memo(function RemoteCursors({ view, model }: RemoteCursorsProps) {
  const peers = usePresence();
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const offScroll = view.on("scroll", refresh);
    const offModel = model.subscribe((event) => {
      if (event.type === "dimensions") refresh();
    });
    window.addEventListener("resize", refresh);
    return () => {
      offScroll();
      offModel();
      window.removeEventListener("resize", refresh);
    };
  }, [view, model]);

  const here = peers.filter((peer) => peer.sheetId === model.sheetId && peer.selection);
  if (here.length === 0) return null;
  const visible = view.getVisibleRange();
  const mapper: IdMapper = model;

  return (
    <>
      {here.map((peer) => (
        <PeerCursor key={peer.clientId} peer={peer} view={view} mapper={mapper} visible={visible} />
      ))}
    </>
  );
});

function PeerCursor({
  peer,
  view,
  mapper,
  visible,
}: {
  peer: Peer;
  view: GridView;
  mapper: IdMapper;
  visible: ReturnType<GridView["getVisibleRange"]>;
}) {
  const selection = peer.selection!;
  const row = mapper.rowIndexOf(selection.anchor.rowId);
  const col = mapper.colIndexOf(selection.anchor.colId);
  if (row === undefined || col === undefined) return null;

  const resolved = resolveSelection(selection, mapper);
  const tintRect = resolved && visibleRangeRect(view, resolved.range);
  const cell = { row, col };
  const activeRect = rangeContains(visible, cell) ? view.getCellRect(cell) : null;
  if (!tintRect && !activeRect) return null;

  const { color } = peer.user;
  // The tag sits above the cell, or below it on the top row where it would be clipped.
  const tagBelow = activeRect !== null && activeRect.y < TAG_HEIGHT;
  return (
    <>
      {tintRect && (
        <div
          className="grid-remote-selection"
          data-testid="remote-selection"
          data-user-id={peer.user.id}
          style={{ ...px(tintRect), backgroundColor: `${color}1f` }}
        />
      )}
      {activeRect && (
        <div
          className="grid-remote-cursor"
          data-testid="remote-cursor"
          data-user-id={peer.user.id}
          style={{ ...px(activeRect), borderColor: color }}
        >
          <span
            className={tagBelow ? "grid-remote-tag grid-remote-tag-below" : "grid-remote-tag"}
            style={{ backgroundColor: color }}
          >
            {emailLocalPart(peer.user.email)}
          </span>
        </div>
      )}
    </>
  );
}
