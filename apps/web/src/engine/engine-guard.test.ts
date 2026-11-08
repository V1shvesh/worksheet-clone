import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HyperFormula } from "hyperformula";
import { addSheet } from "@worksheet-clone/shared";
import { edit, newDoc } from "../test-utils/workbook";
import { createFormulaEngine, type EngineEvent, type FormulaEngine } from "./formula-engine";

/** A real HyperFormula whose calls can be rigged to throw. */
function rigged() {
  const hf = HyperFormula.buildEmpty({ licenseKey: "gpl-v3", evaluateNullToZero: true });
  const rig = { cellWrites: false, sheetLoadsFor: new Set<number>() };
  const setCellContents = hf.setCellContents.bind(hf);
  hf.setCellContents = ((...args: Parameters<typeof hf.setCellContents>) => {
    if (rig.cellWrites) throw new Error("boom: setCellContents");
    return setCellContents(...args);
  }) as typeof hf.setCellContents;
  const setSheetContent = hf.setSheetContent.bind(hf);
  hf.setSheetContent = ((sheetId: number, ...rest: [never]) => {
    if (rig.sheetLoadsFor.has(sheetId)) throw new Error("boom: setSheetContent");
    return setSheetContent(sheetId, ...rest);
  }) as typeof hf.setSheetContent;
  return { hf, rig };
}

describe("formula engine guard", () => {
  let engine: FormulaEngine | undefined;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    engine?.destroy();
    engine = undefined;
    errors.mockRestore();
    vi.useRealTimers();
  });

  it("keeps an incremental HyperFormula failure out of Yjs's observers and reloads the sheet", () => {
    const { doc, sheetId } = newDoc();
    edit(doc, sheetId, 0, 0, { v: 1 });
    edit(doc, sheetId, 1, 0, { f: "=A1*10" });
    const { hf, rig } = rigged();
    engine = createFormulaEngine(doc, { hyperFormula: hf });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    // Registered AFTER the engine: it only runs if the engine's handler doesn't throw out of the chain.
    const later = vi.fn();
    doc.on("afterTransaction", later);

    rig.cellWrites = true;
    expect(() => edit(doc, sheetId, 0, 0, { v: 5 })).not.toThrow();

    expect(later).toHaveBeenCalledTimes(1);
    expect(engine.getValue(sheetId, 0, 0)).toBe(5);
    expect(engine.getValue(sheetId, 1, 0)).toBe(50);
    expect(events).toContainEqual({ type: "rebuilt", sheetId });
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("shows #ERROR! for a sheet that cannot reload, leaves other sheets working, and recovers later", () => {
    const { doc, sheetId } = newDoc();
    const other = addSheet(doc, "Data");
    edit(doc, sheetId, 0, 0, { v: 1 });
    edit(doc, other, 0, 0, { v: 7 });
    const { hf, rig } = rigged();
    engine = createFormulaEngine(doc, { hyperFormula: hf });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    rig.cellWrites = true;
    rig.sheetLoadsFor.add(hf.getSheetId(sheetId)!);
    expect(() => edit(doc, sheetId, 0, 0, { v: 2 })).not.toThrow();
    expect(engine.getValue(sheetId, 0, 0)).toMatchObject({ value: "#ERROR!" });
    expect(events).toContainEqual({ type: "rebuilt", sheetId });
    expect(engine.getValue(other, 0, 0)).toBe(7);

    // The next change retries the reload; once HyperFormula works again the sheet is back.
    rig.cellWrites = false;
    rig.sheetLoadsFor.clear();
    edit(doc, sheetId, 1, 0, { v: 3 });
    expect(engine.getValue(sheetId, 0, 0)).toBe(2);
    expect(engine.getValue(sheetId, 1, 0)).toBe(3);
  });

  it("a sheet that fails during the initial load reads as #ERROR!", () => {
    const { doc, sheetId } = newDoc();
    edit(doc, sheetId, 0, 0, { v: 1 });
    const { hf, rig } = rigged();
    // addSheet happens inside the engine; rig every id the first sheet could get.
    rig.sheetLoadsFor.add(0);
    engine = createFormulaEngine(doc, { hyperFormula: hf });
    expect(engine.getValue(sheetId, 0, 0)).toMatchObject({ value: "#ERROR!" });
  });

  it("logs a burst of failures once", () => {
    vi.useFakeTimers();
    const { doc, sheetId } = newDoc();
    const { hf, rig } = rigged();
    engine = createFormulaEngine(doc, { hyperFormula: hf });
    rig.cellWrites = true;
    for (let i = 0; i < 5; i++) edit(doc, sheetId, i, 0, { v: i });
    expect(errors).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3000);
    edit(doc, sheetId, 9, 0, { v: 9 });
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it("a throwing listener doesn't stop the others or escape the transaction", () => {
    const { doc, sheetId } = newDoc();
    engine = createFormulaEngine(doc);
    const seen = vi.fn();
    engine.subscribe(() => {
      throw new Error("listener boom");
    });
    engine.subscribe(seen);
    expect(() => edit(doc, sheetId, 0, 0, { v: 1 })).not.toThrow();
    expect(seen).toHaveBeenCalled();
  });
});
