import {
  customType,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({
  dataType: () => "bytea",
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workbookRole = pgEnum("workbook_role", ["owner", "editor", "viewer"]);

export const workbooks = pgTable("workbooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workbookMembers = pgTable(
  "workbook_members",
  {
    workbookId: uuid("workbook_id")
      .notNull()
      .references(() => workbooks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: workbookRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workbookId, table.userId] }),
    index("workbook_members_user_id_idx").on(table.userId),
  ],
);

export const yjsDocuments = pgTable("yjs_documents", {
  workbookId: uuid("workbook_id")
    .primaryKey()
    .references(() => workbooks.id, { onDelete: "cascade" }),
  state: bytea("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const yjsSnapshots = pgTable(
  "yjs_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workbookId: uuid("workbook_id")
      .notNull()
      .references(() => workbooks.id, { onDelete: "cascade" }),
    state: bytea("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("yjs_snapshots_workbook_id_idx").on(table.workbookId)],
);
