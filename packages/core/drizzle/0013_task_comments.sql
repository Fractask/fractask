CREATE TABLE `task_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`body` text NOT NULL,
	`source` text DEFAULT 'human' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_task_comments_task_created` ON `task_comments` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_task_comments_user_task` ON `task_comments` (`user_id`,`task_id`);
