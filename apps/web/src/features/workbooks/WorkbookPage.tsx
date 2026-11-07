import { Link, useParams } from "react-router-dom";
import { getApiErrorMessage } from "../../app/apiErrors";
import { useGetWorkbookQuery } from "./workbooksApi";

// Placeholder until M3 mounts the realtime document here.
export function WorkbookPage() {
  const { id = "" } = useParams();
  const { data: workbook, isLoading, isError, error } = useGetWorkbookQuery(id);

  return (
    <main>
      <p>
        <Link to="/">← All workbooks</Link>
      </p>
      {isLoading && <p>Loading…</p>}
      {isError && <p role="alert">{getApiErrorMessage(error)}</p>}
      {workbook && (
        <>
          <h1>{workbook.name}</h1>
          <p>Your role: {workbook.role}</p>
        </>
      )}
    </main>
  );
}
