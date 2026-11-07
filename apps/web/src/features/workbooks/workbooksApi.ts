import type { CreateWorkbookInput, WorkbookSummary } from "@worksheet-clone/shared";
import { api } from "../../app/api";

export const workbooksApi = api.injectEndpoints({
  endpoints: (builder) => ({
    listWorkbooks: builder.query<WorkbookSummary[], void>({
      query: () => "/workbooks",
      transformResponse: (response: { workbooks: WorkbookSummary[] }) => response.workbooks,
      providesTags: ["Workbooks"],
    }),
    getWorkbook: builder.query<WorkbookSummary, string>({
      query: (id) => `/workbooks/${id}`,
      transformResponse: (response: { workbook: WorkbookSummary }) => response.workbook,
      providesTags: (_result, _error, id) => [{ type: "Workbooks", id }],
    }),
    createWorkbook: builder.mutation<WorkbookSummary, CreateWorkbookInput>({
      query: (body) => ({ url: "/workbooks", method: "POST", body }),
      transformResponse: (response: { workbook: WorkbookSummary }) => response.workbook,
      invalidatesTags: ["Workbooks"],
    }),
    deleteWorkbook: builder.mutation<void, string>({
      query: (id) => ({ url: `/workbooks/${id}`, method: "DELETE" }),
      invalidatesTags: ["Workbooks"],
    }),
  }),
});

export const {
  useListWorkbooksQuery,
  useGetWorkbookQuery,
  useCreateWorkbookMutation,
  useDeleteWorkbookMutation,
} = workbooksApi;
