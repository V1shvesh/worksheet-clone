/**
 * True when the `Origin` header names the host the request was sent to. Pages
 * cannot forge Origin, and comparing it to Host needs no configuration (it relies on
 * the proxy forwarding the public Host unchanged). "null" or a malformed origin
 * never matches. Shared by the WebSocket upgrade and the REST CSRF check.
 */
export function originMatchesHost(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
