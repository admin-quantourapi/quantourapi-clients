CREATE TABLE `client_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`chat_id` text,
	`meta` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `settings` DROP COLUMN `total_capital`;--> statement-breakpoint
ALTER TABLE `settings` DROP COLUMN `available_cash`;--> statement-breakpoint
ALTER TABLE `settings` DROP COLUMN `max_risk_per_trade`;--> statement-breakpoint
ALTER TABLE `user_budgets` DROP COLUMN `available_cash`;