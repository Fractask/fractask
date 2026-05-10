ALTER TABLE `tasks` ADD `reviewer_id` text;--> statement-breakpoint
CREATE INDEX `idx_tasks_user_reviewer` ON `tasks` (`user_id`,`reviewer_id`);