CREATE TABLE "definition" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"body" jsonb NOT NULL,
	"status" text NOT NULL,
	"confidence" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"owner_id" text,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"check_number" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "definition_change" (
	"id" text PRIMARY KEY NOT NULL,
	"definition_id" text NOT NULL,
	"proposed_by" text NOT NULL,
	"origin" text NOT NULL,
	"request" text NOT NULL,
	"new_body" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "definition_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"definition_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event" text NOT NULL,
	"detail" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"topic" text NOT NULL,
	"prompt" text NOT NULL,
	"options" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"rank" integer NOT NULL,
	"at_setup" boolean NOT NULL,
	"assignee_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"answer" jsonb,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"started_by" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"result" jsonb,
	"stats" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_credential" (
	"source_id" text NOT NULL,
	"user_id" text NOT NULL,
	"username" text NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_member" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"team" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "definition" ADD CONSTRAINT "definition_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "definition" ADD CONSTRAINT "definition_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "definition" ADD CONSTRAINT "definition_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "definition" ADD CONSTRAINT "definition_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "definition_change" ADD CONSTRAINT "definition_change_definition_id_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "definition_event" ADD CONSTRAINT "definition_event_definition_id_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_answered_by_user_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan" ADD CONSTRAINT "scan_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_credential" ADD CONSTRAINT "source_credential_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_credential" ADD CONSTRAINT "source_credential_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "definition_name_idx" ON "definition" USING btree ("source_id","kind","name");--> statement-breakpoint
CREATE INDEX "definition_workspace_idx" ON "definition" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "definition_change_idx" ON "definition_change" USING btree ("definition_id","status");--> statement-breakpoint
CREATE INDEX "definition_event_idx" ON "definition_event" USING btree ("definition_id");--> statement-breakpoint
CREATE INDEX "question_source_idx" ON "question" USING btree ("source_id","status","rank");--> statement-breakpoint
CREATE INDEX "scan_source_idx" ON "scan" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_workspace_name_idx" ON "source" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "source_credential_idx" ON "source_credential" USING btree ("source_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_member_idx" ON "workspace_member" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_member_user_idx" ON "workspace_member" USING btree ("user_id");