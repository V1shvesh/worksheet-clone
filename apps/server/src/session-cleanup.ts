import type { FastifyInstance } from "fastify";
import { deleteExpiredSessions } from "./domain/auth.js";

export const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Deletes expired sessions now and then every hour while the server runs.
 * An expired session is otherwise only removed if its owner presents it again,
 * so abandoned logins would pile up. The timer is unref'd (never keeps the
 * process alive, never wakes a sleeping one) and cleared when the app closes.
 * A failure is logged and retried at the next tick; it never reaches the caller.
 */
export function scheduleSessionCleanup(
  app: FastifyInstance,
  options: { intervalMs?: number; run?: () => Promise<number> } = {},
): void {
  const run = options.run ?? (() => deleteExpiredSessions());
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const deleted = await run();
      if (deleted > 0) app.log.info({ deleted }, "deleted expired sessions");
    } catch (error) {
      app.log.warn({ err: error }, "deleting expired sessions failed; will retry next hour");
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs ?? SESSION_CLEANUP_INTERVAL_MS);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}
