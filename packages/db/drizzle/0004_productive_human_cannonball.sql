CREATE TABLE `session_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_events_session_seq_unique` ON `session_events` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_events_session_id_idx` ON `session_events` (`session_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`definition_id` text NOT NULL,
	`project_id` text NOT NULL,
	`bootstrap_json` text NOT NULL,
	`web_editor_json` text NOT NULL,
	`workspace_baseline_version` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_owner_user_id_idx` ON `sessions` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `workspace_files` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_files_session_path_unique` ON `workspace_files` (`session_id`,`path`);--> statement-breakpoint
CREATE INDEX `workspace_files_session_id_idx` ON `workspace_files` (`session_id`);