CREATE TABLE "connected_table" (
	"id" text PRIMARY KEY NOT NULL,
	"workbook_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"name" text NOT NULL,
	"sql" text NOT NULL,
	"table_id" text,
	"schedule" text,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"row_count" bigint,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connected_table" ADD CONSTRAINT "connected_table_workbook_id_workbook_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_table" ADD CONSTRAINT "connected_table_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connected_table_workbook_idx" ON "connected_table" USING btree ("workbook_id");--> statement-breakpoint
CREATE INDEX "connected_table_due_idx" ON "connected_table" USING btree ("next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_owner_name_idx" ON "connection" USING btree ("owner_id","name");