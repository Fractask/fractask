CREATE TABLE `verikal_leads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`role` text,
	`company_name` text,
	`company_website` text,
	`what_they_do` text,
	`revenue_band` text,
	`pain_points` text,
	`tools_in_use` text,
	`qualified` integer,
	`qualification_reason` text,
	`transcript_url` text,
	`captured_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_verikal_leads_user_session` ON `verikal_leads` (`user_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `idx_verikal_leads_user_qualified` ON `verikal_leads` (`user_id`,`qualified`);--> statement-breakpoint
CREATE INDEX `idx_verikal_leads_user_captured` ON `verikal_leads` (`user_id`,`captured_at`);