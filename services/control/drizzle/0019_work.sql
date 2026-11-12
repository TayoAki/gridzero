CREATE TABLE "data_check" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"workbook_id" text NOT NULL,
	"name" text NOT NULL,
	"sql" text NOT NULL,
	"definition_id" text,
	"every_minutes" integer,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_count" integer,
	"last_sample" jsonb,
	"last_error" text,
	"webhook" text,
	"issue_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ownership" (
	"object_kind" text NOT NULL,
	"object_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"set_by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"label" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"results" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"dashboard_id" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"taken_by" text,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cards" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_item" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"due" text,
	"created_by" text NOT NULL,
	"assignee_id" text,
	"object_kind" text,
	"object_id" text,
	"label" text DEFAULT '' NOT NULL,
	"acceptance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "alert" ADD COLUMN "webhook" text;--> statement-breakpoint
ALTER TABLE "connected_table" ADD COLUMN "expect_every_hours" integer;--> statement-breakpoint
ALTER TABLE "connected_table" ADD COLUMN "late_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connected_table" ADD COLUMN "late_note" text;--> statement-breakpoint
ALTER TABLE "data_check" ADD CONSTRAINT "data_check_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_check" ADD CONSTRAINT "data_check_workbook_id_workbook_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership" ADD CONSTRAINT "ownership_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshot" ADD CONSTRAINT "report_snapshot_dashboard_id_dashboard_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboard"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_check_workbook_idx" ON "data_check" USING btree ("workbook_id");--> statement-breakpoint
CREATE INDEX "data_check_due_idx" ON "data_check" USING btree ("next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ownership_object_idx" ON "ownership" USING btree ("object_kind","object_id");--> statement-breakpoint
CREATE INDEX "ownership_owner_idx" ON "ownership" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "release_source_idx" ON "release" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE INDEX "report_snapshot_dashboard_idx" ON "report_snapshot" USING btree ("dashboard_id","taken_at");--> statement-breakpoint
CREATE INDEX "work_item_assignee_idx" ON "work_item" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "work_item_creator_idx" ON "work_item" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "work_item_object_idx" ON "work_item" USING btree ("object_kind","object_id");