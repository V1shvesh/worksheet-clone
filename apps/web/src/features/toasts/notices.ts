import type { CollabNotice } from "@worksheet-clone/shared";

export interface NoticeToast {
  message: string;
  /** The author's full email, for a tooltip. */
  title: string;
}

/** What to show for a notice, or undefined when it describes the signed-in user's own action. */
export function noticeToToast(
  notice: CollabNotice,
  currentUserId: string | undefined,
): NoticeToast | undefined {
  if (notice.by.userId === currentUserId) return undefined;
  const handle = `@${notice.by.email.split("@")[0] ?? notice.by.email}`;
  const message =
    notice.type === "sheetRenamed"
      ? `${handle} renamed sheet "${notice.from}" to "${notice.to}"`
      : `${handle} renamed the workbook "${notice.from}" to "${notice.to}"`;
  return { message, title: notice.by.email };
}
