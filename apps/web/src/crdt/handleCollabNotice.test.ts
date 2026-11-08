import { describe, expect, it, vi } from "vitest";
import { handleCollabNotice } from "./handleCollabNotice";

const book = JSON.stringify({
  type: "workbookRenamed",
  by: { userId: "u2", email: "bob@x.com" },
  from: "Q3",
  to: "Q4",
});

function run(payload: string, userId: string | undefined = "u1") {
  const dispatch = vi.fn();
  handleCollabNotice(payload, { workbookId: "wb", dispatch, currentUserId: () => userId });
  return dispatch;
}

describe("handleCollabNotice", () => {
  it("toasts and invalidates the workbook on someone else's workbook rename", () => {
    const dispatch = run(book);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "toasts/pushed",
      payload: { message: '@bob renamed the workbook "Q3" to "Q4"', title: "bob@x.com" },
    });
    expect(JSON.stringify(dispatch.mock.calls[1]?.[0])).toContain("api/invalidateTags");
  });

  it("does nothing for the user's own rename or garbage", () => {
    expect(run(book, "u2")).not.toHaveBeenCalled();
    expect(run("{")).not.toHaveBeenCalled();
    expect(run('{"type":"x"}')).not.toHaveBeenCalled();
  });

  it("flips the save-failing flag without a toast", () => {
    const failing = run('{"type":"saveFailing"}');
    expect(failing.mock.calls).toEqual([[{ type: "collab/saveFailed", payload: undefined }]]);
    const recovered = run('{"type":"saveRecovered"}');
    expect(recovered.mock.calls).toEqual([[{ type: "collab/saveRecovered", payload: undefined }]]);
  });
});
