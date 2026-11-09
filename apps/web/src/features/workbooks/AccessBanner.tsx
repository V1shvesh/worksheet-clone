import { useState } from "react";
import { useSelector } from "react-redux";
import { Link } from "react-router-dom";
import type { RootState } from "../../app/store";
import { ACCESS_LOSS_MESSAGES } from "../../crdt/accessLoss";
import { useWorkbookDoc } from "../../crdt/WorkbookDoc";
import { downloadFiles, recoveryFiles } from "./recovery-csv";

/**
 * Shown above the grid when access dropped while the workbook was open, or the server refused a
 * change for exceeding the size cap (see AccessLoss).
 * Editing has already stopped by then (the connection is read-only or gone). When the server had
 * not confirmed some of the user's changes, they are offered as CSV files first; "Reload" then
 * discards this replica and shows the server's state.
 */
export function AccessBanner({ workbookName }: { workbookName: string }) {
  const loss = useSelector((state: RootState) => state.collab.accessLoss);
  const { doc, resetDoc } = useWorkbookDoc();
  const [reloading, setReloading] = useState(false);
  if (!loss) return null;

  function reload(): void {
    if (!resetDoc) return;
    setReloading(true);
    void resetDoc().finally(() => setReloading(false));
  }

  return (
    <div role="alert" data-testid="access-banner" className="access-banner">
      <p className="access-banner-message">{ACCESS_LOSS_MESSAGES[loss.kind]}</p>
      {loss.unsaved && loss.kind !== "tooLarge" && (
        <p className="access-banner-detail">
          Some of your latest changes were not saved
          {loss.kind === "downgraded" ? " and will be discarded when you reload." : "."}
        </p>
      )}
      <div className="access-banner-actions">
        {loss.unsaved && (
          <button type="button" onClick={() => downloadFiles(recoveryFiles(doc, workbookName))}>
            Download unsaved changes
          </button>
        )}
        {loss.kind === "downgraded" || loss.kind === "tooLarge" ? (
          resetDoc &&
          loss.unsaved && (
            <button type="button" onClick={reload} disabled={reloading}>
              Reload
            </button>
          )
        ) : (
          <Link to="/">Back to all workbooks</Link>
        )}
      </div>
    </div>
  );
}
