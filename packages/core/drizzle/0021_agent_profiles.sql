CREATE TABLE `agent_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`group_name` text NOT NULL,
	`role_line` text NOT NULL,
	`reports_to` text,
	`charter_task_id` text,
	`sub_agents` integer DEFAULT 0 NOT NULL,
	`box` text,
	`brain_scope_task_ids` text,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_profiles_group_sort` ON `agent_profiles` (`group_name`,`sort`);
