CREATE TABLE `usage_settlements` (
	`run_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`usage_event_id` text NOT NULL,
	`reserved_credits` integer NOT NULL,
	`final_credits` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `usage_events` ADD `metering` text DEFAULT 'actual' NOT NULL;