import { useContext, useMemo, useSyncExternalStore } from "react";
import { useSelector } from "react-redux";
import { authApi } from "../features/auth/authApi";
import type { RootState } from "../app/store";
import { createPeersStore, type Peer } from "./presence";
import { WorkbookDocContext } from "./WorkbookDoc";

const NONE: Peer[] = [];
const noopSubscribe = () => () => {};

/**
 * Everyone else in the workbook, including this user's other tabs (`isSelf`), viewers
 * included. Empty outside a workbook or while the provider has no awareness.
 */
export function usePresence(): Peer[] {
  const awareness = useContext(WorkbookDocContext)?.awareness ?? null;
  const selfUserId = useSelector(
    (state: RootState) => authApi.endpoints.me.select()(state).data?.user.id,
  );
  const store = useMemo(
    () => (awareness ? createPeersStore(awareness, selfUserId) : null),
    [awareness, selfUserId],
  );
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : () => NONE,
  );
}
