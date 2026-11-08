import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addSheet, deleteSheet, moveSheet, setSheetHidden } from "@worksheet-clone/shared";
import { newDoc } from "../../test-utils/workbook";
import { asRemote, renderWithWorkbook } from "../../test-utils/render-workbook";
import { useActiveSheet } from "./useActiveSheet";

afterEach(cleanup);

function Probe() {
  const { sheetId, openSheet } = useActiveSheet();
  return (
    <>
      <output data-testid="active">{sheetId ?? "none"}</output>
      <button onClick={() => sheetId && openSheet("second")}>go-second</button>
    </>
  );
}

function threeSheets() {
  const { doc, sheetId: a } = newDoc();
  let b = "";
  let c = "";
  doc.transact(() => {
    b = addSheet(doc, "B", { sheetId: "second" });
    c = addSheet(doc, "C");
  });
  return { doc, a, b, c };
}

const location = () => screen.getByTestId("location").textContent;
const active = () => screen.getByTestId("active").textContent;

describe("useActiveSheet", () => {
  it("shows the sheet named in the URL and leaves the URL alone", () => {
    const { doc, c } = threeSheets();
    renderWithWorkbook(<Probe />, { doc, route: `/workbooks/w1?sheet=${c}` });
    expect(active()).toBe(c);
    expect(location()).toBe(`/workbooks/w1?sheet=${c}`);
    expect(screen.getByTestId("nav-type")).toHaveTextContent("POP");
  });

  it("falls back to the first visible sheet and replaces the URL when it is missing or unknown", () => {
    const { doc, a } = threeSheets();
    renderWithWorkbook(<Probe />, { doc, route: "/workbooks/w1?sheet=nope&x=1" });
    expect(active()).toBe(a);
    expect(location()).toBe(`/workbooks/w1?sheet=${a}&x=1`);
    expect(screen.getByTestId("nav-type")).toHaveTextContent("REPLACE");
  });

  it("falls back from a hidden sheet", () => {
    const { doc, a, b } = threeSheets();
    doc.transact(() => setSheetHidden(doc, a, true));
    renderWithWorkbook(<Probe />, { doc, route: `/workbooks/w1?sheet=${a}` });
    expect(active()).toBe(b);
    expect(location()).toBe(`/workbooks/w1?sheet=${b}`);
  });

  it("openSheet replaces instead of pushing", () => {
    const { doc, a } = threeSheets();
    renderWithWorkbook(<Probe />, { doc, route: `/workbooks/w1?sheet=${a}` });
    fireEvent.click(screen.getByText("go-second"));
    expect(active()).toBe("second");
    expect(location()).toBe("/workbooks/w1?sheet=second");
    expect(screen.getByTestId("nav-type")).toHaveTextContent("REPLACE");
  });

  it("moves to the neighbour when a collaborator deletes the shown sheet", () => {
    const { doc, b, c } = threeSheets();
    renderWithWorkbook(<Probe />, { doc, route: `/workbooks/w1?sheet=${b}` });
    act(() => asRemote(doc, () => deleteSheet(doc, b)));
    expect(active()).toBe(c);
    expect(location()).toBe(`/workbooks/w1?sheet=${c}`);
  });

  it("moves to the nearest visible sheet when a collaborator hides it", () => {
    const { doc, b, c } = threeSheets();
    renderWithWorkbook(<Probe />, { doc, route: `/workbooks/w1?sheet=${c}` });
    act(() =>
      asRemote(doc, () => {
        setSheetHidden(doc, c, true);
      }),
    );
    expect(active()).toBe(b);
    expect(location()).toBe(`/workbooks/w1?sheet=${b}`);
  });

  it("uses the position after a reorder when picking the neighbour", () => {
    const { doc, a, b, c } = threeSheets();
    renderWithWorkbook(<Probe />, { doc, route: `/workbooks/w1?sheet=${b}` });
    act(() => asRemote(doc, () => moveSheet(doc, b, 0))); // b, a, c
    act(() => asRemote(doc, () => deleteSheet(doc, b)));
    expect(active()).toBe(a); // not c, which was b's neighbour before the move
    expect(c).not.toBe(a);
  });

  it("renders nothing until the document has a sheet", () => {
    const doc = new Y.Doc();
    renderWithWorkbook(<Probe />, { doc, route: "/workbooks/w1?sheet=x" });
    expect(active()).toBe("none");
    expect(location()).toBe("/workbooks/w1?sheet=x");
  });
});
