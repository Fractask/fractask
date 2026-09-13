CREATE TABLE `billing_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`stripe_customer_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer NOT NULL,
	`stripe_session_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_ledger_stripe_session_id_unique` ON `usage_ledger` (`stripe_session_id`);
--> statement-breakpoint
CREATE INDEX `idx_usage_ledger_user_created` ON `usage_ledger` (`user_id`,`created_at`);
