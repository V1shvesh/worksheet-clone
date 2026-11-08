import { lazy, Suspense, useState } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../app/store";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { useActiveSheet } from "../sheets/useActiveSheet";

type GridModule = { WorkbookGrid: typeof import("../grid/WorkbookGrid").WorkbookGrid };
type GridLoader = () => Promise<GridModule>;

// AG Grid and HyperFormula are heavy; they load only once a workbook is opened.
const importGrid: GridLoader = () => import("../grid/WorkbookGrid");
const lazyGrid = (load: GridLoader) =>
  lazy(() => load().then((m) => ({ default: m.WorkbookGrid })));

/** The active sheet's grid (see useActiveSheet), once the document has synced or its on-device copy has loaded (before either it has no sheets). */
export function LiveGrid() {
  // Cached content (applied before the server answers) is shown too, read-only until access is granted.
  const ready = useSelector((state: RootState) => state.collab.synced || state.collab.cacheLoaded);
  const { sheetId } = useActiveSheet();
  if (!ready || !sheetId) return null;
  return (
    <div className="workbook-page-grid">
      <GridBoundary sheetId={sheetId} />
    </div>
  );
}

/**
 * Loads and shows the grid. A failed load (the chunk 404s after a deploy) or a render error shows
 * a retry box instead of taking the page down. React.lazy caches a rejected import for good, so
 * Retry builds a brand-new lazy component.
 */
export function GridBoundary({
  sheetId,
  load = importGrid,
}: {
  sheetId: string;
  load?: GridLoader;
}) {
  const [Grid, setGrid] = useState(() => lazyGrid(load));
  return (
    <ErrorBoundary
      fallback={(_error, reset) => (
        <div role="alert" className="workbook-page-grid-error">
          <p>Couldn&apos;t load the grid</p>
          <button
            type="button"
            onClick={() => {
              setGrid(() => lazyGrid(load));
              reset();
            }}
          >
            Retry
          </button>
        </div>
      )}
    >
      <Suspense fallback={<p className="workbook-page-grid-loading">Loading grid…</p>}>
        <Grid sheetId={sheetId} />
      </Suspense>
    </ErrorBoundary>
  );
}
