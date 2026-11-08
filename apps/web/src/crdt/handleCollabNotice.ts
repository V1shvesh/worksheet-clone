import type { Dispatch } from "@reduxjs/toolkit";
import { parseCollabNotice } from "@worksheet-clone/shared";
import { api } from "../app/api";
import { noticeToToast } from "../features/toasts/notices";
import { toastsActions } from "../features/toasts/toastsSlice";

interface NoticeContext {
  workbookId: string;
  dispatch: Dispatch;
  /** Read at the time the notice arrives, so a late-loading /me still counts. */
  currentUserId: () => string | undefined;
}

/**
 * Handles one Hocuspocus stateless payload: shows a toast for other people's
 * renames and, for a workbook rename, refreshes the cached workbook so the
 * header follows. Anything that isn't a valid notice is ignored.
 */
export function handleCollabNotice(payload: string, context: NoticeContext): void {
  const notice = parseCollabNotice(payload);
  if (!notice) return;
  const toast = noticeToToast(notice, context.currentUserId());
  if (!toast) return;
  context.dispatch(toastsActions.pushed(toast.message, toast.title));
  if (notice.type === "workbookRenamed") {
    context.dispatch(
      api.util.invalidateTags([{ type: "Workbooks", id: context.workbookId }, "Workbooks"]),
    );
  }
}
