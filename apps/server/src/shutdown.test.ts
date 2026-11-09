import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installShutdownHandlers } from "./shutdown.js";

function setup(overrides: { close?: () => Promise<void>; maxMs?: number } = {}) {
  const emitter = new EventEmitter();
  const order: string[] = [];
  const exit = vi.fn();
  const log = { info: vi.fn(), error: vi.fn() };
  const remove = installShutdownHandlers({
    close:
      overrides.close ??
      (async () => {
        order.push("close");
      }),
    closeDatabase: async () => {
      order.push("closeDatabase");
    },
    log,
    exit,
    process: emitter,
    maxMs: overrides.maxMs,
  });
  return { emitter, order, exit, log, remove };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("installShutdownHandlers", () => {
  it("closes the app, then the database, then exits 0", async () => {
    const { emitter, order, exit } = setup();
    emitter.emit("SIGTERM", "SIGTERM");
    await settle();
    expect(order).toEqual(["close", "closeDatabase"]);
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("handles SIGINT too", async () => {
    const { emitter, exit } = setup();
    emitter.emit("SIGINT", "SIGINT");
    await settle();
    expect(exit.mock.calls).toEqual([[0]]);
  });

  it("forces exit 1 on a second signal while the first is still draining", async () => {
    let release!: () => void;
    const { emitter, exit, order } = setup({
      close: () => new Promise<void>((resolve) => (release = resolve)),
    });
    emitter.emit("SIGTERM", "SIGTERM");
    emitter.emit("SIGINT", "SIGINT");
    expect(exit.mock.calls).toEqual([[1]]);
    release();
    await settle();
    expect(order).toEqual(["closeDatabase"]);
  });

  it("exits 1 when closing fails", async () => {
    const { emitter, exit, log } = setup({ close: () => Promise.reject(new Error("boom")) });
    emitter.emit("SIGTERM", "SIGTERM");
    await settle();
    expect(exit.mock.calls).toEqual([[1]]);
    expect(log.error).toHaveBeenCalled();
  });

  it("forces exit 1 when draining takes longer than the bound", async () => {
    const { emitter, exit } = setup({ close: () => new Promise<void>(() => undefined), maxMs: 20 });
    emitter.emit("SIGTERM", "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it("removes its handlers", () => {
    const { emitter, remove } = setup();
    remove();
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });
});
