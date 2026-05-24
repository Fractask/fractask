ALTER TABLE `brain_notes` RENAME COLUMN `entity_id` TO `scope_task_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_brain_notes_user_entity`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_brain_notes_entity_parent`;
--> statement-breakpoint
CREATE INDEX `idx_brain_notes_user_scope` ON `brain_notes` (`user_id`,`scope_task_id`);
--> statement-breakpoint
CREATE INDEX `idx_brain_notes_scope_parent` ON `brain_notes` (`scope_task_id`,`parent_note_id`);
