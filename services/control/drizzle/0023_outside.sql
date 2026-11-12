CREATE TABLE "api_token" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_token_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "model_asset" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"workbook_id" text NOT NULL,
	"table_name" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_asset" ADD CONSTRAINT "model_asset_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_asset" ADD CONSTRAINT "model_asset_workbook_id_workbook_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_token_owner_idx" ON "api_token" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "model_asset_workbook_idx" ON "model_asset" USING btree ("workbook_id");