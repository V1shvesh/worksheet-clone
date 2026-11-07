import { describe, expect, it } from "vitest";
import { parseCellInput, type ParsedCellInput } from "./parse-cell-input";

const value = (v: string | number | boolean): ParsedCellInput => ({ kind: "value", value: v });
const formula = (a1: string): ParsedCellInput => ({ kind: "formula", a1 });
const clear: ParsedCellInput = { kind: "clear" };

describe("parseCellInput", () => {
  it.each<[string, ParsedCellInput]>([
    ["", clear],
    ["   ", clear],
    ["\t\n", clear],
    ["=SUM(A1:A3)", formula("=SUM(A1:A3)")],
    ["  =A1+1 ", formula("=A1+1")],
    ["=", value("=")],
    ["'007", value("007")],
    ["'=x", value("=x")],
    ["'TRUE", value("TRUE")],
    ["'", clear],
    ["''x", value("'x")],
    [" 'x", value(" 'x")],
    ["TRUE", value(true)],
    ["true", value(true)],
    [" False ", value(false)],
    ["42", value(42)],
    ["-3.5", value(-3.5)],
    ["+7", value(7)],
    [" 12 ", value(12)],
    [".5", value(0.5)],
    ["5.", value(5)],
    ["1e3", value(1000)],
    ["2.5E-2", value(0.025)],
    ["007", value(7)],
    ["1/2", value("1/2")],
    ["1,000", value("1,000")],
    ["1e", value("1e")],
    ["0x10", value("0x10")],
    ["Infinity", value("Infinity")],
    ["NaN", value("NaN")],
    ["1e999", value("1e999")],
    ["hello world", value("hello world")],
    ["  padded text ", value("  padded text ")],
    ["TRUEISH", value("TRUEISH")],
  ])("%j", (raw, expected) => {
    expect(parseCellInput(raw)).toEqual(expected);
  });
});
