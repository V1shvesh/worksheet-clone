import { useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { readSheetOrder, readVisibleSheetOrder } from "@worksheet-clone/shared";
import { shallowEqualArrays, useDocValue } from "../../crdt/useDocValue";
import { useWorkbookDoc } from "../../crdt/WorkbookDoc";
import { resolveActiveSheet } from "./resolve-active-sheet";

export const SHEET_PARAM = "sheet";

/**
 * The open sheet. `?sheet=<id>` in the URL is the source of truth; when it
 * names nothing usable the first visible sheet is shown and the URL is
 * corrected. Every URL update replaces the history entry, so switching tabs
 * never piles up history. `sheetId` is null until the document has a sheet.
 */
export function useActiveSheet(): { sheetId: string | null; openSheet: (id: string) => void } {
  const { doc } = useWorkbookDoc();
  const [params, setParams] = useSearchParams();
  const order = useDocValue(doc, readSheetOrder, shallowEqualArrays);
  const visible = useDocValue(doc, readVisibleSheetOrder, shallowEqualArrays);
  const requested = params.get(SHEET_PARAM);

  const last = useRef<{ id: string; index: number } | null>(null);
  const resolved = resolveActiveSheet({ requested, order, visible, last: last.current });
  const sheetId = resolved?.sheetId ?? null;
  const replaceUrl = resolved?.replaceUrl ?? false;

  const setSheetParam = useCallback(
    (id: string) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(SHEET_PARAM, id);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  useEffect(() => {
    if (sheetId !== null && replaceUrl) setSheetParam(sheetId);
  }, [sheetId, replaceUrl, setSheetParam]);

  // Remember where the shown sheet sits, to pick a neighbour if it vanishes.
  // Only while the URL agrees: until the replacement lands, a repeat render
  // must reach the same neighbour, not fall back to the first sheet.
  useEffect(() => {
    if (sheetId !== null && !replaceUrl)
      last.current = { id: sheetId, index: order.indexOf(sheetId) };
  }, [sheetId, replaceUrl, order]);

  return { sheetId, openSheet: setSheetParam };
}
