import { lazy, Suspense } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../app/store";
import { useSheetOrder } from "../../crdt/useDocValue";

// AG Grid and HyperFormula are heavy; they load only once a workbook is opened.
const GridContainer = lazy(() =>
  import("../grid/GridContainer").then((m) => ({ default: m.GridContainer })),
);

/** The first sheet's grid, once the document has synced (before that it has no sheets). */
export function LiveGrid() {
  const synced = useSelector((state: RootState) => state.collab.synced);
  const [firstSheetId] = useSheetOrder();
  if (!synced || !firstSheetId) return null;
  return (
    <div className="workbook-page-grid">
      <Suspense fallback={<p className="workbook-page-grid-loading">Loading grid…</p>}>
        <GridContainer key={firstSheetId} sheetId={firstSheetId} />
      </Suspense>
    </div>
  );
}
