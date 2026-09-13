ALTER TABLE `agent_prompts` ADD `deck` text;--> statement-breakpoint
ALTER TABLE `agent_prompts` ADD `recommendation` text;--> statement-breakpoint
ALTER TABLE `agent_prompts` ADD `est_seconds` integer;--> statement-breakpoint
ALTER TABLE `agent_prompts` ADD `opened_at` integer;--> statement-breakpoint
ALTER TABLE `agent_prompts` ADD `answer_kind` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `goal_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `milestone_id` text;--> statement-breakpoint
CREATE TABLE `focus_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text,
	`prompt_id` text,
	`type` text NOT NULL,
	`seconds` integer,
	`meta` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_focus_events_user_created` ON `focus_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_focus_events_task_created` ON `focus_events` (`task_id`,`created_at`);
