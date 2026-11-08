import { Link, useParams } from "react-router-dom";
import { getApiErrorMessage } from "../../app/apiErrors";
import { WorkbookDocProvider } from "../../crdt/WorkbookDoc";
import { LiveGrid } from "./LiveGrid";
import { LiveWorkbook } from "./LiveWorkbook";
import { useGetWorkbookQuery } from "./workbooksApi";
import "./WorkbookPage.css";

export function WorkbookPage() {
  const { id = "" } = useParams();
  const { data: workbook, isLoading, isError, error } = useGetWorkbookQuery(id);

  return (
    <main className="workbook-page">
      <p>
        <Link to="/">← All workbooks</Link>
      </p>
      {isLoading && <p>Loading…</p>}
      {isError && <p role="alert">{getApiErrorMessage(error)}</p>}
      {workbook && (
        <>
          <h1>{workbook.name}</h1>
          <p>Your role: {workbook.role}</p>
          {/* Only connect once REST has confirmed membership. */}
          <WorkbookDocProvider workbookId={workbook.id}>
            <LiveWorkbook />
            <LiveGrid />
          </WorkbookDocProvider>
        </>
      )}
    </main>
  );
}
