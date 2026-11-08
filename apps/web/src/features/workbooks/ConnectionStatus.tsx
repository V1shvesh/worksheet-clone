import { useSelector } from "react-redux";
import type { RootState } from "../../app/store";

/** The live-connection indicator: Live / Connecting / Offline, plus "View only" and the access-denied alert. */
export function ConnectionStatus() {
  const { status, synced, access } = useSelector((state: RootState) => state.collab);

  if (access === "denied") {
    return <p role="alert">You don't have access to this workbook anymore.</p>;
  }
  const label =
    status === "connected" && synced
      ? "Live"
      : status === "disconnected"
        ? "Offline — reconnecting…"
        : "Connecting…";
  return (
    <p role="status" aria-label="Connection" className="workbook-header-connection">
      {label}
      {access === "read-only" && " · View only"}
    </p>
  );
}
