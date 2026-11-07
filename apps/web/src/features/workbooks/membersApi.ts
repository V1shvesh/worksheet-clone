import type { AddMemberInput, AssignableRole, Member } from "@worksheet-clone/shared";
import { api } from "../../app/api";

const membersTag = (workbookId: string) => [{ type: "Members" as const, id: workbookId }];

export const membersApi = api.injectEndpoints({
  endpoints: (builder) => ({
    listMembers: builder.query<Member[], string>({
      query: (workbookId) => `/workbooks/${workbookId}/members`,
      transformResponse: (response: { members: Member[] }) => response.members,
      providesTags: (_result, _error, workbookId) => membersTag(workbookId),
    }),
    addMember: builder.mutation<Member, AddMemberInput & { workbookId: string }>({
      query: ({ workbookId, ...body }) => ({
        url: `/workbooks/${workbookId}/members`,
        method: "POST",
        body,
      }),
      transformResponse: (response: { member: Member }) => response.member,
      invalidatesTags: (_result, _error, { workbookId }) => membersTag(workbookId),
    }),
    changeMemberRole: builder.mutation<
      Member,
      { workbookId: string; userId: string; role: AssignableRole }
    >({
      query: ({ workbookId, userId, role }) => ({
        url: `/workbooks/${workbookId}/members/${userId}`,
        method: "PATCH",
        body: { role },
      }),
      transformResponse: (response: { member: Member }) => response.member,
      invalidatesTags: (_result, _error, { workbookId }) => membersTag(workbookId),
    }),
    removeMember: builder.mutation<void, { workbookId: string; userId: string }>({
      query: ({ workbookId, userId }) => ({
        url: `/workbooks/${workbookId}/members/${userId}`,
        method: "DELETE",
      }),
      invalidatesTags: (_result, _error, { workbookId }) => membersTag(workbookId),
    }),
  }),
});

export const {
  useListMembersQuery,
  useAddMemberMutation,
  useChangeMemberRoleMutation,
  useRemoveMemberMutation,
} = membersApi;
