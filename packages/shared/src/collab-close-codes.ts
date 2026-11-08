// WebSocket close codes the collaboration server sends (4000-4999 is the
// application range). Clients map them to banners and reconnect behavior.
export const COLLAB_CLOSE_CODES = {
  // Role changed or access removed. Matches Hocuspocus's own ResetConnection
  // code (4205, not exported by @hocuspocus/server): the provider reconnects
  // and onAuthenticate decides afresh.
  accessChanged: 4205,
  // Reserved for the document size cap (M9); not sent yet.
  tooLarge: 4413,
} as const;

export const COLLAB_CLOSE_REASONS = {
  accessChanged: "access-changed",
  // Same code, sent when the workbook itself was deleted: a refused reconnect alone
  // can't tell the client "deleted" from "removed" (non-members get 404 either way).
  workbookDeleted: "workbook-deleted",
  tooLarge: "too-large",
} as const;

export type CollabCloseKey = keyof typeof COLLAB_CLOSE_CODES;
