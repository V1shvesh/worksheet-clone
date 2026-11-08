// Test-only page, served by the Vite dev server (never part of the production build).
// It runs the runner-agnostic GridView contract in a real browser against AgGridView.
// Real input is produced by calling back into Playwright (page.mouse / page.keyboard).
import { AgGridView } from "../../src/features/grid/adapters/ag-grid/ag-grid-view";
import {
  gridViewContract,
  type ContractContext,
  type ContractGrid,
} from "../../src/features/grid/port/contract";

declare global {
  interface Window {
    __contract: {
      listCases(): string[];
      runCase(name: string): Promise<void>;
    };
    __demo: {
      mount(): void;
      events: unknown[][];
    };
    // Exposed by the Playwright spec via page.exposeFunction.
    __mouseClick(clientX: number, clientY: number): Promise<void>;
    __keyPress(key: string): Promise<void>;
  }
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const ctx: ContractContext = {
  create({ dims, getCell, viewport }) {
    const container = document.createElement("div");
    // Offset from the page origin so viewport-relative and client coordinates differ.
    container.style.cssText = `position:absolute;left:40px;top:30px;width:${viewport.width}px;height:${viewport.height}px`;
    document.body.appendChild(container);
    const view = new AgGridView();
    view.mount(container, dims, getCell);

    const grid: ContractGrid = {
      view,
      displayedText(c) {
        const el = container.querySelector(`[data-row="${c.row}"][data-col="${c.col}"]`);
        return el ? el.textContent : null;
      },
      async scrollTo(x, y) {
        const viewport = container.querySelector<HTMLElement>(".ag-grid-viewport")!;
        viewport.scrollTop = y;
        viewport.scrollLeft = x;
        await nextFrame();
        await nextFrame();
      },
      async click(c) {
        const r = view.getCellRect(c);
        if (!r) throw new Error("click target not visible");
        const { clientX, clientY } = grid.viewportToClient(r.x + r.width / 2, r.y + r.height / 2);
        await window.__mouseClick(clientX, clientY);
      },
      pressKey: (key) => window.__keyPress(key),
      viewportToClient(x, y) {
        const origin = container.getBoundingClientRect();
        return { clientX: origin.left + x, clientY: origin.top + y };
      },
      dispose() {
        try {
          view.destroy();
        } catch {
          // already destroyed by the case under test
        }
        container.remove();
      },
    };
    return grid;
  },
};

window.__contract = {
  listCases: () => gridViewContract.map((c) => c.name),
  async runCase(name) {
    const found = gridViewContract.find((c) => c.name === name);
    if (!found) throw new Error(`unknown contract case: ${name}`);
    await found.run(ctx);
  },
};

// A standalone grid for the behavior spec: gestures, attributes and key handling.
window.__demo = {
  events: [],
  mount() {
    const el = document.createElement("div");
    el.id = "grid";
    el.style.cssText = "position:absolute;left:40px;top:30px;width:400px;height:300px";
    document.body.appendChild(el);
    const view = new AgGridView();
    for (const name of [
      "columnMoveRequested",
      "columnResized",
      "rowResized",
      "contextMenu",
      "doubleClick",
    ] as const) {
      view.on(name, ((...args: unknown[]) => window.__demo.events.push([name, ...args])) as never);
    }
    view.mount(
      el,
      {
        rowCount: 100,
        colCount: 30,
        rowHeight: () => 24,
        colWidth: () => 80,
        colLabel: (c) => `C${c}`,
      },
      (c) => ({
        text: `r${c.row}c${c.col}`,
        format: c.row === 0 ? { bg: "#ffff00", b: true, i: true, u: true } : undefined,
        error: c.row === 1,
      }),
    );
  },
};
