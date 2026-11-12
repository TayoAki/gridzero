CREATE TABLE "check_run" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"check_id" text NOT NULL,
	"workbook_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist" (
	"lens" text PRIMARY KEY NOT NULL,
	"items" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_done" (
	"user_id" text NOT NULL,
	"lens" text NOT NULL,
	"done" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_group_share" (
	"id" text PRIMARY KEY NOT NULL,
	"dashboard_id" text NOT NULL,
	"group_id" text NOT NULL,
	"limits" jsonb,
	"hide" jsonb,
	"mask" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deactivated_user" (
	"user_id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_member" (
	"group_id" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people_group" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_group_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "dashboard_share" ADD COLUMN "mask" jsonb;--> statement-breakpoint
ALTER TABLE "check_run" ADD CONSTRAINT "check_run_check_id_data_check_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."data_check"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_done" ADD CONSTRAINT "checklist_done_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_group_share" ADD CONSTRAINT "dashboard_group_share_dashboard_id_dashboard_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboard"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_group_share" ADD CONSTRAINT "dashboard_group_share_group_id_people_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."people_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deactivated_user" ADD CONSTRAINT "deactivated_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_group_id_people_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."people_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_run_workbook_idx" ON "check_run" USING btree ("workbook_id","at");--> statement-breakpoint
CREATE INDEX "check_run_check_idx" ON "check_run" USING btree ("check_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_done_idx" ON "checklist_done" USING btree ("user_id","lens");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_group_share_idx" ON "dashboard_group_share" USING btree ("dashboard_id","group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_member_idx" ON "group_member" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "group_member_user_idx" ON "group_member" USING btree ("user_id");