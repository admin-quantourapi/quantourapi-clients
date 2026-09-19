CREATE TABLE `custom_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`conditions` text NOT NULL,
	`action` text NOT NULL,
	`is_active` integer DEFAULT true,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `portfolio_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`portfolio_id` integer,
	`ticker` text NOT NULL,
	`added_at` integer,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `portfolios` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contour_api_key` text,
	`telegram_bot_token` text,
	`telegram_chat_id` text,
	`updated_at` integer
);
