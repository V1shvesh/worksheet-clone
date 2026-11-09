import type { Store } from "@reduxjs/toolkit";
import type { RootState } from "../app/store";
import { collabActions } from "./collabSlice";
import { createIdleMachine, type IdleDecision, type IdleThresholds } from "./idle";

/** The part of the provider this needs (the real HocuspocusProvider satisfies it). */
export interface IdleProvider {
  connect(): unknown;
  disconnect(): unknown;
}

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
/** Input listeners do real work at most this often while connected (a mouse move fires hundreds of events a second). */
const INPUT_THROTTLE_MS = 1000;

/**
 * Connects the pure idle machine (see `idle.ts`) to the page: tab visibility, user input, the
 * browser's online event, the provider and the `collab` slice. Returns a function that removes it.
 *
 * Disconnecting uses `provider.disconnect()`, not destroy: the doc, the on-device copy and the
 * awareness object stay, edits made while paused are kept, and `provider.connect()` later runs the
 * normal start-up handshake (state vectors, so those edits reach the server, and the local
 * presence state is re-sent).
 */
export function startIdleDisconnect(options: {
  provider: IdleProvider;
  store: Pick<Store<RootState>, "getState" | "subscribe" | "dispatch">;
  thresholds?: IdleThresholds;
  now?: () => number;
}): () => void {
  const { provider, store, thresholds } = options;
  const now = options.now ?? Date.now;
  const machine = createIdleMachine(
    { now: now(), visible: document.visibilityState !== "hidden" },
    thresholds,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;

  const act = (decision: IdleDecision) => {
    if (decision === "disconnect") {
      store.dispatch(collabActions.pausedChanged(true));
      provider.disconnect();
    } else if (decision === "connect") {
      store.dispatch(collabActions.pausedChanged(false));
      void provider.connect();
    }
    schedule();
  };
  const schedule = () => {
    clearTimeout(timer);
    const at = machine.nextCheckAt();
    if (at !== null) timer = setTimeout(() => act(machine.tick(now())), Math.max(0, at - now()));
  };

  // Only a live, healthy connection may be hung up; one that is retrying or was refused is left to
  // the provider and the access-loss handling.
  const read = () => {
    const { status, access, accessLoss, unsyncedChanges } = store.getState().collab;
    return {
      eligible: status === "connected" && access !== "denied" && accessLoss === null,
      // A read-only connection's counter may stay above 0 when the server dropped our edits.
      unsynced: access === "read-only" ? 0 : unsyncedChanges,
    };
  };
  let last = read();
  act(machine.eligibleChanged(last.eligible, now()));
  act(machine.unsyncedChanged(last.unsynced, now()));
  const unsubscribe = store.subscribe(() => {
    const next = read();
    if (next.eligible !== last.eligible) act(machine.eligibleChanged(next.eligible, now()));
    if (next.unsynced !== last.unsynced) act(machine.unsyncedChanged(next.unsynced, now()));
    last = next;
  });

  const onVisibility = () =>
    act(machine.visibilityChanged(document.visibilityState !== "hidden", now()));
  let lastInputAt = Number.NEGATIVE_INFINITY;
  const onInput = () => {
    const t = now();
    if (!machine.paused && t - lastInputAt < INPUT_THROTTLE_MS) return;
    lastInputAt = t;
    act(machine.input(t));
  };
  const onOnline = () => act(machine.online(now()));
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  for (const type of INPUT_EVENTS) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }

  return () => {
    clearTimeout(timer);
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, { capture: true });
  };
}
