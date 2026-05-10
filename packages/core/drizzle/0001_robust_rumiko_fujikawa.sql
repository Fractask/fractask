CREATE TABLE `assignees` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`color` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assignees_user` ON `assignees` (`user_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tags_user_name` ON `tags` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `task_tags` (
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `tag_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_task_tags_user_task` ON `task_tags` (`user_id`,`task_id`);--> statement-breakpoint
CREATE INDEX `idx_task_tags_user_tag` ON `task_tags` (`user_id`,`tag_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `due_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `assignee_id` text;--> statement-breakpoint
CREATE INDEX `idx_tasks_user_due` ON `tasks` (`user_id`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_user_assignee` ON `tasks` (`user_id`,`assignee_id`);