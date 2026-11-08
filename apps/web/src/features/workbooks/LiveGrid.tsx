import { lazy, Suspense } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../app/store";
import { useActiveSheet } from "../sheets/useActiveSheet";

// AG Grid and HyperFormula are heavy; they load only once a workbook is opened.
const WorkbookGrid = lazy(() =>
  import("../grid/WorkbookGrid").then((m) => ({ default: m.WorkbookGrid })),
);

/** The active sheet's grid (see useActiveSheet), once the document has synced or its on-device copy has loaded (before either it has no sheets). */
export function LiveGrid() {
  // Cached content (applied before the server answers) is shown too, read-only until access is granted.
  const ready = useSelector((state: RootState) => state.collab.synced || state.collab.cacheLoaded);
  const { sheetId } = useActiveSheet();
  if (!ready || !sheetId) return null;
  return (
    <div className="workbook-page-grid">
      <Suspense fallback={<p className="workbook-page-grid-loading">Loading grid…</p>}>
        <WorkbookGrid sheetId={sheetId} />
      </Suspense>
    </div>
  );
}
