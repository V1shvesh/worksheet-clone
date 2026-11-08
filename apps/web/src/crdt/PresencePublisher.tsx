import { useContext, useEffect, useRef } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../app/store";
import { authApi } from "../features/auth/authApi";
import { createPresencePublisher, type PresencePublisher as Publisher } from "./presence";
import { WorkbookDocContext } from "./WorkbookDoc";

/** Renders nothing; publishes the open sheet and selection of this client through awareness. */
export function PresencePublisher() {
  const awareness = useContext(WorkbookDocContext)?.awareness ?? null;
  const user = useSelector((state: RootState) => authApi.endpoints.me.select()(state).data?.user);
  const sheetId = useSelector((state: RootState) => state.grid.sheetId);
  const selection = useSelector((state: RootState) => state.grid.selection);
  const publisher = useRef<Publisher | null>(null);

  const userId = user?.id;
  const email = user?.email;
  useEffect(() => {
    if (!awareness || !userId || !email) return;
    publisher.current = createPresencePublisher(awareness, { id: userId, email });
    return () => {
      publisher.current?.destroy();
      publisher.current = null;
    };
  }, [awareness, userId, email]);

  // Declared after the effect above so a fresh publisher gets the current values on mount.
  useEffect(() => {
    publisher.current?.update(sheetId, selection);
  }, [awareness, userId, email, sheetId, selection]);

  return null;
}
