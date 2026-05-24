CREATE TABLE `brain_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`entity_id` text,
	`parent_note_id` text,
	`title` text NOT NULL,
	`icon` text,
	`content_json` text DEFAULT '{"type":"doc","content":[]}' NOT NULL,
	`content_text` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'human' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_brain_notes_user_parent` ON `brain_notes` (`user_id`,`parent_note_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_notes_user_entity` ON `brain_notes` (`user_id`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_brain_notes_entity_parent` ON `brain_notes` (`entity_id`,`parent_note_id`);--> statement-breakpoint
DROP TABLE `context_docs`;--> statement-breakpoint
CREATE TABLE `__new_task_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text,
	`brain_note_id` text,
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
INSERT INTO `__new_task_attachments` (`id`, `user_id`, `task_id`, `brain_note_id`, `filename`, `mime_type`, `size_bytes`, `storage`, `storage_key`, `sha256`, `source`, `created_at`) SELECT `id`, `user_id`, `task_id`, NULL, `filename`, `mime_type`, `size_bytes`, `storage`, `storage_key`, `sha256`, `source`, `created_at` FROM `task_attachments`;--> statement-breakpoint
DROP TABLE `task_attachments`;--> statement-breakpoint
ALTER TABLE `__new_task_attachments` RENAME TO `task_attachments`;--> statement-breakpoint
CREATE INDEX `idx_task_attachments_user_task` ON `task_attachments` (`user_id`,`task_id`);--> statement-breakpoint
CREATE INDEX `idx_task_attachments_user_note` ON `task_attachments` (`user_id`,`brain_note_id`);
