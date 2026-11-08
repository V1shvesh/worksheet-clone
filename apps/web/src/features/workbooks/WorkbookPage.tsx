import { useParams } from "react-router-dom";
import { getApiErrorMessage } from "../../app/apiErrors";
import { WorkbookDocProvider } from "../../crdt/WorkbookDoc";
import { Toasts } from "../toasts/Toasts";
import { SheetTabs } from "../sheets/SheetTabs";
import { LiveGrid } from "./LiveGrid";
import { WorkbookHeader } from "./WorkbookHeader";
import { useGetWorkbookQuery } from "./workbooksApi";
import "./WorkbookPage.css";

export function WorkbookPage() {
  const { id = "" } = useParams();
  const { data: workbook, isLoading, isError, error } = useGetWorkbookQuery(id);

  return (
    <main className="workbook-page">
      {isLoading && <p>Loading…</p>}
      {isError && <p role="alert">{getApiErrorMessage(error)}</p>}
      {workbook && (
        <>
          <WorkbookHeader workbook={workbook} />
          {/* Only connect once REST has confirmed membership. */}
          <WorkbookDocProvider workbookId={workbook.id}>
            <LiveGrid />
            <SheetTabs />
            <Toasts />
          </WorkbookDocProvider>
        </>
      )}
    </main>
  );
}
