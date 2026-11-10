CREATE TABLE "metric_model" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"parsed" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "metric_model" ADD CONSTRAINT "metric_model_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_model" ADD CONSTRAINT "metric_model_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "metric_model_owner_name_idx" ON "metric_model" USING btree ("owner_id","name");