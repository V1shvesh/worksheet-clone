/**
 * Idle disconnect: a tab that is left open keeps its collaboration socket (and the server's pings)
 * alive, so a Railway container that should sleep after ~10 minutes of silence never does. The
 * client therefore hangs up when the user is away and reconnects when they come back.
 *
 * This module is the pure decision logic (no DOM, no timers, no provider): callers feed it events
 * with a timestamp and act on the returned decision. The wiring is in `idleDisconnect.ts`.
 */

/** A tab that has been hidden this long without a break disconnects. */
export const IDLE_HIDDEN_MS = 5 * 60_000;
/** A visible tab with no user input for this long disconnects. */
export const IDLE_INPUT_MS = 30 * 60_000;
/**
 * Unconfirmed changes delay a disconnect until the server confirms them; if they are still
 * unconfirmed this long after the disconnect was due (a stuck save), disconnect anyway: the
 * on-device copy holds them.
 */
export const IDLE_UNSYNCED_GRACE_MS = 2 * 60_000;

export type IdleDecision = "disconnect" | "connect" | null;

export interface IdleThresholds {
  hiddenMs: number;
  inputMs: number;
  unsyncedGraceMs: number;
}

export const DEFAULT_IDLE_THRESHOLDS: IdleThresholds = {
  hiddenMs: IDLE_HIDDEN_MS,
  inputMs: IDLE_INPUT_MS,
  unsyncedGraceMs: IDLE_UNSYNCED_GRACE_MS,
};

export interface IdleMachine {
  /** True from a "disconnect" decision until a "connect" decision. */
  readonly paused: boolean;
  /** The tab became visible or hidden. */
  visibilityChanged(visible: boolean, now: number): IdleDecision;
  /** Any user input (pointer, key, wheel, touch). */
  input(now: number): IdleDecision;
  /** The provider's count of unconfirmed local changes. */
  unsyncedChanged(count: number, now: number): IdleDecision;
  /**
   * Whether an idle disconnect is allowed right now: false while the socket is not connected (the
   * provider is connecting or retrying on its own) or after access was lost.
   */
  eligibleChanged(eligible: boolean, now: number): IdleDecision;
  /** The browser came back online: resumes a paused connection. */
  online(now: number): IdleDecision;
  /** Call when the time returned by `nextCheckAt` has been reached. */
  tick(now: number): IdleDecision;
  /** When to call `tick` next (epoch ms), or null when nothing is pending. */
  nextCheckAt(): number | null;
}

export function createIdleMachine(
  start: { now: number; visible: boolean },
  thresholds: IdleThresholds = DEFAULT_IDLE_THRESHOLDS,
): IdleMachine {
  let paused = false;
  let visible = start.visible;
  let hiddenSince = start.visible ? null : start.now;
  let lastInput = start.now;
  let unsynced = 0;
  let eligible = true;
  // When the disconnect first became due while changes were unconfirmed.
  let waitingSince: number | null = null;

  /** When the user counts as away (the disconnect is due), by whichever rule applies. */
  const dueAt = (): number =>
    visible ? lastInput + thresholds.inputMs : (hiddenSince ?? lastInput) + thresholds.hiddenMs;

  const resume = (now: number): IdleDecision => {
    if (!paused) return null;
    paused = false;
    lastInput = now;
    // Input or a network return while the tab still counts as hidden restarts the hidden clock.
    if (!visible) hiddenSince = now;
    waitingSince = null;
    return "connect";
  };

  const evaluate = (now: number): IdleDecision => {
    if (paused || !eligible) return null;
    if (now < dueAt()) {
      waitingSince = null;
      return null;
    }
    if (unsynced > 0) {
      waitingSince ??= Math.max(now, dueAt());
      if (now < waitingSince + thresholds.unsyncedGraceMs) return null;
    }
    paused = true;
    waitingSince = null;
    return "disconnect";
  };

  return {
    get paused() {
      return paused;
    },
    visibilityChanged(nowVisible, now) {
      if (nowVisible === visible) return evaluate(now);
      visible = nowVisible;
      waitingSince = null;
      if (nowVisible) {
        hiddenSince = null;
        lastInput = now;
        return resume(now) ?? evaluate(now);
      }
      hiddenSince = now;
      return evaluate(now);
    },
    input(now) {
      lastInput = now;
      waitingSince = null;
      return resume(now) ?? evaluate(now);
    },
    unsyncedChanged(count, now) {
      unsynced = count;
      return evaluate(now);
    },
    eligibleChanged(next, now) {
      eligible = next;
      return evaluate(now);
    },
    online: (now) => resume(now),
    tick: (now) => evaluate(now),
    nextCheckAt() {
      if (paused || !eligible) return null;
      const due = dueAt();
      if (unsynced > 0 && waitingSince !== null) return waitingSince + thresholds.unsyncedGraceMs;
      return due;
    },
  };
}
