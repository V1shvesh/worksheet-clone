import { useEffect, useState } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../app/store";
import "./WakingUp.css";

/** A first request still pending after this long means the server is probably waking from sleep. */
export const REST_WAKING_DELAY_MS = 1500;
export const SOCKET_WAKING_DELAY_MS = 2000;

/** The queries every page needs before it can show anything. */
const FIRST_LOAD_ENDPOINTS = new Set(["me", "getWorkbook"]);

/** True once `active` has been continuously true for `delayMs`; false again as soon as it stops. */
export function useAfterDelay(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && elapsed;
}

/** A first-load request (session / workbook) is in flight and has nothing to show yet. */
export const selectFirstLoadPending = (state: RootState): boolean =>
  Object.values(state.api.queries).some(
    (query) =>
      query !== undefined &&
      query.status === "pending" &&
      query.data === undefined &&
      FIRST_LOAD_ENDPOINTS.has(query.endpointName),
  );

/**
 * The open workbook has not completed its first sync (socket not open yet, or open but the server
 * is still loading the document). A later drop is "Reconnecting…" in the header, not this.
 */
const selectSocketWaking = (state: RootState): boolean => {
  const { workbookId, hasSynced, access, online } = state.collab;
  return workbookId !== null && !hasSynced && access !== "denied" && online;
};

/**
 * "Waking up the server…": Railway puts the container to sleep when idle and its first request
 * (plus Neon waking) takes seconds. REST retries 502/503/504 meanwhile (see app/baseQuery).
 */
export function WakingUp() {
  const restWaking = useAfterDelay(useSelector(selectFirstLoadPending), REST_WAKING_DELAY_MS);
  const socketWaking = useAfterDelay(useSelector(selectSocketWaking), SOCKET_WAKING_DELAY_MS);
  if (!restWaking && !socketWaking) return null;
  return (
    <p role="status" data-testid="waking-up" className="waking-up">
      Waking up the server…
    </p>
  );
}
