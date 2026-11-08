import type { ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

/**
 * The last line of defence: an unexpected render error anywhere shows this instead of a blank page.
 * Nothing needs saving before the reload: the open workbook's edits are already in IndexedDB
 * (see crdt/offlineCache) and the server has everything it acknowledged.
 */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={() => (
        <div role="alert" className="app-error">
          <h1>Something went wrong</h1>
          <p>Your changes are kept. Reloading the page usually fixes this.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
