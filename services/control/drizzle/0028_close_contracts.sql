CREATE TABLE "contract" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor" text NOT NULL,
	"product" text DEFAULT '' NOT NULL,
	"seats" integer,
	"counts_here" boolean DEFAULT false NOT NULL,
	"yearly_cost" double precision,
	"renews_on" text,
	"owner" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"reminded" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "period_close" (
	"id" text PRIMARY KEY NOT NULL,
	"workbook_id" text NOT NULL,
	"period" text NOT NULL,
	"closed_by" text NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"snapshots" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_run" DROP CONSTRAINT "check_run_check_id_data_check_id_fk";
--> statement-breakpoint
ALTER TABLE "check_run" ALTER COLUMN "check_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "check_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "notebook" ADD COLUMN "every_hours" integer;--> statement-breakpoint
ALTER TABLE "notebook" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notebook" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notebook" ADD COLUMN "last_status" text;--> statement-breakpoint
ALTER TABLE "notebook" ADD COLUMN "last_output" text;--> statement-breakpoint
ALTER TABLE "notebook" ADD COLUMN "outputs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notebook" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "period_close" ADD CONSTRAINT "period_close_workbook_id_workbook_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_close" ADD CONSTRAINT "period_close_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "period_close_idx" ON "period_close" USING btree ("workbook_id","period");--> statement-breakpoint
ALTER TABLE "check_run" ADD CONSTRAINT "check_run_check_id_data_check_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."data_check"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "check_run" SET "check_name" = d."name" FROM "data_check" d WHERE d."id" = "check_run"."check_id" AND "check_run"."check_name" = '';
