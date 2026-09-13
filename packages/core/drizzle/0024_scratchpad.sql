CREATE TABLE `scratch_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`filed_task_id` text,
	`filed_by` text,
	`filed_note` text,
	`filed_at` integer,
	`source` text DEFAULT 'human' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scratch_user_status` ON `scratch_entries` (`user_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_scratch_status_created` ON `scratch_entries` (`status`,`created_at`);
