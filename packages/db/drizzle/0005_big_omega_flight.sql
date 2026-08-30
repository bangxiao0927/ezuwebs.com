CREATE TABLE `workspace_baselines` (
	`version` text PRIMARY KEY NOT NULL,
	`files_json` text NOT NULL,
	`created_at` integer NOT NULL
);
