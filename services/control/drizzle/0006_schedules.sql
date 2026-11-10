CREATE TABLE "schedule" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" text,
	"widget_id" text,
	"kind" text NOT NULL,
	"prompt" text,
	"cron" text NOT NULL,
	"label" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_widget_id_widget_id_fk" FOREIGN KEY ("widget_id") REFERENCES "public"."widget"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_due_idx" ON "schedule" USING btree ("paused","next_run_at");