ALTER TABLE "dashboard" ADD COLUMN "tabs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "widget" ADD COLUMN "tab" text;