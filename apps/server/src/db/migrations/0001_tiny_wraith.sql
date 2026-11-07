CREATE TYPE "public"."workbook_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "workbook_members" (
	"workbook_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "workbook_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workbook_members_workbook_id_user_id_pk" PRIMARY KEY("workbook_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yjs_documents" (
	"workbook_id" uuid PRIMARY KEY NOT NULL,
	"state" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yjs_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workbook_id" uuid NOT NULL,
	"state" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workbook_members" ADD CONSTRAINT "workbook_members_workbook_id_workbooks_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workbook_members" ADD CONSTRAINT "workbook_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yjs_documents" ADD CONSTRAINT "yjs_documents_workbook_id_workbooks_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "yjs_snapshots" ADD CONSTRAINT "yjs_snapshots_workbook_id_workbooks_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workbook_members_user_id_idx" ON "workbook_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "yjs_snapshots_workbook_id_idx" ON "yjs_snapshots" USING btree ("workbook_id");