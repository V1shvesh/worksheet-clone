import { z } from "zod";

// Characters Excel and Google Sheets forbid in sheet names. They would also
// make formula text ambiguous (`:` and `!` are reference syntax).
const FORBIDDEN = /[[\]*?/\\:]/;

/**
 * A sheet name: trimmed, 1-100 characters, none of `[ ] * ? / \ :`, and no
 * leading or trailing apostrophe (an apostrophe would clash with quoted sheet
 * names in formulas). Uniqueness is checked against the document with
 * `isSheetNameTaken`, not here.
 */
export const sheetNameSchema = z
  .string()
  .trim()
  .min(1, "Sheet name can't be empty")
  .max(100, "Sheet name can be at most 100 characters")
  .refine((name) => !FORBIDDEN.test(name), {
    message: "Sheet name can't contain any of these characters: [ ] * ? / \\ :",
  })
  .refine((name) => !name.startsWith("'") && !name.endsWith("'"), {
    message: "Sheet name can't start or end with an apostrophe",
  });

export type SheetName = z.infer<typeof sheetNameSchema>;
