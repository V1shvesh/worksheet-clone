import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export interface Toast {
  id: number;
  message: string;
  /** Shown as a tooltip, e.g. the full email behind "@bob". */
  title?: string;
  createdAt: number;
}

export interface ToastsState {
  items: Toast[];
  nextId: number;
}

/** At most this many toasts exist at once; the oldest is dropped first. */
export const MAX_TOASTS = 3;

const initialState: ToastsState = { items: [], nextId: 1 };

// UI state only: transient notifications (who renamed what), never document data.
export const toastsSlice = createSlice({
  name: "toasts",
  initialState,
  reducers: {
    pushed: {
      reducer(
        state,
        action: PayloadAction<{ message: string; title?: string; createdAt: number }>,
      ) {
        state.items.push({ id: state.nextId, ...action.payload });
        state.nextId += 1;
        if (state.items.length > MAX_TOASTS) {
          state.items.splice(0, state.items.length - MAX_TOASTS);
        }
      },
      prepare(message: string, title?: string) {
        return { payload: { message, title, createdAt: Date.now() } };
      },
    },
    dismissed(state, action: PayloadAction<number>) {
      state.items = state.items.filter((toast) => toast.id !== action.payload);
    },
  },
});

export const toastsActions = toastsSlice.actions;
