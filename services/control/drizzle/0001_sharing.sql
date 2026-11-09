CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workbook_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event" text NOT NULL,
	"detail" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workbook_link_settings" (
	"workbook_id" text PRIMARY KEY NOT NULL,
	"link_access" text DEFAULT 'none' NOT NULL,
	"allow_copy" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workbook_share" (
	"id" text PRIMARY KEY NOT NULL,
	"workbook_id" text NOT NULL,
	"user_id" text,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"invite_token" text,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "workbook_share_invite_token_unique" UNIQUE("invite_token")
);
--> statement-breakpoint
ALTER TABLE "workbook_link_settings" ADD CONSTRAINT "workbook_link_settings_workbook_id_workbook_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workbook_share" ADD CONSTRAINT "workbook_share_workbook_id_workbook_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."workbook"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workbook_share" ADD CONSTRAINT "workbook_share_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workbook_share" ADD CONSTRAINT "workbook_share_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_workbook_idx" ON "audit_events" USING btree ("workbook_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workbook_share_email_idx" ON "workbook_share" USING btree ("workbook_id","email");--> statement-breakpoint
CREATE INDEX "workbook_share_user_idx" ON "workbook_share" USING btree ("user_id");