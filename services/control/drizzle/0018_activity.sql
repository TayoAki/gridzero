CREATE TABLE "activity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"owner_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ms" integer
);
--> statement-breakpoint
CREATE TABLE "announcement" (
	"id" text PRIMARY KEY NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" text NOT NULL,
	"label" text NOT NULL,
	"message" text NOT NULL,
	"effective_on" text,
	"told" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_object_idx" ON "activity" USING btree ("object_kind","object_id","at");--> statement-breakpoint
CREATE INDEX "activity_owner_idx" ON "activity" USING btree ("owner_id","at");--> statement-breakpoint
CREATE INDEX "activity_user_idx" ON "activity" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "announcement_object_idx" ON "announcement" USING btree ("object_kind","object_id");