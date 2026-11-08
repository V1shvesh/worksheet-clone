import { z } from "zod";

// Sent by the server as Hocuspocus stateless messages to every connection of a
// workbook. `by` always comes from the server-side connection/session, never
// from client input. Clients filter out notices about their own actions.
const noticeAuthorSchema = z.object({ userId: z.string(), email: z.string() });

export const collabNoticeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("workbookRenamed"),
    by: noticeAuthorSchema,
    from: z.string(),
    to: z.string(),
  }),
  z.object({
    type: z.literal("sheetRenamed"),
    by: noticeAuthorSchema,
    sheetId: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  // Server-wide state, not user actions, so no `by`: the server holds changes
  // it could not write to the database yet / the database accepted them again.
  z.object({ type: z.literal("saveFailing") }),
  z.object({ type: z.literal("saveRecovered") }),
]);
export type CollabNotice = z.infer<typeof collabNoticeSchema>;

/** Parses a stateless payload; returns undefined for anything that isn't a notice. Never throws. */
export function parseCollabNotice(payload: string): CollabNotice | undefined {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const result = collabNoticeSchema.safeParse(json);
  return result.success ? result.data : undefined;
}
