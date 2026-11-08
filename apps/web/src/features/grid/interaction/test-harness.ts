import type * as Y from "yjs";
import { createStore } from "../../../app/store";
import { createFormulaEngine } from "../../../engine";
import { newDoc } from "../../../test-utils/workbook";
import { FakeGridView } from "../adapters/fake/fake-grid-view";
import { connectModelToView, SheetViewModel } from "../model";
import { createGridInteraction } from "./controller";

/** Real doc + engine + model + store with a mounted fake grid, for interaction tests. */
export function mountInteraction(opts: { doc?: Y.Doc; sheetId?: string } = {}) {
  const fresh = opts.doc && opts.sheetId ? { doc: opts.doc, sheetId: opts.sheetId } : newDoc();
  const { doc, sheetId } = fresh;
  const engine = createFormulaEngine(doc);
  const model = new SheetViewModel(doc, sheetId, engine);
  const view = new FakeGridView();
  view.mount(document.createElement("div"), model.dimensions(), (c) => model.getCell(c));
  const disconnect = connectModelToView(model, view);
  const store = createStore();
  const interaction = createGridInteraction({ view, model, store, sheetId });
  return {
    doc,
    sheetId,
    engine,
    model,
    view,
    store,
    interaction,
    dispose() {
      interaction.dispose();
      disconnect();
      view.destroy();
      model.destroy();
      engine.destroy();
    },
  };
}
