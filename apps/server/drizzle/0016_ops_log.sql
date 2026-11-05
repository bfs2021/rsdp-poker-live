CREATE TABLE "ops_log" (
	"n" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	CONSTRAINT "ops_log_kind_check" CHECK ("ops_log"."kind" in ('server', 'browser', 'stop'))
);
--> statement-breakpoint
CREATE INDEX "ops_log_at_idx" ON "ops_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "hands_started_at_idx" ON "hands" USING btree ("started_at");