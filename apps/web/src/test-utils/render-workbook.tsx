import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { Provider } from "react-redux";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import type * as Y from "yjs";
import { createStore } from "../app/store";
import { WorkbookDocContext } from "../crdt/WorkbookDoc";

/** Shows where the router is and how it got there (PUSH, REPLACE or POP). */
export function LocationProbe() {
  const location = useLocation();
  const type = useNavigationType();
  return (
    <>
      <output data-testid="location">{location.pathname + location.search}</output>
      <output data-testid="nav-type">{type}</output>
    </>
  );
}

/**
 * Renders under a router, a Redux store and a workbook doc context backed by a
 * real Y.Doc (no provider or network). Test-only.
 */
export function renderWithWorkbook(
  ui: ReactElement,
  options: { doc: Y.Doc; readOnly?: boolean; route?: string },
): RenderResult & { store: ReturnType<typeof createStore>; setReadOnly(readOnly: boolean): void } {
  const store = createStore();
  const tree = (readOnly: boolean) => (
    <Provider store={store}>
      <WorkbookDocContext.Provider value={{ doc: options.doc, readOnly }}>
        <MemoryRouter
          initialEntries={[options.route ?? "/workbooks/w1"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          {ui}
          <LocationProbe />
        </MemoryRouter>
      </WorkbookDocContext.Provider>
    </Provider>
  );
  const utils = render(tree(options.readOnly ?? false));
  return { ...utils, store, setReadOnly: (readOnly: boolean) => utils.rerender(tree(readOnly)) };
}

/** Applies a change as if it came from a collaborator (an origin the app doesn't own). */
export function asRemote(doc: Y.Doc, change: () => void): void {
  doc.transact(change, "remote");
}
