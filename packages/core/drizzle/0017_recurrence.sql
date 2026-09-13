ALTER TABLE `tasks` ADD `recurrence_mode` text DEFAULT 'checkbox' NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `occurrence_date` integer;
--> statement-breakpoint
CREATE TABLE `task_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`completed_by_user_id` text NOT NULL,
	`occurrence_at` integer,
	`completed_at` integer NOT NULL,
	`source` text DEFAULT 'human' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_task_completions_task_completed` ON `task_completions` (`task_id`,`completed_at`);
--> statement-breakpoint
CREATE INDEX `idx_task_completions_by_completed` ON `task_completions` (`completed_by_user_id`,`completed_at`);
