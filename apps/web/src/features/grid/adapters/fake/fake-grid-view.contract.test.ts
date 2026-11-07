import { describe, it } from "vitest";
import { gridViewContract, type ContractContext, type ContractGrid } from "../../port/contract";
import { FakeGridView } from "./fake-grid-view";

const ctx: ContractContext = {
  create({ dims, getCell, viewport }) {
    const view = new FakeGridView({
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    });
    view.mount(document.createElement("div"), dims, getCell);
    const grid: ContractGrid = {
      view,
      displayedText: (c) => view.displayedText(c),
      scrollTo: (x, y) => view.scrollTo(x, y),
      click(c) {
        const r = view.getCellRect(c);
        if (!r) throw new Error("click target not visible");
        const info = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
        view.pointerDown(c, info);
        view.pointerUp(c, info);
      },
      pressKey: (key) => view.keyDown({ key }),
      viewportToClient: (x, y) => ({ clientX: x, clientY: y }),
      dispose() {
        try {
          view.destroy();
        } catch {
          // already destroyed by the case under test
        }
      },
    };
    return grid;
  },
};

describe("FakeGridView passes the GridView port contract", () => {
  for (const c of gridViewContract) {
    it(c.name, () => c.run(ctx));
  }
});
