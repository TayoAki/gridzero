CREATE TABLE "experiment_run" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"workbook_id" text NOT NULL,
	"name" text NOT NULL,
	"tracked_id" text,
	"data_version" integer,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notebook" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"workbook_id" text NOT NULL,
	"title" text NOT NULL,
	"cells" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "term" (
	"id" text PRIMARY KEY NOT NULL,
	"workbook_id" text NOT NULL,
	"kind" text DEFAULT 'event' NOT NULL,
	"name" text NOT NULL,
	"meaning" text DEFAULT '' NOT NULL,
	"table_name" text NOT NULL,
	"condition" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_asset" ADD COLUMN "monitor" jsonb;--> statement-breakpoint
ALTER TABLE "model_asset" ADD COLUMN "baseline" jsonb;--> statement-breakpoint
ALTER TABLE "model_asset" ADD COLUMN "health" jsonb;--> statement-breakpoint
ALTER TABLE "experiment_run" ADD CONSTRAINT "experiment_run_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_run" ADD CONSTRAINT "experiment_run_workbook_id_workbook_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook" ADD CONSTRAINT "notebook_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notebook" ADD CONSTRAINT "notebook_workbook_id_workbook_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term" ADD CONSTRAINT "term_workbook_id_workbook_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "experiment_run_workbook_idx" ON "experiment_run" USING btree ("workbook_id","created_at");--> statement-breakpoint
CREATE INDEX "notebook_workbook_idx" ON "notebook" USING btree ("workbook_id");--> statement-breakpoint
CREATE UNIQUE INDEX "term_name_idx" ON "term" USING btree ("workbook_id","name");