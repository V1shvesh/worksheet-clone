import { useEffect, useRef, useState } from "react";
import { useDispatch, useStore } from "react-redux";
import type { AppDispatch, RootState } from "../../app/store";
import { useWorkbookDoc } from "../../crdt/WorkbookDoc";
import { createFormulaEngine } from "../../engine";
import { AgGridView } from "./adapters/ag-grid/ag-grid-view";
import { createGridInteraction, type GridInteraction } from "./interaction";
import { connectModelToView, SheetViewModel } from "./model";
import { GridOverlay } from "./overlay";
import type { GridView } from "./port";
import "./GridContainer.css";

export interface GridContainerProps {
  sheetId: string;
  /** Adapter factory; tests inject the fake. */
  createView?: () => GridView;
}

interface Session {
  view: GridView;
  model: SheetViewModel;
  controller: GridInteraction;
}

const defaultCreateView = (): GridView => new AgGridView();

/** Wires doc + formula engine + view model + adapter + interaction + overlay for one sheet. */
export function GridContainer({ sheetId, createView = defaultCreateView }: GridContainerProps) {
  const { doc, readOnly } = useWorkbookDoc();
  const dispatch = useDispatch<AppDispatch>();
  const store = useStore<RootState>();
  const mountEl = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<Session | null>(null);

  // The controller reads access on every action, so a revoked edit right applies live.
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  // `createView` is read once per session; a new function identity must not rebuild the grid.
  const createViewRef = useRef(createView);
  createViewRef.current = createView;

  useEffect(() => {
    const el = mountEl.current;
    if (!el) return;
    const engine = createFormulaEngine(doc);
    const model = new SheetViewModel(doc, sheetId, engine);
    const view = createViewRef.current();
    view.mount(el, model.dimensions(), (c) => model.getCell(c));
    const disconnect = connectModelToView(model, view);
    const controller = createGridInteraction({
      view,
      model,
      store: { dispatch, getState: store.getState },
      target: {
        doc,
        get readOnly() {
          return readOnlyRef.current;
        },
      },
      sheetId,
    });
    setSession({ view, model, controller });

    return () => {
      setSession(null);
      controller.dispose();
      disconnect();
      view.destroy();
      model.destroy();
      engine.destroy();
    };
  }, [doc, sheetId, dispatch, store]);

  return (
    <div className="grid-container">
      <div ref={mountEl} className="grid-mount" />
      {session && <GridOverlay {...session} readOnly={readOnly} />}
    </div>
  );
}
