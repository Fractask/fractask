ALTER TABLE `tasks` ADD `kind` text DEFAULT 'task' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `rules` text;--> statement-breakpoint
UPDATE `tasks` SET `kind` = 'project' WHERE `parent_id` IS NULL;--> statement-breakpoint
CREATE INDEX `idx_tasks_user_kind` ON `tasks` (`user_id`,`kind`);