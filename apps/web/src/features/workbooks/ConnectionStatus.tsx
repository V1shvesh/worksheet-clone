import { useEffect, useState } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../app/store";
import { syncStatus, type SyncStatus } from "../../crdt/collabSlice";

/** "Saving…" only shows once changes have been pending this long, so quick saves don't flicker. */
export const SAVING_DELAY_MS = 300;

const LABELS: Record<SyncStatus, string> = {
  saved: "All changes saved",
  saving: "Saving…",
  offline: "Offline — changes are kept on this device",
  reconnecting: "Reconnecting…",
  connecting: "Connecting…",
  saveFailing: "Not saved — retrying",
};

/** The status as displayed: "saving" is shown as "saved" until it has lasted SAVING_DELAY_MS. */
function useDisplayedStatus(status: SyncStatus): SyncStatus {
  const [saveElapsed, setSaveElapsed] = useState(false);
  useEffect(() => {
    if (status !== "saving") {
      setSaveElapsed(false);
      return;
    }
    const timer = setTimeout(() => setSaveElapsed(true), SAVING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);
  return status === "saving" && !saveElapsed ? "saved" : status;
}

/** The sync indicator (saved / saving / offline / …), plus "View only" and the access-denied alert. */
export function ConnectionStatus() {
  const collab = useSelector((state: RootState) => state.collab);
  const displayed = useDisplayedStatus(syncStatus(collab));

  if (collab.access === "denied") {
    return <p role="alert">You don't have access to this workbook anymore.</p>;
  }
  const pending = collab.unsyncedChanges;
  const title =
    displayed === "offline" && pending > 0
      ? `${pending} change${pending === 1 ? "" : "s"} waiting to sync`
      : undefined;
  return (
    <p
      role="status"
      aria-label="Connection"
      className="workbook-header-connection"
      data-sync-status={displayed}
      title={title}
    >
      {LABELS[displayed]}
      {collab.access === "read-only" && " · View only"}
    </p>
  );
}
