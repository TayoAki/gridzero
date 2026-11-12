CREATE TABLE "folder" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder_item" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"item_id" text NOT NULL,
	"folder_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_item" ADD CONSTRAINT "folder_item_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_item" ADD CONSTRAINT "folder_item_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folder_owner_name_idx" ON "folder" USING btree ("owner_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "folder_item_one_idx" ON "folder_item" USING btree ("user_id","kind","item_id");--> statement-breakpoint
CREATE INDEX "folder_item_folder_idx" ON "folder_item" USING btree ("folder_id");