CREATE TABLE IF NOT EXISTS "feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"player_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"table_id" text NOT NULL,
	"table_name" text DEFAULT '' NOT NULL,
	"mode" text NOT NULL,
	"game" text DEFAULT '' NOT NULL,
	"hand_number" integer DEFAULT 0 NOT NULL,
	"seated" boolean DEFAULT false NOT NULL,
	"screen" text DEFAULT '' NOT NULL,
	"commit" text DEFAULT '' NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	CONSTRAINT "feedback_kind_check" CHECK ("feedback"."kind" in ('problem', 'idea', 'other'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback" ADD CONSTRAINT "feedback_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_created_at_idx" ON "feedback" USING btree ("created_at");