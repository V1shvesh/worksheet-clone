import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  parseClipboardHtml,
  serializeClipboardHtml,
  type ClipboardPayload,
} from "./clipboard-html";

const payload: Omit<ClipboardPayload, "v"> = {
  source: { sheetId: "s1", row: 2, col: 3 },
  cut: false,
  cells: [
    [{ input: "=A1*2", format: { bg: "#ff0", b: true } }, null],
    [{ input: 'He said "<b>hi</b>" & left\nline' }, { input: "7" }],
  ],
};

const display = [
  ["14", ""],
  ['He said "<b>hi</b>" & left\nline', "7"],
];
const html = (p: Omit<ClipboardPayload, "v"> = payload, d: string[][] = display) =>
  serializeClipboardHtml({ ...p, display: d });

describe("clipboard html", () => {
  it("round-trips the payload", () => {
    expect(parseClipboardHtml(html())).toEqual({ v: 1, ...payload });
  });
  it("round-trips arbitrary input text", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), fc.boolean(), (input, cut) => {
        const p = { ...payload, cut, cells: [[{ input }]] };
        expect(parseClipboardHtml(html(p, [[input]]))?.cells).toEqual(p.cells);
      }),
    );
  });
  it("shows displayed values, not formulas, in the visible cells", () => {
    const out = html();
    const visible = out.slice(out.indexOf("<tbody>"));
    expect(visible).toContain("<td>14</td>");
    expect(visible).not.toContain("=A1*2");
    expect(visible).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(visible).toContain("<br>");
    expect(visible).toContain("<td></td>");
    // the raw input still travels in the JSON attribute
    expect(parseClipboardHtml(out)?.cells[0]?.[0]?.input).toBe("=A1*2");
  });
  it("survives the browser's paste wrapper", () => {
    const wrapped = `<html><body><!--StartFragment-->${html()}<!--EndFragment--></body></html>`;
    expect(parseClipboardHtml(wrapped)?.cells).toEqual(payload.cells);
  });
  it("returns undefined for foreign or broken html without throwing", () => {
    expect(parseClipboardHtml("")).toBeUndefined();
    expect(parseClipboardHtml("<table><tr><td>1</td></tr></table>")).toBeUndefined();
    expect(parseClipboardHtml('<table data-worksheet-clip="{nope"></table>')).toBeUndefined();
    expect(
      parseClipboardHtml('<table data-worksheet-clip="{&quot;v&quot;:2}"></table>'),
    ).toBeUndefined();
    expect(
      parseClipboardHtml(
        '<table data-worksheet-clip="{&quot;v&quot;:1,&quot;cut&quot;:false,&quot;cells&quot;:[[{&quot;input&quot;:5}]],&quot;source&quot;:{&quot;sheetId&quot;:&quot;s&quot;,&quot;row&quot;:0,&quot;col&quot;:0}}"></table>',
      ),
    ).toBeUndefined();
    expect(parseClipboardHtml('<table data-worksheet-clip="null"></table>')).toBeUndefined();
  });
});
