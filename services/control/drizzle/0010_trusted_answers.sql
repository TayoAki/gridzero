CREATE TABLE "trusted_answer" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"definition_id" text,
	"question" text NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"expected" text NOT NULL,
	"origin" text NOT NULL,
	"agent_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_status" text,
	"last_detail" text,
	"last_run_at" timestamp with time zone,
	"last_fingerprint" text
);
--> statement-breakpoint
ALTER TABLE "trusted_answer" ADD CONSTRAINT "trusted_answer_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_answer" ADD CONSTRAINT "trusted_answer_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_answer" ADD CONSTRAINT "trusted_answer_definition_id_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_answer_question_idx" ON "trusted_answer" USING btree ("source_id","tool","question");