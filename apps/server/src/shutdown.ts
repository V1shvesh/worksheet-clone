export interface ShutdownLogger {
  info(message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

type SignalHandler = (signal: NodeJS.Signals) => void;
export interface SignalSource {
  on(signal: NodeJS.Signals, handler: SignalHandler): unknown;
  off(signal: NodeJS.Signals, handler: SignalHandler): unknown;
}

export interface ShutdownOptions {
  /** Stops accepting connections, flushes open documents, closes the HTTP server. */
  close: () => Promise<void>;
  /** Releases the database pool; runs after close() because flushing needs it. */
  closeDatabase: () => Promise<void>;
  log: ShutdownLogger;
  /** Test seams. */
  exit?: (code: number) => void;
  signals?: NodeJS.Signals[];
  /** Safety net: force exit if a clean shutdown hasn't finished by then. */
  maxMs?: number;
  process?: SignalSource;
}

/**
 * First SIGTERM/SIGINT: drain (close -> closeDatabase) then exit 0. A second
 * signal, or exceeding `maxMs`, forces exit 1 so a stuck shutdown can never
 * wedge a deploy. Returns a function that removes the handlers.
 */
export function installShutdownHandlers(options: ShutdownOptions): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  const target = options.process ?? process;
  let shuttingDown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      options.log.error({ signal }, "second shutdown signal: forcing exit");
      exit(1);
      return;
    }
    shuttingDown = true;
    options.log.info(`${signal} received: shutting down`);
    timer = setTimeout(() => {
      options.log.error({}, "shutdown took too long: forcing exit");
      exit(1);
    }, options.maxMs ?? 20_000);
    timer.unref();

    void (async () => {
      try {
        await options.close();
        await options.closeDatabase();
        clearTimeout(timer);
        exit(0);
      } catch (error) {
        options.log.error({ err: error }, "shutdown failed");
        exit(1);
      }
    })();
  };

  for (const signal of signals) target.on(signal, handler);
  return () => {
    clearTimeout(timer);
    for (const signal of signals) target.off(signal, handler);
  };
}
