-- Assignee/reviewer now seed the access CTE (see accessibleTasksCte in
-- access.ts). Those roots scan `assignee_id = ?` / `reviewer_id = ?` with no
-- user_id predicate, so idx_tasks_user_assignee / idx_tasks_user_reviewer
-- (which lead with user_id) cannot serve them.
CREATE INDEX `idx_tasks_assignee` ON `tasks` (`assignee_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_reviewer` ON `tasks` (`reviewer_id`);
