import { configureStore } from "@reduxjs/toolkit";
import { collabSlice } from "../crdt/collabSlice";
import { gridSlice } from "../features/grid/gridSlice";
import { api } from "./api";

export function createStore() {
  return configureStore({
    reducer: {
      [api.reducerPath]: api.reducer,
      [collabSlice.name]: collabSlice.reducer,
      [gridSlice.name]: gridSlice.reducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(api.middleware),
  });
}

export const store = createStore();

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
