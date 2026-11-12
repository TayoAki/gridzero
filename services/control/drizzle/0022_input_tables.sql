CREATE TABLE "input_row" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"key" text,
	"values" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "input_table" (
	"id" text PRIMARY KEY NOT NULL,
	"dashboard_id" text NOT NULL,
	"name" text NOT NULL,
	"columns" jsonb NOT NULL,
	"widget_id" text,
	"key_column" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "input_row" ADD CONSTRAINT "input_row_table_id_input_table_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."input_table"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_table" ADD CONSTRAINT "input_table_dashboard_id_dashboard_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboard"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_table" ADD CONSTRAINT "input_table_widget_id_widget_id_fk" FOREIGN KEY ("widget_id") REFERENCES "public"."widget"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "input_row_table_idx" ON "input_row" USING btree ("table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "input_row_key_idx" ON "input_row" USING btree ("table_id","key");--> statement-breakpoint
CREATE INDEX "input_table_dashboard_idx" ON "input_table" USING btree ("dashboard_id");