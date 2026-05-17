CREATE TABLE `task_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage` text NOT NULL,
	`storage_key` text NOT NULL,
	`sha256` text,
	`source` text DEFAULT 'human' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_task_attachments_user_task` ON `task_attachments` (`user_id`,`task_id`);--> statement-breakpoint
CREATE TABLE `agent_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`asked_by_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`prompt` text NOT NULL,
	`options` text,
	`multiple` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`answer` text,
	`answered_by_user_id` text,
	`created_at` integer NOT NULL,
	`answered_at` integer,
	`cancelled_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_agent_prompts_user_status` ON `agent_prompts` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_prompts_task_status` ON `agent_prompts` (`task_id`,`status`);
