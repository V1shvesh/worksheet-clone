import { createApi } from "@reduxjs/toolkit/query/react";
import { baseQuery } from "./baseQuery";

// One API slice for all REST calls so features share a cache and can
// invalidate each other's data via tags; features attach endpoints with
// api.injectEndpoints.
export const api = createApi({
  reducerPath: "api",
  baseQuery,
  tagTypes: ["Workbooks", "Members"],
  endpoints: () => ({}),
});
