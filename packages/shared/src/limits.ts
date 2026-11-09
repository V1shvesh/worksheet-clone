// Size limits shared by the server (which enforces them) and the client (which
// can check before sending). Change them here; docs/operations.md explains each.
export const LIMITS = {
  /** Largest JSON body the REST API accepts (413 PAYLOAD_TOO_LARGE above it). */
  restBodyBytes: 64 * 1024,
  /** Largest single WebSocket message from a client; above it the socket closes with 1009. */
  wsMessageBytes: 2 * 1024 * 1024,
  /** Largest workbook document (Yjs state); growth beyond it closes the sender with 4413. */
  docBytes: 10 * 1024 * 1024,
  /** Same per-cell text limit as Excel and Google Sheets. */
  cellChars: 32_767,
} as const;

export type Limits = { -readonly [K in keyof typeof LIMITS]: number };
