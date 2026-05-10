ALTER TABLE `users` ADD `kind` text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `endpoint` text;