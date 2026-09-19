CREATE TABLE `command_metrics` (
	`command` text PRIMARY KEY NOT NULL,
	`avg_duration_ms` integer DEFAULT 0 NOT NULL,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `custom_scenarios` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`curve` text NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `notification_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`summary` text NOT NULL,
	`full_text` text NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
ALTER TABLE `settings` ADD `is_heartbeat_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `user_email` text;