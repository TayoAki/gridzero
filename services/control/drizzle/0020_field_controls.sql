CREATE TABLE "sensitive_field" (
	"workbook_id" text NOT NULL,
	"table_name" text NOT NULL,
	"column_name" text NOT NULL,
	"marked_by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboard" ADD COLUMN "min_group" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_share" ADD COLUMN "hide" jsonb;--> statement-breakpoint
ALTER TABLE "sensitive_field" ADD CONSTRAINT "sensitive_field_workbook_id_workbook_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sensitive_field_idx" ON "sensitive_field" USING btree ("workbook_id","table_name","column_name");