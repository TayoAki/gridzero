CREATE TABLE "tracked_table" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"workbook_id" text NOT NULL,
	"table_name" text NOT NULL,
	"key_column" text NOT NULL,
	"every_hours" integer,
	"next_run_at" timestamp with time zone,
	"last_version" integer,
	"last_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "input_table" ADD COLUMN "handoff" jsonb;--> statement-breakpoint
ALTER TABLE "input_table" ADD COLUMN "exported_version" integer;--> statement-breakpoint
ALTER TABLE "tracked_table" ADD CONSTRAINT "tracked_table_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_table" ADD CONSTRAINT "tracked_table_workbook_id_workbook_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_table_idx" ON "tracked_table" USING btree ("workbook_id","table_name");--> statement-breakpoint
CREATE INDEX "tracked_table_due_idx" ON "tracked_table" USING btree ("next_run_at");