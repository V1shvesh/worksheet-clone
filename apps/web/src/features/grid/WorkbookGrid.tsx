import { useEffect, useState } from "react";
import { useWorkbookDoc } from "../../crdt/WorkbookDoc";
import { createFormulaEngine, type FormulaEngine } from "../../engine";
import { useUndoRedo } from "../toolbar/useUndoRedo";
import { GridContainer } from "./GridContainer";

/**
 * Owns the workbook's formula engine (one per Y.Doc, so cross-sheet formulas
 * keep evaluating while you switch tabs) and shows one sheet's grid. Loaded
 * lazily: it pulls in HyperFormula and AG Grid.
 */
export function WorkbookGrid({ sheetId }: { sheetId: string }) {
  const { doc } = useWorkbookDoc();
  const { undo, redo } = useUndoRedo();
  const [engine, setEngine] = useState<FormulaEngine | null>(null);

  useEffect(() => {
    const created = createFormulaEngine(doc);
    setEngine(created);
    return () => {
      setEngine(null);
      created.destroy();
    };
  }, [doc]);

  if (!engine) return null;
  // Remount per sheet: selection, editor and the adapter are per-sheet sessions.
  return <GridContainer key={sheetId} sheetId={sheetId} engine={engine} history={{ undo, redo }} />;
}
