import { describe, expect, it } from "vitest";
import { createIdleMachine, IDLE_HIDDEN_MS, IDLE_INPUT_MS, IDLE_UNSYNCED_GRACE_MS } from "./idle";

const MIN = 60_000;
const T0 = 1_000_000;
const make = (visible = true) => createIdleMachine({ now: T0, visible });

describe("idle machine", () => {
  it("disconnects after the tab has been hidden for 5 minutes, and reconnects when visible", () => {
    const m = make();
    expect(m.visibilityChanged(false, T0 + MIN)).toBeNull();
    expect(m.nextCheckAt()).toBe(T0 + MIN + IDLE_HIDDEN_MS);
    expect(m.tick(T0 + MIN + IDLE_HIDDEN_MS - 1)).toBeNull();
    expect(m.tick(T0 + MIN + IDLE_HIDDEN_MS)).toBe("disconnect");
    expect(m.paused).toBe(true);
    expect(m.nextCheckAt()).toBeNull();
    expect(m.visibilityChanged(true, T0 + 20 * MIN)).toBe("connect");
    expect(m.paused).toBe(false);
  });

  it("a short hide does not count: coming back resets the clock", () => {
    const m = make();
    m.visibilityChanged(false, T0);
    expect(m.visibilityChanged(true, T0 + 4 * MIN)).toBeNull();
    m.visibilityChanged(false, T0 + 5 * MIN);
    expect(m.tick(T0 + 9 * MIN)).toBeNull(); // 4 min into the second hide
    expect(m.tick(T0 + 10 * MIN)).toBe("disconnect");
  });

  it("disconnects a visible tab after 30 minutes without input, and input reconnects", () => {
    const m = make();
    expect(m.input(T0 + 10 * MIN)).toBeNull();
    expect(m.nextCheckAt()).toBe(T0 + 10 * MIN + IDLE_INPUT_MS);
    expect(m.tick(T0 + 40 * MIN)).toBe("disconnect");
    expect(m.input(T0 + 50 * MIN)).toBe("connect");
    expect(m.paused).toBe(false);
    expect(m.nextCheckAt()).toBe(T0 + 50 * MIN + IDLE_INPUT_MS);
  });

  it("starts hidden: the hidden rule applies from the start", () => {
    const m = make(false);
    expect(m.tick(T0 + IDLE_HIDDEN_MS)).toBe("disconnect");
  });

  it("waits for unconfirmed changes, then disconnects as soon as they are confirmed", () => {
    const m = make();
    m.visibilityChanged(false, T0);
    m.unsyncedChanged(2, T0 + MIN);
    expect(m.tick(T0 + 5 * MIN)).toBeNull();
    expect(m.nextCheckAt()).toBe(T0 + 5 * MIN + IDLE_UNSYNCED_GRACE_MS);
    expect(m.unsyncedChanged(0, T0 + 6 * MIN)).toBe("disconnect");
  });

  it("disconnects anyway when changes stay unconfirmed past the grace period", () => {
    const m = make();
    m.visibilityChanged(false, T0);
    m.unsyncedChanged(1, T0);
    expect(m.tick(T0 + IDLE_HIDDEN_MS)).toBeNull();
    expect(m.tick(T0 + IDLE_HIDDEN_MS + IDLE_UNSYNCED_GRACE_MS - 1)).toBeNull();
    expect(m.tick(T0 + IDLE_HIDDEN_MS + IDLE_UNSYNCED_GRACE_MS)).toBe("disconnect");
  });

  it("returning during the grace period cancels the pending disconnect", () => {
    const m = make();
    m.visibilityChanged(false, T0);
    m.unsyncedChanged(1, T0);
    m.tick(T0 + IDLE_HIDDEN_MS);
    expect(m.visibilityChanged(true, T0 + IDLE_HIDDEN_MS + MIN)).toBeNull();
    expect(m.paused).toBe(false);
    expect(m.tick(T0 + IDLE_HIDDEN_MS + 10 * MIN)).toBeNull();
  });

  it("never disconnects while ineligible (access lost, provider reconnecting), then does once eligible", () => {
    const m = make();
    m.eligibleChanged(false, T0);
    m.visibilityChanged(false, T0);
    expect(m.tick(T0 + 20 * MIN)).toBeNull();
    expect(m.nextCheckAt()).toBeNull();
    expect(m.eligibleChanged(true, T0 + 21 * MIN)).toBe("disconnect");
  });

  it("the online event resumes a paused connection and does nothing otherwise", () => {
    const m = make();
    expect(m.online(T0)).toBeNull();
    m.visibilityChanged(false, T0);
    m.tick(T0 + IDLE_HIDDEN_MS);
    expect(m.online(T0 + 6 * MIN)).toBe("connect");
    expect(m.online(T0 + 7 * MIN)).toBeNull();
  });
});
