CREATE TABLE "intake_link" (
	"token" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "announcement" ADD COLUMN "told_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "announcement" ADD COLUMN "acked_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "work_item" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_item" ADD COLUMN "requester" text;--> statement-breakpoint
ALTER TABLE "work_item" ADD COLUMN "examples" jsonb;--> statement-breakpoint
ALTER TABLE "intake_link" ADD CONSTRAINT "intake_link_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;