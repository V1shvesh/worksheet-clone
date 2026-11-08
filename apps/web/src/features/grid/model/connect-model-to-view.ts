import type { GridView } from "../port";
import type { SheetViewModel } from "./sheet-view-model";

/** Pushes model changes into the grid; returns a disconnect function. */
export function connectModelToView(model: SheetViewModel, view: GridView): () => void {
  return model.subscribe((event) => {
    if (event.type === "cells") {
      view.refreshCells(event.cells);
    } else if (event.type === "dimensions") {
      view.setDimensions(model.dimensions());
      view.refreshCells("all");
    }
  });
}
