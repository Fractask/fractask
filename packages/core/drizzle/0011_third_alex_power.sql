CREATE TABLE `book_signups` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`source` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_book_signups_email` ON `book_signups` (`email`);--> statement-breakpoint
CREATE INDEX `idx_book_signups_created` ON `book_signups` (`created_at`);