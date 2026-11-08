import type { Dispatch } from "@reduxjs/toolkit";
import { parseCollabNotice } from "@worksheet-clone/shared";
import { api } from "../app/api";
import { noticeToToast } from "../features/toasts/notices";
import { toastsActions } from "../features/toasts/toastsSlice";
import { collabActions } from "./collabSlice";

interface NoticeContext {
  workbookId: string;
  dispatch: Dispatch;
  /** Read at the time the notice arrives, so a late-loading /me still counts. */
  currentUserId: () => string | undefined;
}

/**
 * Handles one Hocuspocus stateless payload: shows a toast for other people's
 * renames, flips the save-failing flag on the server's save-state notices and, for a workbook rename, refreshes the cached workbook so the
 * header follows. Anything that isn't a valid notice is ignored.
 */
export function handleCollabNotice(payload: string, context: NoticeContext): void {
  const notice = parseCollabNotice(payload);
  if (!notice) return;
  // Save-state notices drive the header indicator only (no toast: a retry loop would spam).
  if (notice.type === "saveFailing") {
    context.dispatch(collabActions.saveFailed());
    return;
  }
  if (notice.type === "saveRecovered") {
    context.dispatch(collabActions.saveRecovered());
    return;
  }
  const toast = noticeToToast(notice, context.currentUserId());
  if (!toast) return;
  context.dispatch(toastsActions.pushed(toast.message, toast.title));
  if (notice.type === "workbookRenamed") {
    context.dispatch(
      api.util.invalidateTags([{ type: "Workbooks", id: context.workbookId }, "Workbooks"]),
    );
  }
}
