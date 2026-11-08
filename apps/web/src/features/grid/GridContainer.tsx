import { useEffect, useRef, useState } from "react";
import { useDispatch, useStore } from "react-redux";
import type { AppDispatch, RootState } from "../../app/store";
import { useWorkbookDoc } from "../../crdt/WorkbookDoc";
import type { FormulaEngine } from "../../engine";
import { FormulaBar } from "../formula-bar/FormulaBar";
import { AgGridView } from "./adapters/ag-grid/ag-grid-view";
import { unimplementedStructureActions, type StructureActions } from "./commands";
import { createGridInteraction, type GridInteraction } from "./interaction";
import { connectModelToView, SheetViewModel } from "./model";
import { GridOverlay } from "./overlay";
import type { GridView } from "./port";
import "./GridContainer.css";

export interface GridContainerProps {
  sheetId: string;
  /** The workbook's formula engine; it outlives this component (sheet switches remount the grid). */
  engine: FormulaEngine;
  /** Adapter factory; tests inject the fake. */
  createView?: () => GridView;
  /** Undo/redo for the keyboard chords (needs the router, so the container takes it as a prop). */
  history?: { undo(): void; redo(): void };
  /**
   * Insert/delete rows and columns for the context menu and shortcuts. Defaults to a no-op
   * placeholder until the shared insert/delete helpers are wired in (see `StructureActions`).
   */
  structure?: StructureActions;
}

interface Session {
  view: GridView;
  model: SheetViewModel;
  controller: GridInteraction;
}

const defaultCreateView = (): GridView => new AgGridView();

/** Wires doc + formula engine + view model + adapter + interaction + overlay for one sheet. */
export function GridContainer({
  sheetId,
  engine,
  createView = defaultCreateView,
  history,
  structure = unimplementedStructureActions,
}: GridContainerProps) {
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

  const structureRef = useRef(structure);
  structureRef.current = structure;

  const historyRef = useRef(history);
  historyRef.current = history;
  useEffect(() => {
    const el = mountEl.current;
    if (!el) return;
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
      history: {
        undo: () => historyRef.current?.undo(),
        redo: () => historyRef.current?.redo(),
      },
      structure: {
        insertRows: (at, count) => structureRef.current.insertRows(at, count),
        insertCols: (at, count) => structureRef.current.insertCols(at, count),
        deleteRows: (ids) => structureRef.current.deleteRows(ids),
        deleteCols: (ids) => structureRef.current.deleteCols(ids),
      },
    });
    setSession({ view, model, controller });

    return () => {
      setSession(null);
      controller.dispose();
      disconnect();
      view.destroy();
      model.destroy();
    };
  }, [doc, sheetId, engine, dispatch, store]);

  // Native clipboard events, so no Clipboard API permission prompt. They bubble from the
  // grid's focused container to the mount element; the cell editor and formula bar live
  // outside it, so their native text copy/paste is untouched.
  useEffect(() => {
    const el = mountEl.current;
    if (!el || !session) return;
    const onClipboard = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const handled =
        e.type === "paste"
          ? session.controller.paste(e.clipboardData)
          : session.controller.copy(e.clipboardData, e.type === "cut");
      if (handled) e.preventDefault();
    };
    const types = ["copy", "cut", "paste"] as const;
    for (const type of types) el.addEventListener(type, onClipboard);
    return () => {
      for (const type of types) el.removeEventListener(type, onClipboard);
    };
  }, [session]);

  return (
    <div className="grid-container">
      {session && <FormulaBar {...session} readOnly={readOnly} />}
      <div className="grid-stage">
        <div ref={mountEl} className="grid-mount" />
        {session && <GridOverlay {...session} readOnly={readOnly} />}
      </div>
    </div>
  );
}
